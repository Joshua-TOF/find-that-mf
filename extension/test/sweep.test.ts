/**
 * Tests for the unit sweep.
 *
 * The fake source enforces the real API's contract rather than being permissive: `loadAll`'s
 * `maxUnitsToLoad` defaults to 10 and it **throws** when the filter matches more instead of
 * truncating. That is the whole reason the sweep batches, so the fake has to be strict enough to
 * catch a regression that stops batching.
 */

import { describe, expect, it, vi } from "vitest";

import { readNodes, scanUnits, type UnitInfoLike, type UnitSource } from "../src/graph/scan.js";
import type { GraphEdge, GraphNode } from "../src/graph/types.js";

interface FakeUnit extends Record<string, unknown> {
    $ID: string;
    $Type: string;
}

class FakeSource implements UnitSource<unknown> {
    readonly loadCalls: number[] = [];

    constructor(
        private readonly infos: UnitInfoLike[],
        private readonly bodies: Map<string, FakeUnit>
    ) {}

    async getUnitsInfo(): Promise<ReadonlyArray<Readonly<UnitInfoLike>>> {
        return this.infos;
    }

    async loadAll(filter: (u: UnitInfoLike) => boolean, maxUnitsToLoad = 10): Promise<unknown[]> {
        const matched = this.infos.filter(filter);
        if (matched.length > maxUnitsToLoad) {
            // Mirrors the real API: it throws rather than returning the first `maxUnitsToLoad`.
            throw new Error(
                `Cannot load ${matched.length} units, maxUnitsToLoad is ${maxUnitsToLoad}`
            );
        }
        this.loadCalls.push(matched.length);
        return matched.map(info => this.bodies.get(info.$ID)).filter(unit => unit !== undefined);
    }
}

function buildSource(count: number, markUsedAt = new Set<number>()): FakeSource {
    const infos: UnitInfoLike[] = [];
    const bodies = new Map<string, FakeUnit>();

    for (let i = 0; i < count; i++) {
        const id = "mf-" + i;
        infos.push({ $ID: id, $Type: "Microflows$Microflow", moduleName: "Sales", name: "SUB_" + i });
        bodies.set(id, {
            $ID: id,
            $Type: "Microflows$Microflow",
            markAsUsed: markUsedAt.has(i),
            objectCollection: {
                $Type: "Microflows$MicroflowObjectCollection",
                objects:
                    i + 1 < count
                        ? [
                              {
                                  $Type: "Microflows$ActionActivity",
                                  $ID: "act-" + i,
                                  relativeMiddlePoint: { x: 0, y: 0 },
                                  action: {
                                      $Type: "Microflows$MicroflowCallAction",
                                      microflowCall: {
                                          $Type: "Microflows$MicroflowCall",
                                          microflow: "Sales.SUB_" + (i + 1)
                                      }
                                  }
                              }
                          ]
                        : []
            }
        });
    }

    return new FakeSource(infos, bodies);
}

describe("readNodes", () => {
    it("builds qualified names and skips the System module", () => {
        const source = new FakeSource(
            [
                { $ID: "a", $Type: "Microflows$Microflow", moduleName: "Sales", name: "SUB_A" },
                { $ID: "b", $Type: "Microflows$Microflow", moduleName: "System", name: "Internal" },
                // A document with no name cannot be referred to, so it cannot be a graph node.
                { $ID: "c", $Type: "Microflows$Microflow", moduleName: "Sales" }
            ],
            new Map()
        );

        return readNodes({ "Microflows$Microflow": source }).then(nodes => {
            expect(nodes.map(n => n.qualifiedName)).toEqual(["Sales.SUB_A"]);
            expect(nodes[0]?.kind).toBe("microflow");
            expect(nodes[0]?.scanned).toBe(false);
        });
    });

    it("names the failing document type when getUnitsInfo throws", async () => {
        // The model API's own errors are unattributed ("Response code: 400"), so the scan has to
        // say which call produced it or debugging is guesswork.
        const failing: UnitSource<unknown> = {
            getUnitsInfo: () => Promise.reject(new Error("Response code: 400")),
            loadAll: () => Promise.resolve([])
        };

        await expect(readNodes({ "Pages$Page": failing })).rejects.toThrow(
            /getUnitsInfo failed for Pages\$Page/
        );
    });
});

