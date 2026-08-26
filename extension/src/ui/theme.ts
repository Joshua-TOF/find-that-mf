/**
 * Palettes and node presentation, shared by the toolbar and the graph so a microflow looks the
 * same in both.
 *
 * Colours are plain objects rather than CSS because the build has no `.css` loader — see
 * `build.helpers.mjs`. Cytoscape takes JS style objects, and the pane inlines styles, so nothing
 * here needs a stylesheet.
 */

import type { NodeKind, UsageState } from "../graph/types.js";

export interface Palette {
    readonly background: string;
    readonly surface: string;
    readonly border: string;
    readonly text: string;
    readonly textMuted: string;
    readonly accent: string;
    readonly edge: string;
    readonly edgeMuted: string;
    readonly focusRing: string;
    readonly warning: string;
    readonly pinned: string;
    /**
     * Focus-mode flow colours.
     *
     * Focus mode answers "what reaches this, and what does it reach", so colour is spent on the
     * flow rather than on the module: neutral by default, green at the entry points and on
     * everything upstream, red at the exits and downstream, yellow on the focus itself. The module
     * is still written on every node, so nothing is lost by taking colour away from it.
     *
     * Whole-app mode keeps module colours, because there the question is structural.
     */
    readonly flowNeutral: string;
    readonly flowStart: string;
    readonly flowEnd: string;
    readonly flowFocus: string;
    readonly kinds: Readonly<Record<NodeKind, string>>;
}

const LIGHT_KINDS: Record<NodeKind, string> = {
    microflow: "#2f6fd0",
    nanoflow: "#00a5a8",
    rule: "#7b5bd6",
    page: "#4a8f3c",
    snippet: "#6a9a5c",
    layout: "#87a37c",
    pageTemplate: "#9aab8f",
    buildingBlock: "#7f9b70",
    menu: "#b07d2b",
    workflow: "#c2571f",
    scheduledEvent: "#a3382f",
    domainModel: "#5d6d7e",
    publishedService: "#8a4f9e",
    documentTemplate: "#7a6a55",
    mapping: "#6d7f8f",
    unknown: "#8b8b8b"
};

const DARK_KINDS: Record<NodeKind, string> = {
    microflow: "#6fa5f0",
    nanoflow: "#3fd0d3",
    rule: "#a68df0",
    page: "#7bc46a",
    snippet: "#95bf88",
    layout: "#a8bfa0",
    pageTemplate: "#b6c9ad",
    buildingBlock: "#9dbd8e",
    menu: "#d6a552",
    workflow: "#e58a52",
    scheduledEvent: "#e07268",
    domainModel: "#94a3b3",
    publishedService: "#c084d6",
    documentTemplate: "#b3a189",
    mapping: "#9fb0bf",
    unknown: "#a8a8a8"
};

export const LIGHT: Palette = {
    background: "#ffffff",
    surface: "#f4f5f7",
    border: "#d5d8dd",
    text: "#1f2328",
    textMuted: "#6b7280",
    accent: "#2f6fd0",
    edge: "#9aa3ad",
    edgeMuted: "#c9ced4",
    focusRing: "#f0a020",
    warning: "#b8860b",
    pinned: "#5d6d7e",
    flowNeutral: "#6b7280",
    flowStart: "#2f9e44",
    flowEnd: "#c92a2a",
    flowFocus: "#e8a90c",
    kinds: LIGHT_KINDS
};

export const DARK: Palette = {
    background: "#1e1f22",
    surface: "#2b2d31",
    border: "#3d4147",
    text: "#e6e8ea",
    textMuted: "#9aa0a6",
    accent: "#6fa5f0",
    edge: "#6b7280",
    edgeMuted: "#4a4f57",
    focusRing: "#f0a020",
    warning: "#e0b341",
    pinned: "#9aa0a6",
    flowNeutral: "#7b828c",
    flowStart: "#51cf66",
    flowEnd: "#ff6b6b",
    flowFocus: "#ffd43b",
    kinds: DARK_KINDS
};

export function paletteFor(theme: "Light" | "Dark"): Palette {
    return theme === "Dark" ? DARK : LIGHT;
}

/** Short label for a node kind, used in the pane's caller list. */
export const KIND_LABEL: Readonly<Record<NodeKind, string>> = {
    microflow: "Microflow",
    nanoflow: "Nanoflow",
    rule: "Rule",
    page: "Page",
    snippet: "Snippet",
    layout: "Layout",
    pageTemplate: "Page template",
    buildingBlock: "Building block",
    menu: "Menu",
    workflow: "Workflow",
    scheduledEvent: "Scheduled event",
    domainModel: "Event handler",
    publishedService: "Published service",
    documentTemplate: "Document template",
    mapping: "Mapping",
    unknown: "Document"
};

/**
 * The badge for a document's usage state.
 *
 * `markedAsUsed` deliberately outranks `orphan`: Mendix's "Mark as used" checkbox exists so a
 * developer can assert a caller the model cannot see — typically `Core.execute(...)` from a Java
 * action — and warning anyway would send someone off to delete a microflow that is in use.
 *
 * It is shown even when callers *are* found, because the flag is a fact about the document rather
 * than only an excuse for having none.
 */
export interface Badge {
    readonly glyph: string;
    readonly label: string;
    readonly colorOf: (palette: Palette) => string;
}

const ORPHAN_BADGE: Badge = {
    glyph: "⚠",
    label: "No callers found — cleanup candidate",
    colorOf: palette => palette.warning
};

const MARKED_BADGE: Badge = {
    glyph: "\u{1F512}",
    label: "Marked as used — the author asserts a caller this graph cannot see (e.g. a Java action)",
    colorOf: palette => palette.pinned
};

