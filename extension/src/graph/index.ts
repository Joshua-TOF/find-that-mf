/**
 * The in-memory graph: nodes, edges, and the queries the UI asks of them.
 *
 * Owned by the `main` entry point and never serialised wholesale — the UI asks for the slice it
 * needs (an ego graph, a module map, a search hit list) and gets plain data back over
 * `ui.messagePassing`.
 */

import type {
    AppGraph,
    EgoEdge,
    EgoGraph,
    EgoNode,
    GraphEdge,
    GraphNode,
    ModuleSummary,
    NodeSummary,
    OrphanReport,
    UsageState
} from "./types.js";

/**
 * Separator for composite map keys. NUL rather than a space or a dot, because both of those are
 * legal characters inside the qualified names and element ids being joined.
 */
const KEY_SEP = "\u0000";

/** Node kinds that can be *called*, and therefore can meaningfully be orphaned. */
const CALLABLE_KINDS = new Set(["microflow", "nanoflow", "rule"]);

export class GraphIndex {
    private readonly nodes = new Map<string, GraphNode>();
    /** Tail → edges leaving it. */
    private readonly outgoing = new Map<string, GraphEdge[]>();
    /** Head → edges arriving at it. This is the index the expensive sweep exists to build. */
    private readonly incoming = new Map<string, GraphEdge[]>();
    /** Dedupe key → true. The model has no edge identity, so we synthesise one. */
    private readonly edgeKeys = new Set<string>();
    /**
     * Unit `$ID` → qualified name.
     *
     * Studio Pro's context menus and change events identify a document by id, not by name, so a
     * name-keyed index alone cannot answer "which document was right-clicked".
     */
    private readonly byId = new Map<string, string>();
    /** Incremented by every mutation, so callers can tell whether their view is stale. */
    private version = 0;

    /** Monotonic content version. Changes whenever nodes or edges change. */
    get revision(): number {
        return this.version;
    }

    /** Replaces the node set, preserving edges. Called after `readNodes`. */
    setNodes(nodes: readonly GraphNode[]): void {
        this.nodes.clear();
        this.byId.clear();
        for (const node of nodes) {
            this.nodes.set(node.qualifiedName, node);
            this.byId.set(node.id, node.qualifiedName);
        }
        this.version++;
    }

    getNode(qualifiedName: string): GraphNode | undefined {
        return this.nodes.get(qualifiedName);
    }

    /** Resolves the unit id Studio Pro passes around into a document we know about. */
    getNodeById(id: string): GraphNode | undefined {
        const qualifiedName = this.byId.get(id);
        return qualifiedName === undefined ? undefined : this.nodes.get(qualifiedName);
    }

    has(qualifiedName: string): boolean {
        return this.nodes.has(qualifiedName);
    }

    get nodeCount(): number {
        return this.nodes.size;
    }

    get edgeCount(): number {
        return this.edgeKeys.size;
    }

    allNodes(): readonly GraphNode[] {
        return [...this.nodes.values()];
    }

    /**
     * Records what a sweep found for one document: its outgoing edges, and whether its author
     * ticked "Mark as used".
     *
     * Replaces rather than merges, so re-scanning a changed document cannot leave stale edges
     * behind — the incremental-refresh path depends on that.
     */
    applyUnitScan(
        qualifiedName: string,
        edges: readonly GraphEdge[],
        markedAsUsed: boolean | undefined,
        documentation?: string
    ): void {
        this.clearOutgoing(qualifiedName);

        const node = this.nodes.get(qualifiedName);
        if (node !== undefined) {
            this.nodes.set(qualifiedName, {
                ...node,
                markedAsUsed,
                documentation,
                scanned: true
            });
        }

        for (const edge of edges) {
            const key = edgeKey(edge);
            if (this.edgeKeys.has(key)) continue;
            this.edgeKeys.add(key);
            push(this.outgoing, edge.from, edge);
            push(this.incoming, edge.to, edge);
        }

        this.version++;
    }

