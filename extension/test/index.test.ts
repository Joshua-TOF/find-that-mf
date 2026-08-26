/**
 * Tests for the graph index: traversal, incremental refresh, and the "Mark as used" rules.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GraphIndex } from "../src/graph/index.js";
import type { GraphEdge, GraphNode } from "../src/graph/types.js";

function node(qualifiedName: string, overrides: Partial<GraphNode> = {}): GraphNode {
    const [moduleName = "", name = qualifiedName] = qualifiedName.split(".");
    return {
        qualifiedName,
        id: "id-" + qualifiedName,
        name,
        module: moduleName,
        type: "Microflows$Microflow",
        kind: "microflow",
        scanned: false,
        ...overrides
    };
}

function edge(from: string, to: string, viaElementId = "act-" + from + "-" + to): GraphEdge {
    return {
        from,
        to,
        viaElementId,
        viaType: "Microflows$MicroflowCall",
        path: "objectCollection.objects[0].action.microflowCall.microflow"
    };
}

/**
 * Chain SUB_A -> SUB_B -> SUB_C -> Billing.SUB_Invoice, with ACT_Entry also calling SUB_B, a page
 * calling ACT_Entry, and a scheduled event calling SUB_A.
 *
 * Every callable document has a caller except SUB_Orphan, so any *other* orphan the tests see is
 * a real finding rather than a gap in the fixture.
 */
function buildFixture(): GraphIndex {
    const index = new GraphIndex();
    index.setNodes([
        node("Sales.ACT_Entry"),
        node("Sales.SUB_A"),
        node("Sales.SUB_B"),
        node("Sales.SUB_C"),
        node("Sales.SUB_Orphan"),
        node("Sales.Order_Edit", { type: "Pages$Page", kind: "page" }),
        node("Sales.SE_Nightly", {
            type: "ScheduledEvents$ScheduledEvent",
            kind: "scheduledEvent"
        }),
        node("Billing.SUB_Invoice")
    ]);

    index.applyUnitScan("Sales.ACT_Entry", [edge("Sales.ACT_Entry", "Sales.SUB_B")], false);
    index.applyUnitScan("Sales.SUB_A", [edge("Sales.SUB_A", "Sales.SUB_B")], false);
    index.applyUnitScan("Sales.SUB_B", [edge("Sales.SUB_B", "Sales.SUB_C")], false);
    index.applyUnitScan("Sales.SUB_C", [edge("Sales.SUB_C", "Billing.SUB_Invoice")], false);
    index.applyUnitScan("Sales.SUB_Orphan", [], false);
    index.applyUnitScan("Sales.Order_Edit", [edge("Sales.Order_Edit", "Sales.ACT_Entry")], false);
    index.applyUnitScan("Sales.SE_Nightly", [edge("Sales.SE_Nightly", "Sales.SUB_A")], false);
    index.applyUnitScan("Billing.SUB_Invoice", [], false);
    return index;
}

