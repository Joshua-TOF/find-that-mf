/**
 * The graph vocabulary, shared by the scanner, the index and both UI entry points.
 *
 * Everything here must survive `structuredClone` across the message-passing boundary, so: plain
 * data only, no Maps, no class instances, no functions.
 */

/**
 * Documents that can *contain* a reference to a microflow. These are the unit types the scanner
 * sweeps, and the `$Type`s that can appear as an edge's `from`.
 *
 * Kept as a const array rather than a bare union so the scanner can iterate it.
 */
export const SCANNED_UNIT_TYPES = [
    "Microflows$Microflow",
    "Microflows$Nanoflow",
    "Microflows$Rule",
    "Pages$Page",
    "Pages$Snippet",
    "Pages$Layout",
    // Page templates and building blocks hold real references: Atlas's login template is what
    // calls Atlas_Web_Content.ACT_Login, and without them that microflow reads as unused.
    "Pages$PageTemplate",
    "Pages$BuildingBlock",
    "Menus$MenuDocument",
    "Workflows$Workflow",
    "ScheduledEvents$ScheduledEvent",
    "DomainModels$DomainModel",
    "Rest$PublishedRestService",
    "Rest$ConsumedODataService",
    "ODataPublish$PublishedODataService2",
    "WebServices$PublishedWebService",
    "WebServices$ImportedWebService",
    "BusinessEvents$BusinessEventService",
    "DocumentTemplates$DocumentTemplate",
    "ImportMappings$ImportMapping",
    "ExportMappings$ExportMapping"
] as const;

export type ScannedUnitType = (typeof SCANNED_UNIT_TYPES)[number];

/**
 * How a node is drawn and grouped. Derived from the unit `$Type` — several `$Type`s collapse to
 * one kind because the distinction does not matter to a reader of the graph.
 */
export type NodeKind =
    | "microflow"
    | "nanoflow"
    | "rule"
    | "page"
    | "snippet"
    | "layout"
    | "pageTemplate"
    | "buildingBlock"
    | "menu"
    | "workflow"
    | "scheduledEvent"
    | "domainModel"
    | "publishedService"
    | "documentTemplate"
    | "mapping"
    | "unknown";

/**
 * One document in the graph.
 *
 * `qualifiedName` is the identity used by edges — `Module.DocumentName`. `id` is the unit `$ID`,
 * kept because `editDocument({ id })` is more robust than a name lookup when a rename is in flight.
 */
export interface GraphNode {
    /** `Module.Name`. The edge identity. */
    readonly qualifiedName: string;
    /** Unit `$ID` from `getUnitsInfo()`. */
    readonly id: string;
    readonly name: string;
    readonly module: string;
    readonly type: ScannedUnitType | string;
    readonly kind: NodeKind;
    /**
     * Mendix's "Mark as used" checkbox (`Microflows$MicroflowBaseBase.markAsUsed`, also on
     * `Pages$Page`). Developers tick it to assert a caller the model cannot see — typically
     * `Core.execute(...)` from a Java action. Suppresses the orphan warning.
     *
     * `undefined` until the unit body has been loaded; `getUnitsInfo()` does not carry it.
     */
    readonly markedAsUsed?: boolean;
    /**
     * The document's Documentation field, trimmed, or `undefined` when it is empty or the unit has
     * not been read yet.
     *
     * Truncated at the scanner rather than here: on a well-documented app this is the largest thing
     * on a node, and a whole-app graph ships hundreds of them across `ui.messagePassing`.
     */
    readonly documentation?: string;
    /** True once this unit's body has been scanned, so its outgoing edges are known. */
    readonly scanned: boolean;
}

/**
 * A reference from one document to a microflow-ish target.
 *
 * There is no edge identity in the model, so callers key on `${from}|${to}|${viaElementId}`.
 */
export interface GraphEdge {
    /** Qualified name of the referencing document. */
    readonly from: string;
    /** Qualified name of the referenced microflow / nanoflow / rule. */
    readonly to: string;
    /**
     * `$ID` of the nearest enclosing drawable element — the `Microflows$ActionActivity`, page
     * widget, menu item, and so on. Feeds `editDocument(doc, { id })` so a click lands on the
     * exact call rather than the top of the document.
     *
     * `null` when the reference sits on the unit itself (a scheduled event's microflow, say).
     */
    readonly viaElementId: string | null;
    /** `$Type` of the element the reference was found on, e.g. `Microflows$MicroflowCall`. */
    readonly viaType: string;
    /**
     * Dotted path from the unit root to the property, e.g.
     * `objectCollection.objects[3].action.microflowCall.microflow`. Shown in the pane so an edge
     * that looks wrong can be traced without guessing.
     */
    readonly path: string;
}