    /** Drops every edge leaving a document, so a rescan of it starts clean. */
    private clearOutgoing(qualifiedName: string): void {
        const existing = this.outgoing.get(qualifiedName);
        if (existing === undefined) return;

        for (const edge of existing) {
            this.edgeKeys.delete(edgeKey(edge));
            const heads = this.incoming.get(edge.to);
            if (heads === undefined) continue;
            const remaining = heads.filter(candidate => candidate.from !== qualifiedName);
            if (remaining.length === 0) this.incoming.delete(edge.to);
            else this.incoming.set(edge.to, remaining);
        }

        this.outgoing.delete(qualifiedName);
    }

    /** Forgets a document entirely — deleted, or renamed away. */
    removeNode(qualifiedName: string): void {
        const node = this.nodes.get(qualifiedName);
        if (node !== undefined) this.byId.delete(node.id);
        this.clearOutgoing(qualifiedName);
        this.incoming.delete(qualifiedName);
        this.nodes.delete(qualifiedName);
        this.version++;
    }

    callersOf(qualifiedName: string): readonly GraphEdge[] {
        return this.incoming.get(qualifiedName) ?? [];
    }

    calleesOf(qualifiedName: string): readonly GraphEdge[] {
        return this.outgoing.get(qualifiedName) ?? [];
    }

    /* ---------------------------------------------------------------------- */
    /* Usage state — the "Mark as used" story                                 */
    /* ---------------------------------------------------------------------- */

    /**
     * Whether a document should be badged, and how.
     *
     * Mendix ships a per-document "Mark as used" checkbox precisely because a static call graph
     * cannot see every caller: `Core.execute(...)` from a Java action, reflection, an external
     * trigger. Developers tick it so colleagues do not "clean up" something that is genuinely in
     * use. A tool that ignored it would confidently report a flagged microflow as dead — which is
     * worse than not reporting at all, because someone would act on it.
     *
     * So `markedAsUsed` wins over the orphan warning, and is surfaced even when callers *are*
     * found: the flag is a fact about the document, not merely an excuse for having no callers.
     */
    usageStateOf(qualifiedName: string): UsageState {
        const node = this.nodes.get(qualifiedName);
        if (node === undefined) return "normal";
        if (node.markedAsUsed === true) return "markedAsUsed";
        if (!CALLABLE_KINDS.has(node.kind)) return "normal";
        // Not yet scanned means "unknown", not "orphaned" — never warn on missing data.
        if (!node.scanned) return "normal";
        return this.callersOf(qualifiedName).length === 0 ? "orphan" : "normal";
    }

    /**
     * Uncalled documents, split so a cleanup sweep never has to guess which list it is looking at.
     *
     * @param complete False while the sweep is still running; the lists are provisional until then.
     */
    orphanReport(complete: boolean): OrphanReport {
        const orphans: NodeSummary[] = [];
        const markedAsUsed: NodeSummary[] = [];

        for (const node of this.nodes.values()) {
            if (!CALLABLE_KINDS.has(node.kind)) continue;
            if (!node.scanned) continue;
            if (this.callersOf(node.qualifiedName).length > 0) continue;

            if (node.markedAsUsed === true) markedAsUsed.push(this.summarise(node));
            else orphans.push(this.summarise(node));
        }

        orphans.sort(bySummaryName);
        markedAsUsed.sort(bySummaryName);
        return { orphans, markedAsUsed, complete };
    }

    /** Pairs a node with the derived facts the UI would otherwise have to recompute. */
    summarise(node: GraphNode): NodeSummary {
        return {
            node,
            usageState: this.usageStateOf(node.qualifiedName),
            callerCount: this.callersOf(node.qualifiedName).length
        };
    }

