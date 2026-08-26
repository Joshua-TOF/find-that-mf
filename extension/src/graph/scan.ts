/**
 * Reads the app model and turns it into nodes and edges.
 *
 * Two jobs, deliberately separable because they have wildly different costs:
 *   - `readNodes` uses `getUnitsInfo()`, which does not load unit bodies. Cheap. Runs first so the
 *     pane can search immediately.
 *   - `scanUnits` calls `loadAll`, which does. Expensive, batched, and driven with progress.
 */

import type { GraphEdge, GraphNode, NodeKind, ScannedUnitType } from "./types.js";
import { SCANNED_UNIT_TYPES } from "./types.js";

/**
 * `loadAll`'s `maxUnitsToLoad` defaults to 10 and it **throws** rather than truncating when the
 * filter matches more, so every bulk read has to be batched. Eight keeps each call comfortably
 * under the limit while halving the round-trip count versus loading one at a time.
 */
const LOAD_BATCH_SIZE = 8;

/** Longest documentation text kept per document. Enough to read; short enough to ship. */
const MAX_DOCUMENTATION = 600;

/** Modules whose contents are Mendix's, not the developer's. Scanning them is cost with no payoff. */
const SKIPPED_MODULES = new Set(["System"]);

export interface UnitInfoLike {
    $ID: string;
    $Type: string;
    moduleName?: string;
    name?: string;
}

/** The slice of a `ModelAccessWithComponent` this module needs. Narrow enough to fake in tests. */
export interface UnitSource<TUnit> {
    getUnitsInfo(): Promise<ReadonlyArray<Readonly<UnitInfoLike>>>;
    loadAll(filter: (u: UnitInfoLike) => boolean, maxUnitsToLoad?: number): Promise<TUnit[]>;
}

/** Maps a unit `$Type` to the API that can load it. Built once by `main` from `studioPro.app.model`. */
export type SourceMap = Partial<Record<ScannedUnitType, UnitSource<unknown>>>;

/* -------------------------------------------------------------------------- */
/* Reference detection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Property names that hold a qualified name pointing at a callable document.
 *
 * There are 35 distinct reference sites across 13 namespaces in
 * `@mendix/extensions-api@0.11.0-mendix.11.12.0` — `Microflows$MicroflowCall.microflow`,
 * `Pages$MicroflowSettings.microflow`, `ScheduledEvents$ScheduledEvent.microflow`,
 * `Microflows$Microflow.concurrencyErrorMicroflow`, `Rest$PublishedRestService.authenticationMicroflow`,
 * and so on. Hand-writing an extractor per site would be 35 chances to be wrong and would silently
 * miss whatever Mendix adds in 11.13.
 *
 * So instead: match on the property *name*, and require the value to resolve against the node index.
 * Anything that names a real document is an edge; anything else is skipped. That guard is what keeps
 * `Pages$GridActionButton.maintainSelectionAfterMicroflow` (a boolean) and
 * `Microflows$MicroflowPrimitiveParameterUrlSegment.microflowParameter` (a parameter name) out.
 */
function isReferenceProperty(name: string): boolean {
    if (name === "microflow" || name === "nanoflow" || name === "rule") return true;
    // `Mappings$ValueMappingElement.converter` holds a microflow qualified name under a name that
    // gives no hint of it. Found by the completeness audit in `src/cli/validate.ts`, which is what
    // that audit is for - the allowlist below is only as good as the evidence behind it.
    if (name === "converter") return true;
    // `concurrencyErrorMicroflow`, `authenticationMicroflow`, `headerListMicroflow`, ...
    return /(?:Microflow|Nanoflow)$/.test(name);
}

/**
 * Whether this element's `$ID` is worth handing to `editDocument(doc, { id })`.
 *
 * Not a whitelist of what to *recurse* into — the walk recurses into everything. This only decides
 * which ancestor id to attach to an edge, so a click lands on something the editor can scroll to
 * and select rather than on the top of the document.
 *
 * Testing for `relativeMiddlePoint` catches every microflow object generically
 * (`Microflows$MicroflowObjectBase` declares it), which beats enumerating activity types by hand.
 */
function isDrawable(value: Record<string, unknown>): boolean {
    return typeof value["$ID"] === "string" && "relativeMiddlePoint" in value;
}

/**
 * Walks one loaded unit and yields every reference it contains.
 *
 * @param unit     The loaded unit, treated as plain `$Type`-tagged JSON.
 * @param from     Qualified name of the containing document — the edge's tail.
 * @param resolves Returns true when a string names a document in the index.
 */