/** Progress of the background reverse-index sweep. */
export interface IndexStatus {
    readonly phase: "idle" | "nodes" | "edges" | "ready" | "error";
    /**
     * Bumped on every change to the graph's contents.
     *
     * This is what tells a UI its data is stale. `phase` is not enough: after the first sweep it
     * sits at `"ready"` forever, so an incremental re-scan triggered by editing a microflow
     * changes nothing a UI can watch, and the pane goes on showing the old callers until something
     * else makes it re-ask.
     */
    readonly revision: number;
    /** Units whose bodies have been scanned. */
    readonly done: number;
    /** Units the sweep intends to scan. */
    readonly total: number;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly error?: string;
}

/**
 * A node paired with everything the UI needs to render it without consulting the index.
 *
 * `usageState` in particular is computed server-side on purpose: it depends on the caller count
 * and on whether the sweep has reached this document yet, neither of which a UI entry point can
 * see. Deriving it in two places is how a badge ends up disagreeing with the orphan report.
 */
export interface NodeSummary {
    readonly node: GraphNode;
    readonly usageState: UsageState;
    readonly callerCount: number;
}

/** One step away from the focus, with the edge that got us there. */
export interface EgoNode extends NodeSummary {
    /** Distance from focus. Negative upstream (callers), positive downstream (callees). */
    readonly depth: number;
}

/**
 * An edge in a focus graph, tagged with which half of the graph it belongs to.
 *
 * Recorded at discovery time rather than derived afterwards: in a cycle an edge is reachable both
 * upstream and downstream of the focus, and there is no way to tell from the edge alone which it
 * "is". The caller walk runs first, so an edge reachable both ways is reported as `"up"`.
 */
export interface EgoEdge extends GraphEdge {
    readonly side: "up" | "down";
}

/** The focus-mode payload: an induced subgraph around one document. */
export interface EgoGraph {
    readonly focus: string;
    /** Every module in the app, sorted. See `AppGraph.modules`. */
    readonly modules: readonly string[];
    /** Includes the focus itself at depth 0. */
    readonly nodes: readonly EgoNode[];
    readonly edges: readonly EgoEdge[];
    /**
     * True when the caller side is not yet trustworthy because the reverse-index sweep is still
     * running. The UI says so rather than implying "no callers".
     */
    readonly callersPartial: boolean;
}

/** One module, for the show/hide list. */
export interface ModuleSummary {
    readonly name: string;
    readonly nodeCount: number;
    /** Callable documents with no callers and no "Mark as used". Zero until the sweep finishes. */
    readonly orphanCount: number;
}

/**
 * Whole-app mode: every document drawn in one space, coloured by module.
 *
 * No module boxes. Nesting documents inside compound module nodes read well on paper and badly in
 * practice — the boxes dominate the canvas and the layout engines that handle compound graphs place
 * their children far enough apart to make it worse. Colour carries the module instead, and the
 * module name is on the node as well, so the encoding is never the only clue.
 */
export interface AppGraph {
    readonly nodes: readonly NodeSummary[];
    readonly edges: readonly GraphEdge[];
    /**
     * Every module in the app, sorted. Carried so a node gets the same colour as its entry in the
     * module dropdown: the colour comes from a module's position in this list, so every consumer
     * must be reading the same list for the legend to mean anything.
     */
    readonly modules: readonly string[];
    /**
     * Documents left out because they neither reference anything nor are referenced, and are not
     * callable. Reported so the view can say so rather than silently under-drawing the app.
     */
    readonly hiddenIsolated: number;
    /** Modules excluded by the filter, for the same reason. */
    readonly hiddenModules: readonly string[];
}

/** Which graph is on screen. */
export type GraphMode = "focus" | "app";

/**
 * Everything the graph needs in order to render, owned by `main`.
 *
 * It cannot live in the UI: separate entry points are separate module instances with no shared
 * memory, and the App Explorer context menu in `main` sets the focus too. Keeping it in `main`
 * means the pane can ask for the current state when it opens rather than starting from nothing.
 */
export interface ViewState {
    readonly mode: GraphMode;
    readonly focus: string | null;
    /** Modules the user has switched off. */
    readonly hiddenModules: readonly string[];
}

/**
 * The three-way answer the pane badges on. Ordinary documents get `"normal"` and no badge.
 *
 * `"orphan"` means "no reference anywhere in the model" — which is *not* the same as "dead",
 * hence `"markedAsUsed"` existing as a distinct state rather than a suppressed warning.
 */
export type UsageState = "normal" | "orphan" | "markedAsUsed";

export interface OrphanReport {
    /** No callers, not marked as used. Genuine cleanup candidates. */
    readonly orphans: readonly NodeSummary[];
    /** No callers, but the author asserted an invisible one. Listed separately, never as a warning. */
    readonly markedAsUsed: readonly NodeSummary[];
    /** False while the sweep is still running — the lists are provisional until it finishes. */
    readonly complete: boolean;
}