    /* ---------------------------------------------------------------------- */
    /* Queries                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * Ranked prefix/substring search over qualified names.
     *
     * Exact name match ranks above a name prefix, which ranks above a substring anywhere — so
     * typing `ACT_Order` surfaces `Sales.ACT_Order` before `Sales.SUB_ACT_OrderHelper`.
     */
    search(query: string, limit: number): readonly NodeSummary[] {
        const needle = query.trim().toLowerCase();
        if (needle === "") return [];

        const scored: { node: GraphNode; score: number }[] = [];
        for (const node of this.nodes.values()) {
            const name = node.name.toLowerCase();
            const qualified = node.qualifiedName.toLowerCase();

            let score: number;
            if (name === needle) score = 0;
            else if (name.startsWith(needle)) score = 1;
            else if (qualified.startsWith(needle)) score = 2;
            else if (name.includes(needle)) score = 3;
            else if (qualified.includes(needle)) score = 4;
            else continue;

            // Callable documents are what people search for; pages and mappings are context.
            if (!CALLABLE_KINDS.has(node.kind)) score += 10;
            scored.push({ node, score });
        }

        scored.sort((a, b) => a.score - b.score || byQualifiedName(a.node, b.node));
        return scored.slice(0, limit).map(entry => this.summarise(entry.node));
    }

    /**
     * Everything that can reach the focus, and everything it can reach.
     *
     * Unbounded in both directions. Because the walk has no depth limit, a node with no incoming
     * edge in this graph genuinely has no caller anywhere in the scanned model, which is what lets
     * the view colour entry and exit points honestly rather than colouring the edge of an arbitrary
     * depth cut.
     *
     * **Depth is the shorter of the two distances, not whichever walk arrived first.** In a cycle
     * every node is reachable both ways, so "first to arrive" is decided by traversal order rather
     * than by the graph: with `A → A1 → B → C → C2 → A` focused on `B`, the caller walk comes back
     * round to `C` after four hops and would claim it as *upstream* — when `C` is `B`'s direct
     * callee, one hop downstream. Taking the smaller absolute distance gets that right; ties go to
     * the caller side, since "who calls this" is the question being asked.
     *
     * @param callersPartial Passed through so the UI can say "still indexing" rather than implying an
     *                       empty caller list means nothing calls this.
     */
    ego(focus: string, callersPartial: boolean): EgoGraph | null {
        const root = this.nodes.get(focus);
        if (root === undefined) return null;

        const edges = new Map<string, GraphEdge>();
        const up = this.reach(focus, -1, edges);
        const down = this.reach(focus, 1, edges);

        const depths = new Map<string, number>([[focus, 0]]);
        for (const name of new Set([...up.keys(), ...down.keys()])) {
            const toFocus = up.get(name) ?? Infinity;
            const fromFocus = down.get(name) ?? Infinity;
            depths.set(name, toFocus <= fromFocus ? -toFocus : fromFocus);
        }
        depths.set(focus, 0);

        const nodes: EgoNode[] = [];
        for (const [qualifiedName, depth] of depths) {
            const node = this.nodes.get(qualifiedName);
            if (node !== undefined) nodes.push({ ...this.summarise(node), depth });
        }
        nodes.sort((a, b) => a.depth - b.depth || byQualifiedName(a.node, b.node));

        /**
         * Which way an edge runs relative to the focus, from the side its *target* lands on.
         *
         * One rule, no special cases: an edge whose target is the focus or on the caller side is
         * heading toward the focus; anything else is heading away. Deriving this from the settled
         * depths rather than from which walk found the edge is what makes `B → C` read as outgoing
         * even though the cycle also makes `C` an ancestor of `B`.
         */
        const sideOf = (target: string): "up" | "down" =>
            (depths.get(target) ?? 0) > 0 ? "down" : "up";

        const tagged: EgoEdge[] = [...edges.values()].map(edge => ({
            ...edge,
            side: sideOf(edge.to)
        }));

        return {
            focus,
            modules: this.moduleNames(),
            nodes,
            edges: tagged,
            callersPartial
        };
    }

