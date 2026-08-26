/**
 * Graph layout, without rendering.
 *
 * Cytoscape is used here in **headless** mode purely as a layout engine. Its on-screen canvas
 * renderer does not paint inside Studio Pro's WebView — it reports correct geometry, and `cy.png()`
 * produces a perfectly good image, but the on-screen layers never receive a single pixel, across
 * repeated instances and forced repaints. A plain canvas created by hand paints fine in the same
 * document, so the host is not at fault in general; something about Cytoscape's layered on-screen
 * renderer simply does not run here.
 *
 * Rather than fight that, the graph is drawn as SVG (see `graph.tsx`) and Cytoscape keeps the job it
 * is genuinely good at: running fcose over a graph and handing back coordinates.
 */

import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

cytoscape.use(fcose);

/** Above this many elements, trade layout quality for staying responsive. */
const BIG_GRAPH = 400;

export interface LayoutNode {
    readonly id: string;
    readonly width: number;
    readonly height: number;
}

export interface LayoutEdge {
    readonly id: string;
    readonly source: string;
    readonly target: string;
}

export interface Placement {
    readonly x: number;
    readonly y: number;
}

/**
 * Runs the layout and returns a position per node id.
 *
 * Force-directed, always. A layered left-to-right layout was offered alongside it and removed: a
 * call graph is not a tree, and the moment there is a cycle the layered layout has to route the back
 * edge against the ranks and draws it straight through whatever node is in the way.
 *
 * fcose is synchronous when `animate: false`, so positions are readable straight after `run()`. The
 * instance is destroyed before returning: it exists only for this call.
 */
export function runLayout(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[]
): Map<string, Placement> {
    const placements = new Map<string, Placement>();
    if (nodes.length === 0) return placements;

    const cy = cytoscape({
        headless: true,
        styleEnabled: true,
        // Node dimensions drive both layouts' spacing, so they have to be real rather than default.
        style: [
            {
                selector: "node",
                style: { width: "data(w)", height: "data(h)", shape: "round-rectangle" }
            }
        ],
        elements: {
            nodes: nodes.map(node => ({
                data: { id: node.id, w: node.width, h: node.height }
            })),
            edges: edges.map(edge => ({
                data: { id: edge.id, source: edge.source, target: edge.target }
            }))
        }
    });

    try {
        cy.layout(optionsFor(nodes.length + edges.length)).run();
        cy.nodes().forEach(node => {
            const position = node.position();
            placements.set(node.id(), { x: position.x, y: position.y });
        });
    } finally {
        cy.destroy();
    }

    return placements;
}

function optionsFor(elementCount: number): cytoscape.LayoutOptions {
    const big = elementCount > BIG_GRAPH;

    // fcose rather than the built-in `cose`: markedly better at spreading a graph out, and fast
    // enough to stay usable at a few thousand nodes. Pure JS, no web worker — which matters, because
    // the extension host does not serve worker scripts.
    return {
        name: "fcose",
        animate: false,
        // "proof" runs more iterations for a cleaner result; on a big graph that becomes a visible
        // freeze, so trade it away once the graph is large.
        quality: big ? "default" : "proof",
        randomize: true,
        // Generous spacing is the whole point of this layout: nodes stop sitting on top of each
        // other's edges, which is what hid the back edge of a cycle underneath a node.
        nodeRepulsion: () => 6_000,
        idealEdgeLength: () => 110,
        edgeElasticity: () => 0.45,
        gravity: 0.35,
        numIter: big ? 1_000 : 2_500,
        // A whole-app graph is mostly small disconnected clusters. Without packing, fcose pushes
        // each one to its own corner and the result is a mostly-empty canvas with the interesting
        // parts scrolled off the edges.
        packComponents: true,
        nodeDimensionsIncludeLabels: false
    } as never;
}

/* -------------------------------------------------------------------------- */
/* Text measurement                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Measures label text so node boxes fit their contents.
 *
 * Uses a 2D context purely for `measureText`; nothing is ever painted, so this is unaffected by the
 * rendering trouble described at the top of this file. Created once and reused — constructing a
 * canvas per label on a 3000-node graph is a measurable cost.
 */
let measuringContext: CanvasRenderingContext2D | null | undefined;

export const NODE_FONT = '11px "Segoe UI", system-ui, sans-serif';

export function measureText(text: string): number {
    if (measuringContext === undefined) {
        const canvas = document.createElement("canvas");
        measuringContext = canvas.getContext("2d");
        if (measuringContext !== null) measuringContext.font = NODE_FONT;
    }
    if (measuringContext === null) {
        // No context: fall back to a per-character estimate rather than collapsing every node to
        // the same width.
        return text.length * 6.2;
    }
    return measuringContext.measureText(text).width;
}