describe("scanUnits", () => {
    async function sweep(source: FakeSource, nodes: readonly GraphNode[]) {
        const edges: GraphEdge[] = [];
        const marks = new Map<string, boolean | undefined>();
        const docs = new Map<string, string | undefined>();
        const progress: number[] = [];

        await scanUnits(
            { "Microflows$Microflow": source },
            nodes,
            name => nodes.some(node => node.qualifiedName === name),
            (qualifiedName, unitEdges, facts) => {
                edges.push(...unitEdges);
                marks.set(qualifiedName, facts.markedAsUsed);
                docs.set(qualifiedName, facts.documentation);
            },
            done => progress.push(done)
        );

        return { edges, marks, docs, progress };
    }

    it("never asks loadAll for more units than it allows", async () => {
        const source = buildSource(30);
        const nodes = await readNodes({ "Microflows$Microflow": source });

        // Would throw inside the fake if the sweep stopped batching.
        const { edges } = await sweep(source, nodes);

        expect(source.loadCalls.every(size => size <= 10)).toBe(true);
        expect(edges).toHaveLength(29);
    });

    it("streams each unit's result as it goes rather than at the end", async () => {
        const source = buildSource(20);
        const nodes = await readNodes({ "Microflows$Microflow": source });

        const seenAt: number[] = [];
        let sunk = 0;
        await scanUnits(
            { "Microflows$Microflow": source },
            nodes,
            () => true,
            () => {
                sunk++;
            },
            done => seenAt.push(sunk === 0 ? -1 : done)
        );

        // If results only arrived at the end, the first progress callback would have fired with
        // nothing sunk yet.
        expect(seenAt[0]).toBeGreaterThan(0);
        expect(sunk).toBe(20);
    });

    it("reports progress monotonically up to the total", async () => {
        const source = buildSource(20);
        const nodes = await readNodes({ "Microflows$Microflow": source });

        const { progress } = await sweep(source, nodes);

        expect(progress[progress.length - 1]).toBe(20);
        for (let i = 1; i < progress.length; i++) {
            expect(progress[i]!).toBeGreaterThan(progress[i - 1]!);
        }
    });

    it("carries markAsUsed off the unit body", async () => {
        // It is not on UnitInfo, so the sweep is the only place it can come from.
        const source = buildSource(12, new Set([3, 7]));
        const nodes = await readNodes({ "Microflows$Microflow": source });

        const { marks } = await sweep(source, nodes);

        expect(marks.get("Sales.SUB_3")).toBe(true);
        expect(marks.get("Sales.SUB_7")).toBe(true);
        expect(marks.get("Sales.SUB_0")).toBe(false);
    });

    it("skips a failing batch instead of losing the whole sweep", async () => {
        const source = buildSource(20);
        const nodes = await readNodes({ "Microflows$Microflow": source });

        const original = source.loadAll.bind(source);
        let call = 0;
        const flaky = vi.spyOn(source, "loadAll").mockImplementation(async (filter, max) => {
            call++;
            if (call === 2) throw new Error("Backend failed to handle the request.");
            return original(filter, max);
        });

        const { marks, progress } = await sweep(source, nodes);

        // One batch of 8 lost, the rest kept, and progress still reaches the total so the bar
        // cannot stall at 60% forever.
        expect(marks.size).toBe(12);
        expect(progress[progress.length - 1]).toBe(20);
        flaky.mockRestore();
    });

    it("stops early when asked", async () => {
        const source = buildSource(40);
        const nodes = await readNodes({ "Microflows$Microflow": source });

        let sunk = 0;
        await scanUnits(
            { "Microflows$Microflow": source },
            nodes,
            () => true,
            () => {
                sunk++;
            },
            undefined,
            () => sunk >= 8
        );

        expect(sunk).toBeLessThan(40);
    });

    it("ignores a document type with no source", async () => {
        const nodes: GraphNode[] = [
            {
                qualifiedName: "Sales.Order_Edit",
                id: "p1",
                name: "Order_Edit",
                module: "Sales",
                type: "Pages$Page",
                kind: "page",
                scanned: false
            }
        ];

        const marks = new Map<string, boolean | undefined>();
        await scanUnits({}, nodes, () => true, (name, _e, facts) =>
            marks.set(name, facts.markedAsUsed)
        );

        expect(marks.size).toBe(0);
    });
});