    /**
     * Breadth-first distance from `start` in one direction, collecting every edge on the way.
     *
     * @param direction -1 follows incoming edges (callers), +1 follows outgoing edges (callees).
     * @param edges     Accumulator shared by both directions; an edge found twice is stored once.
     * @returns Hop count per reachable node, excluding `start` itself.
     */
    private reach(
        start: string,
        direction: -1 | 1,
        edges: Map<string, GraphEdge>
    ): Map<string, number> {
        const distance = new Map<string, number>();
        const visited = new Set([start]);
        let frontier = [start];
        let hops = 0;

        while (frontier.length > 0) {
            hops++;
            const next: string[] = [];

            for (const current of frontier) {
                const step = direction === -1 ? this.callersOf(current) : this.calleesOf(current);

                for (const edge of step) {
                    edges.set(edgeKey(edge), edge);

                    const other = direction === -1 ? edge.from : edge.to;
                    if (!distance.has(other)) distance.set(other, hops);
                    if (visited.has(other)) continue;
                    visited.add(other);
                    next.push(other);
                }
            }

            frontier = next;
        }

        return distance;
    }

    /** Module names, sorted. The canonical order colours are assigned from. */
    moduleNames(): readonly string[] {
        const names = new Set<string>();
        for (const node of this.nodes.values()) names.add(node.module);
        return [...names].sort((a, b) => a.localeCompare(b));
    }

    /** Every module that has at least one document, for the show/hide list. */
    moduleSummaries(): readonly ModuleSummary[] {
        const counts = new Map<string, { nodeCount: number; orphanCount: number }>();

        for (const node of this.nodes.values()) {
            const bucket = counts.get(node.module) ?? { nodeCount: 0, orphanCount: 0 };
            bucket.nodeCount++;
            if (this.usageStateOf(node.qualifiedName) === "orphan") bucket.orphanCount++;
            counts.set(node.module, bucket);
        }

        return [...counts.entries()]
            .map(([name, bucket]) => ({ name, ...bucket }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Whole-app mode: every relevant document in one flat graph, with the module carried by the
     * node rather than by a box around it.
     *
     * Two filters keep this readable on a real app, and both are reported back rather than applied
     * silently:
     *
     *  - `hiddenModules` is the user's own filter. Nothing from a hidden module appears, and edges
     *    with either end hidden go with it.
     *  - Documents that are neither callable nor connected are dropped. A stock app carries dozens
     *    of layouts that reference nothing and are referenced by nothing; drawing them turns the
     *    view into a field of unconnected rectangles. Callable documents are always kept even when
     *    isolated, because an uncalled microflow is the interesting case, not noise.
     */
    appGraph(hiddenModules: readonly string[]): AppGraph {
        const hidden = new Set(hiddenModules);
        const visible = new Map<string, GraphNode>();

        for (const node of this.nodes.values()) {
            if (hidden.has(node.module)) continue;
            visible.set(node.qualifiedName, node);
        }

        const edges: GraphEdge[] = [];
        const connected = new Set<string>();

        for (const [qualifiedName] of visible) {
            for (const edge of this.calleesOf(qualifiedName)) {
                if (!visible.has(edge.to)) continue;
                edges.push(edge);
                connected.add(edge.from);
                connected.add(edge.to);
            }
        }

        const nodes: NodeSummary[] = [];
        let hiddenIsolated = 0;

        for (const node of visible.values()) {
            if (connected.has(node.qualifiedName) || CALLABLE_KINDS.has(node.kind)) {
                nodes.push(this.summarise(node));
            } else {
                hiddenIsolated++;
            }
        }

        nodes.sort((a, b) => byQualifiedName(a.node, b.node));
        return {
            nodes,
            edges,
            modules: this.moduleNames(),
            hiddenIsolated,
            hiddenModules: [...hidden].sort()
        };
    }
}

/**
 * The model gives edges no identity, so synthesise one. `viaElementId` is part of the key because
 * a microflow calling the same sub-microflow from two activities is genuinely two call sites, and
 * collapsing them would lose a click target.
 */
function edgeKey(edge: GraphEdge): string {
    return edge.from + KEY_SEP + edge.to + KEY_SEP + (edge.viaElementId ?? edge.path);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const existing = map.get(key);
    if (existing === undefined) map.set(key, [value]);
    else existing.push(value);
}

function byQualifiedName(a: GraphNode, b: GraphNode): number {
    return a.qualifiedName.localeCompare(b.qualifiedName);
}

function bySummaryName(a: NodeSummary, b: NodeSummary): number {
    return byQualifiedName(a.node, b.node);
}
