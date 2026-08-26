/**
 * The graph itself: canvas, interactions, hover card.
 *
 * Rendered inline in the bottom-dock pane. It owns no settings of its own — it draws whatever view
 * state `main` hands it, and the toolbar above it is what changes that.
 *
 * **Drawn as SVG, not canvas.** Cytoscape was the obvious choice and its renderer does not work
 * inside Studio Pro's WebView: it reports correct geometry and `cy.png()` yields a perfectly good
 * image, but its on-screen layers never receive a single pixel — verified by reading them back,
 * across rebuilt instances and forced repaints. A hand-made canvas paints fine in the same document,
 * so this is specific to Cytoscape's layered renderer rather than the host. Cytoscape is still used,
 * headless, for layout only (see `layout.ts`); the drawing here is plain SVG, which is the same DOM
 * path the pane uses and is therefore known to work.
 *
 * SVG also costs less than it looks: a call graph worth reading is filtered down to hundreds of
 * nodes, and the module filter exists to keep it that way.
 */

import type { getStudioProApi } from "@mendix/extensions-api";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Diagnostics } from "../graph/diagnostics.js";
import { request } from "../graph/protocol.js";
import type { MessageChannel, Push } from "../graph/protocol.js";
import { isPush } from "../graph/protocol.js";
import type {
    AppGraph,
    EgoEdge,
    EgoGraph,
    GraphEdge,
    IndexStatus,
    NodeSummary,
    ViewState
} from "../graph/types.js";
import { NODE_FONT, measureText, runLayout } from "./layout.js";
import {
    KIND_LABEL,
    SHAPE_LABEL,
    badgeFor,
    createModuleColours,
    flowColour,
    onFlowColour,
    onModuleColour,
    paletteFor,
    shapeFor,
    shapePadding,
    type FlowRole,
    type NodeShape,
    type Palette
} from "./theme.js";

type StudioPro = ReturnType<typeof getStudioProApi>;
type Theme = "Light" | "Dark";

/** Collapses a burst of content revisions into one fetch. */
const REFETCH_DEBOUNCE_MS = 200;

/**
 * How long a single click waits to see whether it is really the first half of a double click.
 *
 * Long enough to catch a deliberate double click, short enough that opening a document still feels
 * immediate.
 */
const DOUBLE_CLICK_GRACE_MS = 220;

const NODE_PAD_X = 9;
const NODE_LINE = 13;
const NODE_PAD_Y = 7;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const FIT_PADDING = 40;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Drawing model                                                              */
/* -------------------------------------------------------------------------- */

interface DrawnNode {
    readonly id: string;
    readonly lines: readonly string[];
    readonly shape: NodeShape;
    readonly fill: string;
    readonly ink: string;
    readonly isFocus: boolean;
    readonly isOrphan: boolean;
    /** Everything the hover card shows, resolved once at layout time. */
    readonly detail: NodeDetail;
    readonly width: number;
    readonly height: number;
    x: number;
    y: number;
}

interface NodeDetail {
    readonly name: string;
    readonly module: string;
    readonly kind: string;
    readonly documentation: string | undefined;
    readonly badge: string | undefined;
}

interface DrawnEdge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly viaElementId: string | null;
    readonly title: string;
    /**
     * Which half of a focus graph this belongs to, or `null` in whole-app mode where there is no
     * focus to be upstream or downstream of.
     */
    readonly side: "up" | "down" | null;
}

interface Scene {
    readonly nodes: readonly DrawnNode[];
    readonly edges: readonly DrawnEdge[];
    readonly byId: ReadonlyMap<string, DrawnNode>;
}

interface Viewport {
    readonly x: number;
    readonly y: number;
    readonly k: number;
}

/* -------------------------------------------------------------------------- */
/* Tab                                                                        */
/* -------------------------------------------------------------------------- */