export function collectReferences(
    unit: unknown,
    from: string,
    resolves: (qualifiedName: string) => boolean
): GraphEdge[] {
    const edges: GraphEdge[] = [];
    // Guards against cyclic references in the returned element graph. Without this the walk
    // recurses until the stack blows.
    const seen = new WeakSet<object>();

    /**
     * @param nearestDrawableId `$ID` of the closest focusable ancestor, or null at the unit root —
     *                          a scheduled event's `microflow` has no drawable ancestor at all.
     * @param nearestType       `$Type` of the element the property sits directly on, for display.
     */
    function walk(
        value: unknown,
        path: string,
        nearestDrawableId: string | null,
        nearestType: string
    ): void {
        if (value === null || typeof value !== "object") return;
        if (seen.has(value)) return;
        seen.add(value);

        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                walk(value[i], path + "[" + i + "]", nearestDrawableId, nearestType);
            }
            return;
        }

        const record = value as Record<string, unknown>;
        const ownType =
            typeof record["$Type"] === "string" ? (record["$Type"] as string) : nearestType;
        const drawableId = isDrawable(record) ? (record["$ID"] as string) : nearestDrawableId;

        for (const [key, child] of Object.entries(record)) {
            if (key === "$Type" || key === "$ID") continue;
            const childPath = path === "" ? key : path + "." + key;

            if (typeof child === "string") {
                if (child !== "" && isReferenceProperty(key) && resolves(child)) {
                    edges.push({
                        from,
                        to: child,
                        viaElementId: drawableId,
                        viaType: ownType,
                        path: childPath
                    });
                }
                continue;
            }

            walk(child, childPath, drawableId, ownType);
        }
    }

    walk(unit, "", null, "");
    return edges;
}

/* -------------------------------------------------------------------------- */
/* Node reading                                                               */
/* -------------------------------------------------------------------------- */

const KIND_BY_TYPE: Readonly<Record<string, NodeKind>> = {
    "Microflows$Microflow": "microflow",
    "Microflows$Nanoflow": "nanoflow",
    "Microflows$Rule": "rule",
    "Pages$Page": "page",
    "Pages$Snippet": "snippet",
    "Pages$Layout": "layout",
    "Pages$PageTemplate": "pageTemplate",
    "Pages$BuildingBlock": "buildingBlock",
    "Menus$MenuDocument": "menu",
    "Workflows$Workflow": "workflow",
    "ScheduledEvents$ScheduledEvent": "scheduledEvent",
    "DomainModels$DomainModel": "domainModel",
    "Rest$PublishedRestService": "publishedService",
    "Rest$ConsumedRestService": "publishedService",
    "Rest$ConsumedODataService": "publishedService",
    "WebServices$ImportedWebService": "publishedService",
    "BusinessEvents$BusinessEventService": "publishedService",
    "ODataPublish$PublishedODataService2": "publishedService",
    "WebServices$PublishedWebService": "publishedService",
    "DocumentTemplates$DocumentTemplate": "documentTemplate",
    "ImportMappings$ImportMapping": "mapping",
    "ExportMappings$ExportMapping": "mapping"
};

export function kindOf(type: string): NodeKind {
    return KIND_BY_TYPE[type] ?? "unknown";
}

/** `getUnitsInfo()` omits `moduleName` for project-level documents; those keep a bare name. */
export function qualify(info: UnitInfoLike): string | null {
    if (info.name === undefined || info.name === "") return null;
    const moduleName = info.moduleName ?? "";
    return moduleName === "" ? info.name : moduleName + "." + info.name;
}

/**
 * Reads every scanned document type's unit list without loading bodies.
 *
 * Returns quickly — this is what makes search usable before the expensive sweep finishes.
 */
export async function readNodes(sources: SourceMap): Promise<GraphNode[]> {
    const nodes: GraphNode[] = [];

    for (const type of SCANNED_UNIT_TYPES) {
        const source = sources[type];
        if (source === undefined) continue;

        let infos: ReadonlyArray<Readonly<UnitInfoLike>>;
        try {
            infos = await source.getUnitsInfo();
        } catch (error) {
            // The model API's errors are unattributed — "Backend failed to handle the request.
            // Response code: 400" names neither the call nor the type. Name it here.
            throw new Error("getUnitsInfo failed for " + type + ": " + describe(error));
        }

        for (const info of infos) {
            if (SKIPPED_MODULES.has(info.moduleName ?? "")) continue;
            const qualifiedName = qualify(info);
            if (qualifiedName === null) continue;

            nodes.push({
                qualifiedName,
                id: info.$ID,
                name: info.name ?? qualifiedName,
                module: info.moduleName ?? "",
                type: info.$Type,
                kind: kindOf(info.$Type),
                scanned: false
            });
        }
    }

    return nodes;
}

/* -------------------------------------------------------------------------- */
/* Unit body sweep                                                            */
/* -------------------------------------------------------------------------- */