describe("GraphIndex traversal", () => {
    let index: GraphIndex;
    beforeEach(() => {
        index = buildFixture();
    });

    it("reports both callers of a shared sub-microflow", () => {
        const callers = index.callersOf("Sales.SUB_B").map(e => e.from).sort();
        expect(callers).toEqual(["Sales.ACT_Entry", "Sales.SUB_A"]);
    });

    it("walks callers and callees to exhaustion, recording distance", () => {
        const ego = index.ego("Sales.SUB_B", false);

        const depths = new Map(ego?.nodes.map(entry => [entry.node.qualifiedName, entry.depth]));
        expect(depths.get("Sales.SUB_B")).toBe(0);
        expect(depths.get("Sales.SUB_A")).toBe(-1);
        expect(depths.get("Sales.ACT_Entry")).toBe(-1);
        // Order_Edit -> ACT_Entry -> SUB_B, so the page is two hops upstream.
        expect(depths.get("Sales.Order_Edit")).toBe(-2);
        expect(depths.get("Sales.SUB_C")).toBe(1);
        expect(depths.get("Billing.SUB_Invoice")).toBe(2);
        // Unbounded: the scheduled event is three hops up and must still be there.
        expect(depths.get("Sales.SE_Nightly")).toBe(-2);
    });

    it("terminates on a cycle", () => {
        const cyclic = new GraphIndex();
        cyclic.setNodes([node("M.X"), node("M.Y")]);
        cyclic.applyUnitScan("M.X", [edge("M.X", "M.Y")], false);
        cyclic.applyUnitScan("M.Y", [edge("M.Y", "M.X")], false);

        const ego = cyclic.ego("M.X", false);

        expect(ego?.nodes.map(entry => entry.node.qualifiedName).sort()).toEqual(["M.X", "M.Y"]);
        expect(ego?.edges).toHaveLength(2);
    });

    it("returns null for an unknown focus", () => {
        expect(index.ego("Nope.Missing", false)).toBeNull();
    });

    it("tags each edge with the side of the focus it was reached from", () => {
        // What the focus view colours by: green flows toward the focus, red away from it.
        const ego = index.ego("Sales.SUB_B", false);
        const sides = new Map(ego?.edges.map(e => [`${e.from}>${e.to}`, e.side]));

        expect(sides.get("Sales.SUB_A>Sales.SUB_B")).toBe("up");
        expect(sides.get("Sales.Order_Edit>Sales.ACT_Entry")).toBe("up");
        expect(sides.get("Sales.SUB_B>Sales.SUB_C")).toBe("down");
        expect(sides.get("Sales.SUB_C>Billing.SUB_Invoice")).toBe("down");
    });

    it("breaks a symmetric tie toward the caller side", () => {
        // In a two-node cycle each node is one hop away in both directions. Ties go upstream,
        // because "who calls this" is the question the view is answering.
        const cyclic = new GraphIndex();
        cyclic.setNodes([node("M.X"), node("M.Y")]);
        cyclic.applyUnitScan("M.X", [edge("M.X", "M.Y")], false);
        cyclic.applyUnitScan("M.Y", [edge("M.Y", "M.X")], false);

        const ego = cyclic.ego("M.X", false);

        expect(ego?.nodes.find(n => n.node.qualifiedName === "M.Y")?.depth).toBe(-1);
        expect(ego?.edges.every(e => e.side === "up")).toBe(true);
    });

    describe("a cycle around the focus", () => {
        /**
         * A -> A1 -> B, A -> A2 -> B, B -> C, C -> C1, C -> C2, C2 -> A.
         *
         * Focused on B, the cycle A -> A1 -> B -> C -> C2 -> A makes every node reachable from B in
         * both directions. Classifying by "which walk found it first" put C four hops *upstream* and
         * painted B's own outgoing edge as incoming; these tests pin the corrected behaviour.
         */
        function buildCycle(): GraphIndex {
            const index = new GraphIndex();
            index.setNodes([
                node("M.A"),
                node("M.A1"),
                node("M.A2"),
                node("M.B"),
                node("M.C"),
                node("M.C1"),
                node("M.C2")
            ]);
            index.applyUnitScan("M.A", [edge("M.A", "M.A1"), edge("M.A", "M.A2")], false);
            index.applyUnitScan("M.A1", [edge("M.A1", "M.B")], false);
            index.applyUnitScan("M.A2", [edge("M.A2", "M.B")], false);
            index.applyUnitScan("M.B", [edge("M.B", "M.C")], false);
            index.applyUnitScan("M.C", [edge("M.C", "M.C1"), edge("M.C", "M.C2")], false);
            index.applyUnitScan("M.C1", [], false);
            index.applyUnitScan("M.C2", [edge("M.C2", "M.A")], false);
            return index;
        }

        function sidesOf(index: GraphIndex): Map<string, string | undefined> {
            const ego = index.ego("M.B", false);
            return new Map(ego?.edges.map(e => [`${e.from}>${e.to}`, e.side]));
        }

        it("puts a direct callee one hop downstream, not four hops upstream via the cycle", () => {
            const ego = buildCycle().ego("M.B", false);
            const depths = new Map(ego?.nodes.map(n => [n.node.qualifiedName, n.depth]));

            expect(depths.get("M.B")).toBe(0);
            expect(depths.get("M.C")).toBe(1);
            expect(depths.get("M.C1")).toBe(2);
            expect(depths.get("M.C2")).toBe(2);
            expect(depths.get("M.A1")).toBe(-1);
            expect(depths.get("M.A2")).toBe(-1);
            expect(depths.get("M.A")).toBe(-2);
        });

        it("colours the focus's own outgoing edge as outgoing", () => {
            expect(sidesOf(buildCycle()).get("M.B>M.C")).toBe("down");
        });

        it("keeps following the outgoing chain away from the focus", () => {
            const sides = sidesOf(buildCycle());
            expect(sides.get("M.C>M.C1")).toBe("down");
            expect(sides.get("M.C>M.C2")).toBe("down");
        });

        it("turns the edge that closes the cycle back into an incoming one", () => {
            // C2 -> A heads back toward B by way of A1 and A2, so it reads as flowing in.
            expect(sidesOf(buildCycle()).get("M.C2>M.A")).toBe("up");
        });

        it("colours the caller chain as incoming", () => {
            const sides = sidesOf(buildCycle());
            expect(sides.get("M.A1>M.B")).toBe("up");
            expect(sides.get("M.A2>M.B")).toBe("up");
            expect(sides.get("M.A>M.A1")).toBe("up");
            expect(sides.get("M.A>M.A2")).toBe("up");
        });

        it("has no entry point, because the cycle gives every node a caller", () => {
            const ego = buildCycle().ego("M.B", false);
            const incoming = new Set(ego?.edges.map(e => e.to));
            const outgoing = new Set(ego?.edges.map(e => e.from));

            const names = ego?.nodes.map(n => n.node.qualifiedName) ?? [];
            expect(names.filter(name => !incoming.has(name))).toEqual([]);
            // C1 is the only dead end.
            expect(names.filter(name => !outgoing.has(name))).toEqual(["M.C1"]);
        });
    });

    it("keeps two call sites to the same target as distinct edges", () => {
        const twice = new GraphIndex();
        twice.setNodes([node("M.A"), node("M.B")]);
        twice.applyUnitScan(
            "M.A",
            [edge("M.A", "M.B", "act-1"), edge("M.A", "M.B", "act-2")],
            false
        );
        expect(twice.callersOf("M.B")).toHaveLength(2);
    });
});