export function badgeFor(state: UsageState): Badge | null {
    if (state === "orphan") return ORPHAN_BADGE;
    if (state === "markedAsUsed") return MARKED_BADGE;
    return null;
}

/**
 * How a document is named in the UI.
 *
 * Always includes the module. Two microflows in different modules routinely share a name - and a
 * graph that shows only `SUB_Validate` twice is worse than useless, because the reader cannot tell
 * which one they are looking at.
 */
export function displayName(node: { name: string; module: string }): string {
    return node.module === "" ? node.name : `${node.module}.${node.name}`;
}

/**
 * Categorical palettes for module colours.
 *
 * Assigned by a module's position in the app's sorted module list rather than by hashing its name.
 * Hashing was tried first and failed the only test that matters: on a stock app, three of five
 * modules came out the same shade of green. With only a handful of modules, any hash over a hue
 * circle collides visually far too often. Positional assignment guarantees distinct colours until
 * the palette is exhausted.
 *
 * The trade-off is that adding a module can shift the colours of the ones after it. That is
 * acceptable — the pane's checkbox list carries the same swatches, so the legend is never stale.
 */
const MODULE_COLOURS_LIGHT = [
    "#2f6fd0",
    "#2f9e44",
    "#c2571f",
    "#9c36b5",
    "#0c8599",
    "#b02a37",
    "#6741d9",
    "#5c940d",
    "#c2255c",
    "#1098ad",
    "#846358",
    "#495057"
];

const MODULE_COLOURS_DARK = [
    "#74b3ff",
    "#69db7c",
    "#ffa94d",
    "#da77f2",
    "#3bc9db",
    "#ff8787",
    "#9775fa",
    "#a9e34b",
    "#f783ac",
    "#66d9e8",
    "#c9a58a",
    "#adb5bd"
];

/** Grey for a document with no module, and for anything not in the canonical list. */
const NO_MODULE_LIGHT = "#9a9a9a";
const NO_MODULE_DARK = "#8b8b8b";

/**
 * Builds the module-to-colour mapping for one canonical module order.
 *
 * @param order Module names, sorted, exactly as the index reports them. Both the pane and the graph
 *              tab build this from the same list so their colours agree.
 */
export function createModuleColours(
    order: readonly string[],
    theme: "Light" | "Dark"
): (moduleName: string) => string {
    const palette = theme === "Dark" ? MODULE_COLOURS_DARK : MODULE_COLOURS_LIGHT;
    const fallback = theme === "Dark" ? NO_MODULE_DARK : NO_MODULE_LIGHT;

    const byName = new Map<string, string>();
    let slot = 0;
    for (const name of order) {
        if (name === "") continue;
        byName.set(name, palette[slot % palette.length]!);
        slot++;
    }

    return (moduleName: string): string => byName.get(moduleName) ?? fallback;
}

/** Text colour that stays readable on top of a module colour for the same theme. */
export function onModuleColour(theme: "Light" | "Dark"): string {
    return theme === "Dark" ? "#14151a" : "#ffffff";
}

/**
 * The silhouette a node is drawn with.
 *
 * Four families, not fourteen. The question a reader is actually asking is "is this a microflow or
 * something else", so microflow keeps the plain rounded rectangle and everything else deviates from
 * it. Colour is already spoken for by the module, and the kind is spelled out on the node's second
 * line, so the shape only has to be enough to scan by — a shape per document type would be noise.
 */
export type NodeShape = "logic" | "client" | "trigger" | "integration";

export function shapeFor(kind: NodeKind): NodeShape {
    switch (kind) {
        // Server-side logic: the baseline. A plain box.
        case "microflow":
        case "rule":
            return "logic";
        // Anything the client runs or renders. Nanoflows belong here rather than with microflows:
        // telling those two apart is exactly the distinction that was hard to see.
        case "nanoflow":
        case "page":
        case "snippet":
        case "layout":
        case "pageTemplate":
        case "buildingBlock":
        case "menu":
            return "client";
        // Things that start work on their own.
        case "scheduledEvent":
        case "workflow":
        case "domainModel":
            return "trigger";
        default:
            return "integration";
    }
}

/** Extra horizontal room a shape needs so its outline does not crowd the label. */
export function shapePadding(shape: NodeShape): number {
    switch (shape) {
        case "trigger":
            // The slanted ends eat into the text box.
            return 14;
        case "client":
            // Fully rounded ends do the same, less severely.
            return 8;
        case "integration":
            return 4;
        default:
            return 0;
    }
}

/** A human name for the family, for tooltips. */
export const SHAPE_LABEL: Readonly<Record<NodeShape, string>> = {
    logic: "server-side logic",
    client: "client-side",
    trigger: "trigger",
    integration: "integration"
};

/* -------------------------------------------------------------------------- */
/* Focus-mode flow roles                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a node is, relative to the focus.
 *
 * `start` and `end` are computed from the focus graph's own edges, which is only meaningful because
 * that graph is unbounded in both directions: a node with no incoming edge there genuinely has no
 * caller anywhere in the scanned model, rather than merely sitting at the edge of a depth cut.
 */
export type FlowRole = "focus" | "start" | "end" | "middle";

export function flowColour(role: FlowRole, palette: Palette): string {
    switch (role) {
        case "focus":
            return palette.flowFocus;
        case "start":
            return palette.flowStart;
        case "end":
            return palette.flowEnd;
        default:
            return palette.flowNeutral;
    }
}

/** Ink that stays readable on top of a flow colour. */
export function onFlowColour(role: FlowRole, theme: "Light" | "Dark"): string {
    // The yellows and greens are light enough to need dark text in either theme; the neutral grey
    // and the reds do not.
    if (role === "focus") return "#1f1c00";
    if (role === "start") return theme === "Dark" ? "#0c2912" : "#ffffff";
    return "#ffffff";
}