/** What reading a unit body tells us about the document itself, beyond its references. */
export interface UnitFacts {
    /**
     * Mendix's "Mark as used" checkbox (`Microflows$MicroflowBaseBase.markAsUsed`, also on
     * `Pages$Page`). Developers tick it to assert a caller the model cannot see - typically
     * `Core.execute(...)` from a Java action. Suppresses the orphan warning.
     */
    readonly markedAsUsed: boolean | undefined;
    /** The Documentation field, trimmed and truncated. */
    readonly documentation: string | undefined;
}

/** Called once per unit as its body is read, so the index fills while the sweep runs. */
export type ScanSink = (
    qualifiedName: string,
    edges: readonly GraphEdge[],
    facts: UnitFacts
) => void;

export type ScanProgress = (done: number, total: number) => void;

/**
 * Loads unit bodies in batches and hands each unit's references to `sink` as it goes.
 *
 * Results stream rather than accumulate so the graph is usable while the sweep is still running —
 * on a large app the sweep takes tens of seconds, and holding every edge back until the end would
 * mean staring at an empty pane for all of it.
 *
 * Batches run **sequentially, not in parallel**. These are heavy calls into Studio Pro's backend,
 * and firing them all at once is how a background refresh turns into a visible stall.
 */
export async function scanUnits(
    sources: SourceMap,
    nodes: readonly GraphNode[],
    resolves: (qualifiedName: string) => boolean,
    sink: ScanSink,
    onProgress?: ScanProgress,
    shouldStop?: () => boolean
): Promise<void> {
    const byType = new Map<string, GraphNode[]>();
    for (const node of nodes) {
        const bucket = byType.get(node.type);
        if (bucket === undefined) byType.set(node.type, [node]);
        else bucket.push(node);
    }

    const total = nodes.length;
    let done = 0;

    for (const type of SCANNED_UNIT_TYPES) {
        const source = sources[type];
        const bucket = byType.get(type);
        if (source === undefined || bucket === undefined) continue;

        const nodeById = new Map(bucket.map(node => [node.id, node]));

        for (let start = 0; start < bucket.length; start += LOAD_BATCH_SIZE) {
            if (shouldStop?.() === true) return;

            const slice = bucket.slice(start, start + LOAD_BATCH_SIZE);
            const wanted = new Set(slice.map(node => node.id));

            let units: unknown[];
            try {
                units = await source.loadAll(info => wanted.has(info.$ID), wanted.size);
            } catch (error) {
                // One bad batch must not lose the whole sweep. Skip it, count it, carry on.
                console.warn("[find-that-mf] loadAll failed for " + type + ": " + describe(error));
                done += slice.length;
                onProgress?.(done, total);
                continue;
            }

            for (const unit of units) {
                const record = unit as Record<string, unknown>;
                const id = typeof record["$ID"] === "string" ? (record["$ID"] as string) : null;
                const node = id === null ? undefined : nodeById.get(id);
                if (node === undefined) continue;

                sink(
                    node.qualifiedName,
                    collectReferences(unit, node.qualifiedName, resolves),
                    readFacts(record)
                );
            }

            done += slice.length;
            onProgress?.(done, total);
        }
    }
}

/** Loads a single unit body — the "callees on demand" path that needs no full sweep. */
export async function scanOne(
    source: UnitSource<unknown>,
    node: GraphNode,
    resolves: (qualifiedName: string) => boolean
): Promise<{ edges: GraphEdge[]; facts: UnitFacts } | null> {
    const units = await source.loadAll(info => info.$ID === node.id, 1);
    const unit = units[0];
    if (unit === undefined) return null;

    const record = unit as Record<string, unknown>;
    return {
        edges: collectReferences(unit, node.qualifiedName, resolves),
        facts: readFacts(record)
    };
}

/**
 * The per-document facts that only exist on the unit *body*, never on `UnitInfo` — which is why
 * they are only known once a unit has actually been loaded. `undefined` means "not known yet or not
 * applicable", never "false" or "empty".
 */
function readFacts(record: Record<string, unknown>): UnitFacts {
    return {
        markedAsUsed:
            typeof record["markAsUsed"] === "boolean" ? (record["markAsUsed"] as boolean) : undefined,
        documentation: readDocumentation(record)
    };
}

/**
 * `Projects$Document.documentation`, so every document type has one.
 *
 * Truncated here rather than at the UI: a whole-app graph carries hundreds of nodes across
 * `ui.messagePassing`, and a few paragraphs each would dominate the payload. Anyone who wants the
 * full text is one click from the document itself.
 */
function readDocumentation(record: Record<string, unknown>): string | undefined {
    const raw = record["documentation"];
    if (typeof raw !== "string") return undefined;
    const text = raw.trim();
    if (text === "") return undefined;
    return text.length <= MAX_DOCUMENTATION
        ? text
        : text.slice(0, MAX_DOCUMENTATION).trimEnd() + "…";
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