describe('GraphIndex "Mark as used"', () => {
    it("flags an uncalled microflow as an orphan", () => {
        const index = buildFixture();
        expect(index.usageStateOf("Sales.SUB_Orphan")).toBe("orphan");
    });

    it("does not flag an uncalled microflow that is marked as used", () => {
        // The whole reason the flag exists: the caller is a Java action the model cannot see.
        // Warning here would send someone off to delete a microflow that is in use.
        const index = buildFixture();
        index.applyUnitScan("Sales.SUB_Orphan", [], true);

        expect(index.usageStateOf("Sales.SUB_Orphan")).toBe("markedAsUsed");
    });

    it("still reports marked-as-used when the microflow does have callers", () => {
        // The flag is a fact about the document, not only an excuse for having no callers.
        const index = buildFixture();
        index.applyUnitScan("Sales.SUB_B", [edge("Sales.SUB_B", "Sales.SUB_C")], true);

        expect(index.callersOf("Sales.SUB_B").length).toBeGreaterThan(0);
        expect(index.usageStateOf("Sales.SUB_B")).toBe("markedAsUsed");
    });

    it("never warns about a document the sweep has not reached", () => {
        const index = new GraphIndex();
        index.setNodes([node("M.Unscanned")]);
        expect(index.usageStateOf("M.Unscanned")).toBe("normal");
    });

    it("does not orphan-flag things that cannot be called", () => {
        const index = buildFixture();
        // The page calls things but nothing calls it; that is not a finding.
        expect(index.usageStateOf("Sales.Order_Edit")).toBe("normal");
    });

    it("splits the orphan report so a cleanup sweep cannot confuse the two", () => {
        const index = buildFixture();
        index.setNodes([...index.allNodes(), node("Sales.SUB_CalledFromJava")]);
        index.applyUnitScan("Sales.SUB_CalledFromJava", [], true);

        const report = index.orphanReport(true);

        // Both are uncalled. Only one is a cleanup candidate.
        expect(report.orphans.map(s => s.node.qualifiedName)).toEqual(["Sales.SUB_Orphan"]);
        expect(report.markedAsUsed.map(s => s.node.qualifiedName)).toEqual([
            "Sales.SUB_CalledFromJava"
        ]);
        expect(report.complete).toBe(true);
    });

    it("leaves a called-and-marked microflow out of the unused report entirely", () => {
        // It is badged in the tree, because the flag is worth seeing. But it is not unused, so it
        // belongs in neither list - listing it would pad the cleanup report with noise.
        const index = buildFixture();
        index.applyUnitScan("Billing.SUB_Invoice", [], true);

        const report = index.orphanReport(true);
        const listed = [...report.orphans, ...report.markedAsUsed].map(s => s.node.qualifiedName);

        expect(listed).not.toContain("Billing.SUB_Invoice");
        expect(index.usageStateOf("Billing.SUB_Invoice")).toBe("markedAsUsed");
    });

    it("carries the usage state onto ego nodes so badges cannot disagree with the report", () => {
        const index = buildFixture();
        index.applyUnitScan("Sales.SUB_Orphan", [], true);

        const ego = index.ego("Sales.SUB_Orphan", false);

        expect(ego?.nodes[0]?.usageState).toBe("markedAsUsed");
    });
});