export function GraphView({
    studioPro,
    theme,
    diagnostics
}: {
    studioPro: StudioPro;
    theme: Theme;
    diagnostics: Diagnostics;
}): JSX.Element {
    // Memoised deliberately: `studioPro.ui.messagePassing` hands back a fresh object on every
    // property access, so reading it inline gives `channel` a new identity on every render, and
    // every effect depending on it then re-runs on every render.
    const channel = useMemo(
        () => studioPro.ui.messagePassing as unknown as MessageChannel,
        [studioPro]
    );
    const palette = useMemo(() => paletteFor(theme), [theme]);

    const [view, setView] = useState<ViewState | null>(null);
    const [ego, setEgo] = useState<EgoGraph | null>(null);
    const [app, setApp] = useState<AppGraph | null>(null);
    const [status, setStatus] = useState<IndexStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [scene, setScene] = useState<Scene | null>(null);
    const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
    const [hovered, setHovered] = useState<string | null>(null);
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    const frameRef = useRef<HTMLDivElement | null>(null);
    /** Signature of the scene currently laid out, so an unrelated edit does not reshuffle it. */
    const drawnRef = useRef<string>("");
    const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
    /**
     * Pending single-click action, held until a double-click can be ruled out.
     *
     * A double-click fires `click` *before* `dblclick`, so acting on the click immediately opened
     * the document and Studio Pro switched away to the microflow editor. The refocus still happened;
     * it was simply invisible, because the graph tab was no longer on screen. Deferring the click
     * briefly and cancelling it when a double-click arrives is the only way to keep both gestures.
     */
    const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * Whether the user has panned or zoomed.
     *
     * Until they do, the view is re-fitted whenever the frame is measured or resized. After they do,
     * it is theirs - silently yanking the viewport back while somebody is reading is worse than an
     * imperfect initial fit.
     */
    const movedRef = useRef(false);

    /* --- wiring ---------------------------------------------------------- */

    useEffect(() => {
        let handler: { handlerId: string } | undefined;

        void studioPro.ui.messagePassing
            .addMessageHandler<unknown>(async info => {
                if (!isPush(info.message)) return;
                const push = info.message as Push;
                if (push.kind === "mf:push-view") setView(push.view);
                // The revision inside the status is how this tab learns a microflow was edited.
                if (push.kind === "mf:push-status") setStatus(push.status);
            })
            .then(reference => {
                handler = reference;
            });

        // Ask for the current state rather than waiting to be told: the pane may have set it long
        // before this tab was opened.
        void request(channel, { kind: "mf:view" })
            .then(setView)
            .catch((cause: unknown) => setMessage(describe(cause)));
        void request(channel, { kind: "mf:status" })
            .then(setStatus)
            .catch(() => undefined);

        return () => {
            if (handler !== undefined) void studioPro.ui.messagePassing.removeMessageHandler(handler);
        };
    }, [channel, studioPro]);

    /* --- size ------------------------------------------------------------ */

    useEffect(() => {
        const frame = frameRef.current;
        if (frame === null) return;

        const measure = (): void =>
            setSize({ width: frame.clientWidth, height: frame.clientHeight });
        measure();

        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(frame);
        return () => observer.disconnect();
    }, []);

    /* --- data ------------------------------------------------------------ */

    const mode = view?.mode;
    const focus = view?.focus ?? null;
    const revision = status?.revision;
    const indexReady = status?.phase === "ready";
    // Joined into a primitive so the effect's dependency comparison works; an array identity would
    // change on every push and refetch forever.
    const hiddenKey = (view?.hiddenModules ?? []).join("|");

    useEffect(() => {
        if (mode !== "focus") return;
        if (focus === null) {
            setEgo(null);
            return;
        }
        setBusy(true);
        const timer = setTimeout(() => {
            void request(channel, { kind: "mf:ego", focus })
                .then(result => {
                    setMessage(result === null ? `${focus} is not in the index.` : null);
                    setEgo(result);
                })
                .catch((cause: unknown) => setMessage(describe(cause)))
                .finally(() => setBusy(false));
        }, REFETCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [channel, mode, focus, revision]);

    useEffect(() => {
        if (mode !== "app") return;
        // Whole-app mode is only meaningful once every document has been looked at, and the request
        // blocks until then anyway.
        if (!indexReady) {
            setBusy(true);
            return;
        }
        setBusy(true);
        const timer = setTimeout(() => {
            void request(channel, { kind: "mf:app-graph" })
                .then(result => {
                    setMessage(null);
                    setApp(result);
                })
                .catch((cause: unknown) => setMessage(describe(cause)))
                .finally(() => setBusy(false));
        }, REFETCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [channel, mode, indexReady, revision, hiddenKey]);

    /* --- layout ---------------------------------------------------------- */

    useEffect(() => {
        if (view === null) return;

        const payload = view.mode === "focus" ? ego : app;
        if (payload === null) {
            setScene(null);
            drawnRef.current = "";
            return;
        }

        const nodes = payload.nodes;
        const edges = payload.edges;
        const focusName = view.mode === "focus" ? (payload as EgoGraph).focus : "";

        // Re-lay-out only when the graph itself changed. The payload is refreshed on every content
        // revision, and most revisions leave this view identical — re-running a force-directed
        // layout for them would reshuffle the picture under the reader for no reason.
        const signature = signatureOf(view.mode, focusName, nodes, edges);
        if (signature === drawnRef.current) return;
        drawnRef.current = signature;

        const colourOf = createModuleColours(payload.modules, theme);
        const ink = onModuleColour(theme);
        const isFocusMode = view.mode === "focus";

        // Entry and exit points, from this graph's own edges. Sound because the focus walk is
        // unbounded: no incoming edge here means no caller anywhere in the scanned model.
        const hasIncoming = new Set(edges.map(edge => edge.to));
        const hasOutgoing = new Set(edges.map(edge => edge.from));
        const roleOf = (qualifiedName: string): FlowRole => {
            if (qualifiedName === focusName) return "focus";
            if (!hasIncoming.has(qualifiedName)) return "start";
            if (!hasOutgoing.has(qualifiedName)) return "end";
            return "middle";
        };

        const drawn: DrawnNode[] = nodes.map(entry => {
            const lines = labelLines(entry);
            const shape = shapeFor(entry.node.kind);
            const role = roleOf(entry.node.qualifiedName);
            const width =
                Math.max(...lines.map(line => measureText(line))) +
                NODE_PAD_X * 2 +
                shapePadding(shape);
            return {
                id: entry.node.qualifiedName,
                lines,
                shape,
                fill: isFocusMode ? flowColour(role, palette) : colourOf(entry.node.module),
                ink: isFocusMode ? onFlowColour(role, theme) : ink,
                isFocus: entry.node.qualifiedName === focusName,
                isOrphan: entry.usageState === "orphan",
                detail: {
                    name: entry.node.name,
                    module: entry.node.module,
                    kind: `${KIND_LABEL[entry.node.kind]} · ${SHAPE_LABEL[shape]}`,
                    documentation: entry.node.documentation,
                    badge: badgeFor(entry.usageState)?.label
                },
                width: Math.max(64, Math.round(width)),
                height: lines.length * NODE_LINE + NODE_PAD_Y * 2,
                x: 0,
                y: 0
            };
        });

        const present = new Set(drawn.map(node => node.id));
        const drawnEdges: DrawnEdge[] = [];
        const seen = new Set<string>();
        for (const edge of edges) {
            if (!present.has(edge.from) || !present.has(edge.to)) continue;
            const id = `${edge.from}->${edge.to}@${edge.viaElementId ?? edge.path}`;
            if (seen.has(id)) continue;
            seen.add(id);
            drawnEdges.push({
                id,
                from: edge.from,
                to: edge.to,
                viaElementId: edge.viaElementId,
                title: `${edge.from}\n  -> ${edge.to}\n${edge.path}`,
                side: isFocusMode ? ((edge as EgoEdge).side ?? null) : null
            });
        }

        const placements = runLayout(
            drawn.map(node => ({ id: node.id, width: node.width, height: node.height })),
            drawnEdges.map(edge => ({ id: edge.id, source: edge.from, target: edge.to }))
        );

        for (const node of drawn) {
            const at = placements.get(node.id);
            if (at !== undefined) {
                node.x = at.x;
                node.y = at.y;
            }
        }

        const byId = new Map(drawn.map(node => [node.id, node]));
        setScene({ nodes: drawn, edges: drawnEdges, byId });
        // A fresh graph gets a fresh viewport, so the next fit is allowed to take effect.
        movedRef.current = false;
        diagnostics.log(`laid out ${drawn.length} nodes, ${drawnEdges.length} edges`);
    }, [view, ego, app, theme, diagnostics]);

    // Fitting is deliberately separate from laying out. The frame is often measured after the first
    // layout has already run, so fitting inside the layout effect used the wrong dimensions and left
    // the graph half off-screen.
    useEffect(() => {
        if (scene === null || movedRef.current) return;
        if (size.width <= 0 || size.height <= 0) return;
        setViewport(fitViewport(scene.nodes, size.width, size.height));
    }, [scene, size.width, size.height]);

    /* --- actions --------------------------------------------------------- */

    const open = useCallback(
        (qualifiedName: string, elementId: string | null) => {
            void request(channel, { kind: "mf:open", qualifiedName, elementId });
        },
        [channel]
    );

    const refocus = useCallback(
        (qualifiedName: string) => {
            void request(channel, {
                kind: "mf:set-view",
                patch: { focus: qualifiedName, mode: "focus" }
            });
        },
        [channel]
    );

    const cancelPendingClick = useCallback(() => {
        if (clickTimerRef.current !== null) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
    }, []);

    /** Runs `action` unless a double-click lands first. */
    const deferClick = useCallback(
        (action: () => void) => {
            cancelPendingClick();
            clickTimerRef.current = setTimeout(() => {
                clickTimerRef.current = null;
                action();
            }, DOUBLE_CLICK_GRACE_MS);
        },
        [cancelPendingClick]
    );

    useEffect(() => cancelPendingClick, [cancelPendingClick]);

    const fitNow = useCallback(() => {
        if (scene === null) return;
        movedRef.current = false;
        setViewport(fitViewport(scene.nodes, size.width, size.height));
    }, [scene, size.width, size.height]);

    /* --- pan and zoom ---------------------------------------------------- */

    const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
        event.preventDefault();
        movedRef.current = true;
        const frame = frameRef.current;
        if (frame === null) return;
        const rect = frame.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;

        setViewport(current => {
            const factor = Math.exp(-event.deltaY * 0.0015);
            const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
            // Keep the point under the cursor fixed, which is what makes wheel zoom feel right.
            const scale = k / current.k;
            return {
                k,
                x: px - (px - current.x) * scale,
                y: py - (py - current.y) * scale
            };
        });
    }, []);

    const onPointerDown = useCallback(
        (event: React.PointerEvent<SVGSVGElement>) => {
            if (event.button !== 0) return;
            // Panning is for the background. Starting a drag on a node or an edge should not move
            // the canvas, and capturing the pointer there risks the click never reaching the shape.
            if ((event.target as Element).closest?.("[data-interactive]") != null) return;
            movedRef.current = true;
            panRef.current = {
                x: event.clientX,
                y: event.clientY,
                vx: viewport.x,
                vy: viewport.y
            };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        [viewport.x, viewport.y]
    );

    const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
        const start = panRef.current;
        if (start === null) return;
        setViewport(current => ({
            ...current,
            x: start.vx + (event.clientX - start.x),
            y: start.vy + (event.clientY - start.y)
        }));
    }, []);

    const onPointerUp = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
        panRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    // Stroke widths live in graph units inside the transformed <g>, so a fixed hit width shrinks
    // to a couple of screen pixels when zoomed out. Scaling by the zoom keeps edges reliably
    // clickable at any magnification.
    const hitWidth = clamp(14 / viewport.k, 6, 220);

    /* --- chrome ---------------------------------------------------------- */

    return (
        <div ref={frameRef} style={styles.frame(palette)}>
            <div
                style={styles.overlay(palette)}
                title="Click a node to open it · double-click to refocus · hover an edge to trace it · drag to pan, wheel to zoom"
            >
                <span>{summary(view, ego, app)}</span>
                {busy && <span style={styles.muted(palette)}> · working…</span>}
                {ego?.callersPartial === true && view?.mode === "focus" && (
                    <span style={{ color: palette.warning }}> · still indexing</span>
                )}
                {message !== null && <span style={{ color: palette.warning }}> · {message}</span>}
                <button type="button" onClick={fitNow} style={styles.fitButton(palette)}>
                    Fit
                </button>
            </div>

            {scene !== null && hoveredNode !== null && (
                <HoverCard
                    node={scene.byId.get(hoveredNode)}
                    palette={palette}
                    viewport={viewport}
                    frame={size}
                />
            )}

            {scene === null ? (
                <div style={styles.empty(palette)}>Nothing to draw yet.</div>
            ) : (
                <svg
                    width={size.width}
                    height={size.height}
                    style={styles.svg}
                    onWheel={onWheel}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                >
                    <defs>
                        <Arrow id="mf-arrow" fill={palette.edge} />
                        <Arrow id="mf-arrow-up" fill={palette.flowStart} />
                        <Arrow id="mf-arrow-down" fill={palette.flowEnd} />
                        <Arrow id="mf-arrow-hot" fill={palette.accent} />
                    </defs>

                    <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.k})`}>
                        {scene.edges.map(edge => (
                            <EdgeShape
                                key={edge.id}
                                edge={edge}
                                scene={scene}
                                palette={palette}
                                hot={hovered === edge.id}
                                hitWidth={hitWidth}
                                onEnter={() => setHovered(edge.id)}
                                onLeave={() => setHovered(null)}
                            />
                        ))}
                        {scene.nodes.map(node => (
                            <NodeShape
                                key={node.id}
                                node={node}
                                palette={palette}
                                onOpen={() => {
                                    diagnostics.log(`click node ${node.id}`);
                                    deferClick(() => open(node.id, null));
                                }}
                                onRefocus={() => {
                                    diagnostics.log(`double-click node ${node.id}`);
                                    cancelPendingClick();
                                    refocus(node.id);
                                }}
                                onEnter={() => setHoveredNode(node.id)}
                                onLeave={() =>
                                    setHoveredNode(current => (current === node.id ? null : current))
                                }
                            />
                        ))}
                    </g>
                </svg>
            )}
        </div>
    );
}

/** One arrowhead definition. Four of them differ only by fill. */
function Arrow({ id, fill }: { id: string; fill: string }): JSX.Element {
    return (
        <marker
            id={id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
        >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} />
        </marker>
    );
}

function NodeShape({
    node,
    palette,
    onOpen,
    onRefocus,
    onEnter,
    onLeave
}: {
    node: DrawnNode;
    palette: Palette;
    onOpen: () => void;
    onRefocus: () => void;
    onEnter: () => void;
    onLeave: () => void;
}): JSX.Element {
    const left = node.x - node.width / 2;
    const top = node.y - node.height / 2;

    return (
        <g
            data-interactive="node"
            transform={`translate(${left},${top})`}
            style={{ cursor: "pointer" }}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            onClick={onOpen}
            onDoubleClick={event => {
                // The pending single click is cancelled by the handler itself; stopping propagation
                // only keeps the background from also reacting.
                event.stopPropagation();
                onRefocus();
            }}
        >
            {/* No <title>: the hover card carries this, and a native tooltip on top of it would
                just be a second, slower, uglier copy. */}
            <path
                d={outlinePath(node.shape, node.width, node.height)}
                fill={node.fill}
                stroke={node.isOrphan ? palette.warning : "transparent"}
                strokeWidth={node.isOrphan ? 2 : 0}
                strokeDasharray={node.isOrphan ? "4 3" : undefined}
                strokeLinejoin="round"
            />
            {node.lines.map((line, index) => (
                <text
                    key={index}
                    x={node.width / 2}
                    y={NODE_PAD_Y + NODE_LINE * index + NODE_LINE - 3}
                    textAnchor="middle"
                    fill={node.ink}
                    style={{ font: NODE_FONT, pointerEvents: "none" }}
                >
                    {line}
                </text>
            ))}
        </g>
    );
}

function EdgeShape({
    edge,
    scene,
    palette,
    hot,
    hitWidth,
    onEnter,
    onLeave
}: {
    edge: DrawnEdge;
    scene: Scene;
    palette: Palette;
    hot: boolean;
    /** Width of the invisible hit path, in graph units. */
    hitWidth: number;
    onEnter: () => void;
    onLeave: () => void;
}): JSX.Element | null {
    const from = scene.byId.get(edge.from);
    const to = scene.byId.get(edge.to);
    if (from === undefined || to === undefined) return null;

    const path = edgePath(from, to, edge.from < edge.to ? 1 : -1);
    // Green flows toward the focus, red flows away from it — the same reading as the node colours.
    const colour =
        edge.side === "up"
            ? palette.flowStart
            : edge.side === "down"
              ? palette.flowEnd
              : palette.edge;
    const marker =
        edge.side === "up" ? "mf-arrow-up" : edge.side === "down" ? "mf-arrow-down" : "mf-arrow";

    // Not clickable, deliberately. An edge used to open its *caller* at the exact call site, which
    // sounds useful and feels wrong: you click a line and a different document opens. Hovering still
    // highlights the edge and names both ends, which is what tracing one line out of a tangle
    // actually needs.
    //
    // No `data-interactive` either, so a drag that starts on an edge still pans. The hit path is
    // wide — up to 220 graph units when zoomed out — and turning that into dead space for panning
    // would feel broken.
    return (
        <g onMouseEnter={onEnter} onMouseLeave={onLeave}>
            <title>{edge.title}</title>
            {/*
                A fat invisible copy underneath: a 1.6px line is far too fine to hover accurately.

                `pointerEvents: "stroke"` is load-bearing. The default is `visiblePainted`, which only
                hit-tests a stroke that is actually painted — a fully transparent one is not, so this
                path caught nothing at all.
            */}
            <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={hitWidth}
                style={{ pointerEvents: "stroke" }}
            />
            <path
                d={path}
                fill="none"
                stroke={hot ? palette.accent : colour}
                strokeWidth={hot ? 2.8 : 1.6}
                markerEnd={hot ? "url(#mf-arrow-hot)" : `url(#${marker})`}
                style={{ pointerEvents: "none" }}
            />
        </g>
    );
}

/**
 * The card shown while the pointer is over a node.
 *
 * Exists chiefly to surface the document's **Documentation** field, which is the one thing about a
 * microflow that a graph cannot show and that people actually write down. A native `<title>` would
 * have been less code and much worse: it takes a second to appear, cannot be styled, and collapses
 * whitespace, which mangles anything longer than a sentence.
 *
 * Positioned beside the node in screen space and clamped to the frame, so it never hangs off the
 * edge. `pointerEvents: none` because a card that can itself be hovered flickers.
 */
function HoverCard({
    node,
    palette,
    viewport,
    frame
}: {
    node: DrawnNode | undefined;
    palette: Palette;
    viewport: Viewport;
    frame: { width: number; height: number };
}): JSX.Element | null {
    if (node === undefined) return null;

    const width = 300;
    const screenX = viewport.x + node.x * viewport.k;
    const screenY = viewport.y + node.y * viewport.k;
    const halfHeight = (node.height / 2) * viewport.k;

    // Prefer to the right of the node; flip left when that would overflow.
    const wantsLeft = screenX + node.width / 2 * viewport.k + width + 24 > frame.width;
    const left = wantsLeft
        ? Math.max(8, screenX - (node.width / 2) * viewport.k - width - 12)
        : Math.min(frame.width - width - 8, screenX + (node.width / 2) * viewport.k + 12);
    const top = clamp(screenY + halfHeight + 8, 8, Math.max(8, frame.height - 130));

    return (
        <div style={{ ...styles.card(palette), left, top, width }}>
            <div style={styles.cardName(palette)}>{node.detail.name}</div>
            <div style={styles.cardMeta(palette)}>
                {node.detail.module === "" ? node.detail.kind : `${node.detail.module} · ${node.detail.kind}`}
            </div>
            {node.detail.badge !== undefined && (
                <div style={styles.cardBadge(palette)}>{node.detail.badge}</div>
            )}
            <div style={styles.cardDoc(palette, node.detail.documentation !== undefined)}>
                {node.detail.documentation ?? "No documentation."}
            </div>
        </div>
    );
}

/**
 * The outline for one shape family, as an SVG path.
 *
 * All four are the same box with the same height; only the edges differ. That is the point — the
 * silhouettes have to be distinguishable at a glance without any of them shouting.
 */
function outlinePath(shape: NodeShape, width: number, height: number): string {
    const w = round(width);
    const h = round(height);

    switch (shape) {
        case "client": {
            // A pill. Reads as "not a microflow" instantly without looking like a different diagram.
            const r = round(h / 2);
            return (
                `M ${r} 0 L ${round(w - r)} 0 ` +
                `A ${r} ${r} 0 0 1 ${round(w - r)} ${h} ` +
                `L ${r} ${h} A ${r} ${r} 0 0 1 ${r} 0 Z`
            );
        }
        case "trigger": {
            // Slanted ends: a hexagon. Points suggest something that fires rather than is called.
            const slant = round(Math.min(11, h / 2));
            return (
                `M ${slant} 0 L ${round(w - slant)} 0 L ${w} ${round(h / 2)} ` +
                `L ${round(w - slant)} ${h} L ${slant} ${h} L 0 ${round(h / 2)} Z`
            );
        }
        case "integration": {
            // A folded top-right corner, the way a document is drawn.
            const cut = round(Math.min(11, h / 2));
            const r = 4;
            return (
                `M ${r} 0 L ${round(w - cut)} 0 L ${w} ${cut} ` +
                `L ${w} ${round(h - r)} A ${r} ${r} 0 0 1 ${round(w - r)} ${h} ` +
                `L ${r} ${h} A ${r} ${r} 0 0 1 0 ${round(h - r)} ` +
                `L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`
            );
        }
        default: {
            // Plain rounded rectangle: the microflow baseline everything else is read against.
            const r = 4;
            return (
                `M ${r} 0 L ${round(w - r)} 0 A ${r} ${r} 0 0 1 ${w} ${r} ` +
                `L ${w} ${round(h - r)} A ${r} ${r} 0 0 1 ${round(w - r)} ${h} ` +
                `L ${r} ${h} A ${r} ${r} 0 0 1 0 ${round(h - r)} ` +
                `L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`
            );
        }
    }
}

/**
 * A quadratic curve between two node borders.
 *
 * Curved rather than straight, and bowed in opposite directions for a reciprocal pair, so A→B and
 * B→A do not land on top of one another. The endpoints are pulled back to each box's edge so the
 * arrowhead is visible instead of hidden under the target.
 */
function edgePath(from: DrawnNode, to: DrawnNode, bow: number): string {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;

    const start = borderPoint(from, dx / distance, dy / distance);
    const end = borderPoint(to, -dx / distance, -dy / distance);

    // Perpendicular offset, scaled with distance but capped so long edges do not balloon.
    const lift = Math.min(distance * 0.12, 34) * bow;
    const mx = (start.x + end.x) / 2 - (dy / distance) * lift;
    const my = (start.y + end.y) / 2 + (dx / distance) * lift;

    return `M ${round(start.x)} ${round(start.y)} Q ${round(mx)} ${round(my)} ${round(end.x)} ${round(end.y)}`;
}

/** Where a ray leaving a node's centre crosses its box. */
function borderPoint(node: DrawnNode, ux: number, uy: number): { x: number; y: number } {
    const halfWidth = node.width / 2 + 2;
    const halfHeight = node.height / 2 + 2;
    const scale = Math.min(
        ux === 0 ? Infinity : Math.abs(halfWidth / ux),
        uy === 0 ? Infinity : Math.abs(halfHeight / uy)
    );
    return { x: node.x + ux * scale, y: node.y + uy * scale };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Two lines: the document name, then its module and — when it is not a plain microflow — its kind.
 *
 * The module is not decoration. `SUB_Validate` exists in several modules on any real app, and a graph
 * showing the bare name twice cannot be read. Colour says the same thing faster, but colour alone
 * would be unusable for anyone who cannot separate the hues, so both are present.
 */
function labelLines(entry: NodeSummary): string[] {
    const badge = badgeFor(entry.usageState);
    const first = badge === null ? entry.node.name : `${entry.node.name}  ${badge.glyph}`;
    const kind = entry.node.kind === "microflow" ? "" : ` · ${KIND_LABEL[entry.node.kind]}`;
    const second = `${entry.node.module}${kind}`.trim();
    return second === "" ? [first] : [first, second];
}

function fitViewport(
    nodes: readonly DrawnNode[],
    width: number,
    height: number
): Viewport {
    if (nodes.length === 0 || width <= 0 || height <= 0) return { x: 0, y: 0, k: 1 };

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
        minX = Math.min(minX, node.x - node.width / 2);
        maxX = Math.max(maxX, node.x + node.width / 2);
        minY = Math.min(minY, node.y - node.height / 2);
        maxY = Math.max(maxY, node.y + node.height / 2);
    }

    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const k = clamp(
        Math.min(
            (width - FIT_PADDING * 2) / graphWidth,
            (height - FIT_PADDING * 2) / graphHeight
        ),
        MIN_ZOOM,
        // Never zoom past 1:1 on a small graph; blown-up boxes look broken rather than helpful.
        1
    );

    return {
        k,
        x: width / 2 - ((minX + maxX) / 2) * k,
        y: height / 2 - ((minY + maxY) / 2) * k
    };
}

function signatureOf(
    mode: string,
    focus: string,
    nodes: readonly NodeSummary[],
    edges: readonly GraphEdge[]
): string {
    const nodePart = nodes.map(entry => entry.node.qualifiedName).join(",");
    const edgePart = edges
        .map(edge => `${edge.from}>${edge.to}@${edge.viaElementId ?? edge.path}`)
        .join(",");
    return `${mode}|${focus}|${nodePart}|${edgePart}`;
}

function summary(view: ViewState | null, ego: EgoGraph | null, app: AppGraph | null): string {
    if (view === null) return "Connecting…";

    if (view.mode === "focus") {
        if (view.focus === null) return "No focus. Pick a microflow in the Find that MF pane.";
        return `${view.focus} · ${ego?.nodes.length ?? 0} nodes, ${ego?.edges.length ?? 0} references`;
    }

    if (app === null) return "Loading…";

    const parts = [`${app.nodes.length} documents`, `${app.edges.length} references`];
    if (app.hiddenModules.length > 0) parts.push(`${app.hiddenModules.length} modules hidden`);
    // Said out loud rather than silently dropped: a view that under-draws the app without admitting
    // it is worse than a busy one.
    if (app.hiddenIsolated > 0) parts.push(`${app.hiddenIsolated} unconnected omitted`);
    return parts.join(" · ");
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const styles = {
    /**
     * The canvas fills whatever it is given — a dock strip or a whole working-area tab — so the
     * chrome floats on top rather than taking a row. In a three-row-tall dock a status bar would be
     * a third of the graph.
     */
    frame: (p: Palette): React.CSSProperties => ({
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: p.background,
        color: p.text,
        font: '12px/1.5 "Segoe UI", system-ui, sans-serif'
    }),
    overlay: (p: Palette): React.CSSProperties => ({
        position: "absolute",
        top: 4,
        right: 6,
        zIndex: 4,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 6px",
        borderRadius: 3,
        background: p.surface,
        border: `1px solid ${p.border}`,
        fontSize: 11,
        whiteSpace: "nowrap",
        maxWidth: "calc(100% - 12px)",
        overflow: "hidden"
    }),
    muted: (p: Palette): React.CSSProperties => ({ color: p.textMuted }),
    fitButton: (p: Palette): React.CSSProperties => ({
        padding: "0 7px",
        background: "transparent",
        color: p.textMuted,
        border: `1px solid ${p.border}`,
        borderRadius: 3,
        cursor: "pointer",
        font: "inherit"
    }),
    svg: {
        display: "block",
        // Dragging the background pans; without this the browser starts a text selection instead.
        userSelect: "none",
        touchAction: "none"
    } as React.CSSProperties,
    empty: (p: Palette): React.CSSProperties => ({
        padding: 16,
        color: p.textMuted
    }),
    card: (p: Palette): React.CSSProperties => ({
        position: "absolute",
        zIndex: 5,
        // A card the pointer can land on flickers as the mouse crosses onto it.
        pointerEvents: "none",
        padding: "7px 9px",
        background: p.surface,
        border: `1px solid ${p.border}`,
        borderRadius: 4,
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
        fontSize: 11,
        lineHeight: 1.45
    }),
    cardName: (p: Palette): React.CSSProperties => ({
        color: p.text,
        fontWeight: 600,
        wordBreak: "break-word"
    }),
    cardMeta: (p: Palette): React.CSSProperties => ({
        color: p.textMuted,
        marginBottom: 4
    }),
    cardBadge: (p: Palette): React.CSSProperties => ({
        color: p.warning,
        marginBottom: 4
    }),
    cardDoc: (p: Palette, present: boolean): React.CSSProperties => ({
        color: present ? p.text : p.textMuted,
        fontStyle: present ? "normal" : "italic",
        borderTop: `1px solid ${p.border}`,
        paddingTop: 4,
        // Documentation is written as prose with real line breaks; keep them.
        whiteSpace: "pre-wrap",
        maxHeight: 150,
        overflow: "hidden"
    })
};