describe("GraphIndex id lookup", () => {
    // Studio Pro identifies a right-clicked document by id, never by name, so "Show in Find that
    // MF" cannot focus anything without this.
    it("resolves a unit id to its document", () => {
        const index = buildFixture();
        const node = index.getNodeById("id-Sales.SUB_B");
        expect(node?.qualifiedName).toBe("Sales.SUB_B");
    });

    it("returns undefined for an id it has never seen", () => {
        expect(buildFixture().getNodeById("id-Nope.Missing")).toBeUndefined();
    });

    it("still resolves after a re-scan changed the document", () => {
        const index = buildFixture();
        index.applyUnitScan("Sales.SUB_B", [], true);
        expect(index.getNodeById("id-Sales.SUB_B")?.markedAsUsed).toBe(true);
    });

    it("forgets the id when the document is removed", () => {
        const index = buildFixture();
        index.removeNode("Sales.SUB_B");
        expect(index.getNodeById("id-Sales.SUB_B")).toBeUndefined();
    });

    it("rebuilds the lookup when the node set is replaced", () => {
        const index = buildFixture();
        index.setNodes([node("M.Only")]);
        expect(index.getNodeById("id-Sales.SUB_B")).toBeUndefined();
        expect(index.getNodeById("id-M.Only")?.qualifiedName).toBe("M.Only");
    });
});

describe("GraphIndex revision", () => {
    // The revision is what tells a UI its view is stale. Before it existed, editing a microflow
    // re-scanned the index correctly but nothing the pane could observe changed, so the graph kept
    // showing pre-edit callers until the user toggled modes.
    it("advances when a document is re-scanned", () => {
        const index = buildFixture();
        const before = index.revision;

        index.applyUnitScan("Sales.SUB_A", [edge("Sales.SUB_A", "Sales.SUB_C")], false);

        expect(index.revision).toBeGreaterThan(before);
    });

    it("advances even when the re-scan changes nothing observable", () => {
        // An edit that rewires an activity without changing which microflows are called still has
        // to invalidate the UI, because the *reason* it looks the same is not knowable up front.
        const index = buildFixture();
        const before = index.revision;

        index.applyUnitScan("Sales.SUB_A", [edge("Sales.SUB_A", "Sales.SUB_B")], false);

        expect(index.revision).toBeGreaterThan(before);
    });

    it("advances when a document is removed", () => {
        const index = buildFixture();
        const before = index.revision;
        index.removeNode("Sales.SUB_A");
        expect(index.revision).toBeGreaterThan(before);
    });

    it("advances when the node set is replaced", () => {
        const index = buildFixture();
        const before = index.revision;
        index.setNodes([node("M.Only")]);
        expect(index.revision).toBeGreaterThan(before);
    });

    it("never moves backwards", () => {
        const index = buildFixture();
        const seen = [index.revision];
        index.applyUnitScan("Sales.SUB_A", [], false);
        seen.push(index.revision);
        index.removeNode("Sales.SUB_C");
        seen.push(index.revision);

        for (let i = 1; i < seen.length; i++) {
            expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
        }
    });
});

describe("GraphIndex incremental refresh", () => {
    it("drops an edge that a rescan no longer finds", () => {
        const index = buildFixture();
        expect(index.callersOf("Sales.SUB_B").map(e => e.from)).toContain("Sales.SUB_A");

        // SUB_A no longer calls SUB_B.
        index.applyUnitScan("Sales.SUB_A", [], false);

        expect(index.callersOf("Sales.SUB_B").map(e => e.from)).not.toContain("Sales.SUB_A");
        expect(index.callersOf("Sales.SUB_B")).toHaveLength(1);
    });

    it("keeps the other callers when one is rescanned", () => {
        const index = buildFixture();
        index.applyUnitScan("Sales.SUB_A", [], false);
        expect(index.callersOf("Sales.SUB_B").map(e => e.from)).toEqual(["Sales.ACT_Entry"]);
    });

    it("turns a microflow into an orphan once its last caller stops calling it", () => {
        const index = buildFixture();
        index.applyUnitScan("Sales.SUB_B", [], false);
        index.applyUnitScan("Sales.SUB_A", [], false);
        index.applyUnitScan("Sales.ACT_Entry", [], false);

        expect(index.usageStateOf("Sales.SUB_B")).toBe("orphan");
    });

    it("forgets a removed document and its edges", () => {
        const index = buildFixture();
        index.removeNode("Sales.SUB_A");

        expect(index.getNode("Sales.SUB_A")).toBeUndefined();
        expect(index.callersOf("Sales.SUB_B").map(e => e.from)).toEqual(["Sales.ACT_Entry"]);
    });
});

describe("GraphIndex module summaries", () => {
    it("lists every module with its document count", () => {
        const index = buildFixture();
        const summaries = index.moduleSummaries();

        expect(summaries.map(m => m.name)).toEqual(["Billing", "Sales"]);
        expect(summaries.find(m => m.name === "Billing")?.nodeCount).toBe(1);
    });

    it("counts orphans per module, excluding marked-as-used", () => {
        const index = buildFixture();
        expect(index.moduleSummaries().find(m => m.name === "Sales")?.orphanCount).toBe(1);

        index.applyUnitScan("Sales.SUB_Orphan", [], true);
        expect(index.moduleSummaries().find(m => m.name === "Sales")?.orphanCount).toBe(0);
    });
});

describe("GraphIndex whole-app graph", () => {
    it("returns one flat graph with no module nesting", () => {
        const index = buildFixture();
        const app = index.appGraph([]);

        expect(app.nodes.map(s => s.node.qualifiedName)).toContain("Billing.SUB_Invoice");
        expect(app.edges.some(e => e.from === "Sales.SUB_C" && e.to === "Billing.SUB_Invoice")).toBe(
            true
        );
        expect(app.hiddenModules).toEqual([]);
    });

    it("drops a hidden module and every edge that touched it", () => {
        const index = buildFixture();
        const app = index.appGraph(["Billing"]);

        expect(app.nodes.map(s => s.node.qualifiedName)).not.toContain("Billing.SUB_Invoice");
        expect(app.edges.some(e => e.to === "Billing.SUB_Invoice")).toBe(false);
        expect(app.hiddenModules).toEqual(["Billing"]);
    });

    it("omits unconnected non-callable documents but reports how many", () => {
        // A stock app carries dozens of layouts that reference nothing and are referenced by
        // nothing. Drawing them turns the view into a field of unconnected rectangles.
        const index = buildFixture();
        index.setNodes([
            ...index.allNodes(),
            node("Sales.Orphan_Layout", { type: "Pages$Layout", kind: "layout" })
        ]);
        index.applyUnitScan("Sales.Orphan_Layout", [], undefined);

        const app = index.appGraph([]);

        expect(app.nodes.map(s => s.node.qualifiedName)).not.toContain("Sales.Orphan_Layout");
        expect(app.hiddenIsolated).toBe(1);
    });

    it("keeps an uncalled microflow even though it is unconnected", () => {
        // The interesting case, not noise: an orphan microflow is exactly what someone opens this
        // view to find.
        const index = buildFixture();
        const app = index.appGraph([]);

        expect(app.nodes.map(s => s.node.qualifiedName)).toContain("Sales.SUB_Orphan");
    });
});

describe("GraphIndex search", () => {
    it("ranks an exact name above a substring match", () => {
        const index = new GraphIndex();
        index.setNodes([node("Sales.SUB_ACT_OrderHelper"), node("Sales.ACT_Order")]);

        const hits = index.search("ACT_Order", 10);

        expect(hits[0]?.node.qualifiedName).toBe("Sales.ACT_Order");
    });

    it("ranks callable documents above pages", () => {
        const index = new GraphIndex();
        index.setNodes([
            node("Sales.Order_Edit", { type: "Pages$Page", kind: "page", name: "Order_Edit" }),
            node("Sales.Order_Process")
        ]);

        const hits = index.search("Order", 10);

        expect(hits[0]?.node.kind).toBe("microflow");
    });

    it("returns nothing for an empty query", () => {
        expect(buildFixture().search("   ", 10)).toEqual([]);
    });
});
