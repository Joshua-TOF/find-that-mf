/**
 * The bottom-dock pane: search, every control that drives the graph, and the graph itself.
 *
 * This is the control surface. The graph renders whatever view state `main` holds; the pane is
 * what changes it. Keeping the controls here rather than in a toolbar above the canvas means they
 * stay put while you pan, and the graph gets the whole working area.
 *
 * Deliberately *not* a second view of the graph. It used to carry a caller/callee tree and an unused
 * report; both were removed, because the graph itself answers those questions better and a narrow
 * column was never going to beat it. What is left is what a graph cannot do for itself: find a
 * microflow, say which one is focused, and decide what gets drawn.
 *
 * **Laid out for a wide, short dock**, alongside Errors and Console: one toolbar row, a capped
 * strip of chips, then the graph. The previous left-dock version stacked everything into a column,
 * which down here would scroll after four entries with most of the width empty.
 *
 * The graph used to live in a working-area tab instead. It now renders here, and the tab is gone —
 * two copies of the same graph on screen at once was worse than either alone.
 */

import { getStudioProApi, type ComponentContext, type IComponent } from "@mendix/extensions-api";
import * as React from "react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { createDiagnostics, type Diagnostics } from "../graph/diagnostics.js";
import { request } from "../graph/protocol.js";
import type { MessageChannel, Push } from "../graph/protocol.js";
import { isPush } from "../graph/protocol.js";
import type { IndexStatus, ModuleSummary, NodeSummary, ViewState } from "../graph/types.js";
import { GraphView } from "./graph-view.js";
import {
    KIND_LABEL,
    badgeFor,
    createModuleColours,
    displayName,
    paletteFor,
    type Palette
} from "./theme.js";

type StudioPro = ReturnType<typeof getStudioProApi>;
type Theme = "Light" | "Dark";

const SEARCH_LIMIT = 40;
const SEARCH_DEBOUNCE_MS = 180;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export const component: IComponent = {
    async loaded(componentContext: ComponentContext): Promise<void> {
        const studioPro = getStudioProApi(componentContext);
        // Studio Pro supplies the host page. Without an explicit height on every ancestor the pane
        // collapses to its content and the scroll region never appears.
        const root = document.getElementById("root");
        if (root === null) return;
        for (const element of [document.documentElement, document.body, root]) {
            element.style.height = "100%";
            element.style.margin = "0";
        }

        const diagnostics = createDiagnostics(studioPro.app.files, Date.now(), "pane");
        diagnostics.log("pane entry point loaded");
        window.addEventListener("error", event => {
            diagnostics.fail("window error", event.error ?? event.message);
            void diagnostics.flush();
        });
        window.addEventListener("unhandledrejection", event => {
            diagnostics.fail("unhandled rejection", event.reason);
            void diagnostics.flush();
        });

        const preferences = await studioPro.ui.preferences.getPreferences();
        diagnostics.log(`theme=${preferences.theme} version=${preferences.version}`);
        await diagnostics.flush();

        createRoot(root).render(
            <StrictMode>
                <Pane
                    studioPro={studioPro}
                    theme={preferences.theme}
                    diagnostics={diagnostics}
                />
            </StrictMode>
        );
    }
};

/* -------------------------------------------------------------------------- */
/* Pane                                                                       */
/* -------------------------------------------------------------------------- */

function Pane({
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
    // every effect that depends on it then re-runs on every render.
    const channel = useMemo(
        () => studioPro.ui.messagePassing as unknown as MessageChannel,
        [studioPro]
    );
    const palette = useMemo(() => paletteFor(theme), [theme]);

    const [status, setStatus] = useState<IndexStatus | null>(null);
    const [view, setView] = useState<ViewState | null>(null);
    const [pinned, setPinned] = useState(false);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<readonly NodeSummary[]>([]);
    const [focused, setFocused] = useState<NodeSummary | null>(null);
    const [modules, setModules] = useState<readonly ModuleSummary[]>([]);
    const [error, setError] = useState<string | null>(null);

    // Read inside the push handler, which is registered once and would otherwise close over the
    // initial value forever.
    const pinnedRef = useRef(pinned);
    pinnedRef.current = pinned;

    const patchView = useCallback(
        (patch: Partial<ViewState>) => {
            void request(channel, { kind: "mf:set-view", patch })
                .then(setView)
                .catch((cause: unknown) => setError(describe(cause)));
        },
        [channel]
    );

    /* --- wiring ---------------------------------------------------------- */

    useEffect(() => {
        let handler: { handlerId: string } | undefined;

        void studioPro.ui.messagePassing
            .addMessageHandler<unknown>(async info => {
                if (!isPush(info.message)) return;
                const push = info.message as Push;

                if (push.kind === "mf:push-status") {
                    setStatus(push.status);
                    return;
                }
                if (push.kind === "mf:push-view") {
                    setView(push.view);
                    return;
                }
                // A suggestion from the active editor, not a command. Pinning is what makes it
                // ignorable, and turning it into a view change here is what keeps `main` the single
                // owner of the focus.
                if (push.kind === "mf:push-focus" && !pinnedRef.current && push.focus !== null) {
                    void request(channel, {
                        kind: "mf:set-view",
                        patch: { focus: push.focus }
                    }).then(setView);
                }
            })
            .then(reference => {
                handler = reference;
            });

        // Kicks the index build. `main` may not have registered its handler yet, which is why
        // `request` retries rather than failing.
        void request(channel, { kind: "mf:status" })
            .then(setStatus)
            .catch((cause: unknown) => setError(describe(cause)));
        void request(channel, { kind: "mf:view" })
            .then(setView)
            .catch((cause: unknown) => setError(describe(cause)));

        return () => {
            if (handler !== undefined) void studioPro.ui.messagePassing.removeMessageHandler(handler);
        };
    }, [channel, studioPro]);

    /* --- data ------------------------------------------------------------ */

    const revision = status?.revision;
    const focus = view?.focus ?? null;
    const mode = view?.mode;

    useEffect(() => {
        if (query.trim() === "") {
            setResults([]);
            return;
        }
        const timer = setTimeout(() => {
            void request(channel, { kind: "mf:search", query, limit: SEARCH_LIMIT })
                .then(setResults)
                .catch((cause: unknown) => setError(describe(cause)));
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [channel, query]);

    // One document, not the whole focus graph. The graph fetches that; the pane only needs
    // enough to name what is focused and badge it.
    useEffect(() => {
        if (focus === null) {
            setFocused(null);
            return;
        }
        void request(channel, { kind: "mf:node", qualifiedName: focus })
            .then(setFocused)
            .catch((cause: unknown) => setError(describe(cause)));
    }, [channel, focus, revision]);

    useEffect(() => {
        void request(channel, { kind: "mf:modules" })
            .then(setModules)
            .catch((cause: unknown) => setError(describe(cause)));
    }, [channel, revision]);

    /* --- actions --------------------------------------------------------- */

    const chooseFocus = useCallback(
        (qualifiedName: string) => {
            setQuery("");
            setResults([]);
            patchView({ focus: qualifiedName });
        },
        [patchView]
    );

    const openDocument = useCallback(
        (qualifiedName: string) => {
            void request(channel, { kind: "mf:open", qualifiedName, elementId: null });
        },
        [channel]
    );

    const toggleModule = useCallback(
        (moduleName: string) => {
            const hidden = new Set(view?.hiddenModules ?? []);
            if (hidden.has(moduleName)) hidden.delete(moduleName);
            else hidden.add(moduleName);
            patchView({ hiddenModules: [...hidden].sort() });
        },
        [view, patchView]
    );

    const hidden = useMemo(() => new Set(view?.hiddenModules ?? []), [view]);
    // Same canonical order the graph uses, so a swatch here matches a node there.
    const colourOf = useMemo(
        () => createModuleColours(modules.map(entry => entry.name), theme),
        [modules, theme]
    );


    return (
        <div style={styles.root(palette)}>
            <div style={styles.bar(palette)}>
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search microflows…"
                    style={styles.input(palette)}
                    spellCheck={false}
                />

                <Divider palette={palette} />

                <TabButton
                    palette={palette}
                    active={mode === "focus"}
                    onClick={() => patchView({ mode: "focus" })}
                    label="Focus"
                />
                <TabButton
                    palette={palette}
                    active={mode === "app"}
                    onClick={() => patchView({ mode: "app" })}
                    label="Whole app"
                />
                {mode === "app" && (
                    <ModulePicker
                        palette={palette}
                        colourOf={colourOf}
                        modules={modules}
                        hidden={hidden}
                        onToggle={toggleModule}
                        onAll={() => patchView({ hiddenModules: [] })}
                        onNone={() => patchView({ hiddenModules: modules.map(entry => entry.name) })}
                    />
                )}

                {focused !== null && mode === "focus" && (
                    <>
                        <Divider palette={palette} />
                        <FocusChip
                            palette={palette}
                            colourOf={colourOf}
                            summary={focused}
                            pinned={pinned}
                            onPinned={setPinned}
                            onOpen={() => openDocument(focused.node.qualifiedName)}
                        />
                    </>
                )}

                <div style={{ flex: 1 }} />

                <Status palette={palette} status={status} error={error} />
                <button
                    type="button"
                    onClick={() => {
                        void request(channel, { kind: "mf:rescan" }).then(setStatus);
                    }}
                    style={styles.linkButton(palette)}
                >
                    Rescan
                </button>
            </div>

            <ProgressLine palette={palette} status={status} />

            {/* Chips get a capped strip of their own so they can never crowd out the graph. */}
            {results.length > 0 && (
                <div style={styles.chipStrip(palette)}>
                    <ResultChips
                        palette={palette}
                        colourOf={colourOf}
                        results={results}
                        onPick={chooseFocus}
                    />
                </div>
            )}
            {/*
                The graph, inline. The same component the working-area tab mounts — two separate
                WebViews with no shared memory, so each fetches its own copy either way.
            */}
            <div style={styles.canvas}>
                <GraphView studioPro={studioPro} theme={theme} diagnostics={diagnostics} />
            </div>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Module filter, behind a dropdown.
 *
 * It was a field of tick-box chips, which reads well on the five modules a blank app has and falls
 * apart on a real one: Atlas plus a handful of marketplace modules puts most apps past thirty, and
 * that many chips would fill a dock that is only a few rows tall before the graph got any of it.
 * A single button that states the count, opening a scrollable list with its own filter, costs one
 * click and stays the same size at any number of modules.
 *
 * The panel is capped against the pane's own height rather than a fixed pixel value — this thing
 * lives in a dock the user can drag to any height, including a very short one.
 */
function ModulePicker({
    palette,
    colourOf,
    modules,
    hidden,
    onToggle,
    onAll,
    onNone
}: {
    palette: Palette;
    colourOf: (moduleName: string) => string;
    modules: readonly ModuleSummary[];
    hidden: ReadonlySet<string>;
    onToggle: (moduleName: string) => void;
    onAll: () => void;
    onNone: () => void;
}): JSX.Element {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const anchorRef = useRef<HTMLSpanElement | null>(null);

    // Close on a click anywhere else. Registered only while open, so the listener is not sitting on
    // the document for the whole session.
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent): void => {
            if (anchorRef.current?.contains(event.target as Node) === true) return;
            setOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const shown = filter.trim() === ""
        ? modules
        : modules.filter(entry =>
              entry.name.toLowerCase().includes(filter.trim().toLowerCase())
          );

    const showing = modules.length - hidden.size;
    const label =
        hidden.size === 0
            ? `All ${modules.length} modules`
            : `${showing} of ${modules.length} modules`;

    return (
        <span ref={anchorRef} style={styles.anchor}>
            <button
                type="button"
                onClick={() => setOpen(current => !current)}
                title="Choose which modules appear in the graph"
                style={styles.tabButton(palette, hidden.size > 0)}
            >
                {label} {open ? "\u25B4" : "\u25BE"}
            </button>

            {open && (
                <div style={styles.popover(palette)}>
                    <div style={styles.popoverHead(palette)}>
                        <input
                            value={filter}
                            onChange={event => setFilter(event.target.value)}
                            placeholder="Filter…"
                            style={styles.filterInput(palette)}
                            spellCheck={false}
                            autoFocus
                        />
                        <button type="button" onClick={onAll} style={styles.linkButton(palette)}>
                            all
                        </button>
                        <button type="button" onClick={onNone} style={styles.linkButton(palette)}>
                            none
                        </button>
                    </div>

                    <div style={styles.popoverList}>
                        {shown.length === 0 && (
                            <div style={{ ...styles.muted(palette), padding: "4px 8px" }}>
                                No module matches.
                            </div>
                        )}
                        {shown.map(entry => (
                            <label key={entry.name} style={styles.pickerRow(palette)}>
                                <input
                                    type="checkbox"
                                    checked={!hidden.has(entry.name)}
                                    onChange={() => onToggle(entry.name)}
                                    style={styles.checkbox}
                                />
                                <span style={styles.swatch(colourOf(entry.name))} />
                                <span style={styles.pickerName(palette)}>
                                    {entry.name || "(project)"}
                                </span>
                                <span style={styles.count(palette)}>
                                    {entry.nodeCount}
                                    {entry.orphanCount > 0 ? ` · ${entry.orphanCount} unused` : ""}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>
            )}
        </span>
    );
}

/** Search hits, as wrapping chips for the same reason the modules are. */
function ResultChips({
    palette,
    colourOf,
    results,
    onPick
}: {
    palette: Palette;
    colourOf: (moduleName: string) => string;
    results: readonly NodeSummary[];
    onPick: (qualifiedName: string) => void;
}): JSX.Element {
    return (
        <>
            {results.map(summary => (
                <button
                    key={summary.node.qualifiedName}
                    type="button"
                    onClick={() => onPick(summary.node.qualifiedName)}
                    title={rowTooltip(summary)}
                    style={styles.chip(palette, false)}
                >
                    <span style={styles.swatch(colourOf(summary.node.module))} />
                    <span>{summary.node.name}</span>
                    <span style={styles.count(palette)}>{summary.node.module}</span>
                    <UsageBadge palette={palette} summary={summary} />
                </button>
            ))}
        </>
    );
}

/** The focused document, inline in the bar rather than on a row of its own. */
function FocusChip({
    palette,
    colourOf,
    summary,
    pinned,
    onPinned,
    onOpen
}: {
    palette: Palette;
    colourOf: (moduleName: string) => string;
    summary: NodeSummary;
    pinned: boolean;
    onPinned: (value: boolean) => void;
    onOpen: () => void;
}): JSX.Element {
    const name = displayName(summary.node);
    return (
        <>
            <span style={styles.swatch(colourOf(summary.node.module))} />
            <button
                type="button"
                onClick={onOpen}
                title={rowTooltip(summary)}
                style={styles.focusName(palette)}
            >
                {summary.node.name}
                <span style={styles.count(palette)}>{summary.node.module}</span>
            </button>
            <UsageBadge palette={palette} summary={summary} />
            <button
                type="button"
                onClick={() => onPinned(!pinned)}
                title={
                    pinned
                        ? `Pinned to ${name}. Opening other documents will not move the graph. Click to follow the editor again.`
                        : `Following the editor: opening a microflow moves the graph to it. Click to pin it to ${name} so you can browse elsewhere without losing your place.`
                }
                style={styles.pinButton(palette, pinned)}
            >
                {pinned ? "\u{1F4CC} Pinned" : "Following editor"}
            </button>
        </>
    );
}

/**
 * The badge that makes "Mark as used" visible.
 *
 * Rendered from the server-computed `usageState`, never re-derived here: whether something counts as
 * an orphan depends on the caller count *and* on whether the sweep has reached it, and a second
 * implementation of that rule is how a badge ends up contradicting itself.
 */
function UsageBadge({
    palette,
    summary
}: {
    palette: Palette;
    summary: NodeSummary;
}): JSX.Element | null {
    const badge = badgeFor(summary.usageState);
    if (badge === null) return null;
    return (
        <span title={badge.label} style={{ ...styles.badge, color: badge.colorOf(palette) }}>
            {badge.glyph}
        </span>
    );
}

/** One line of state, kept short enough to live in a toolbar. */
function Status({
    palette,
    status,
    error
}: {
    palette: Palette;
    status: IndexStatus | null;
    error: string | null;
}): JSX.Element {
    if (error !== null) return <span style={{ color: palette.warning }}>{error}</span>;
    if (status === null) return <span style={styles.muted(palette)}>Connecting…</span>;

    if (status.phase === "error") {
        return <span style={{ color: palette.warning }}>{status.error ?? "Indexing failed"}</span>;
    }
    if (status.phase === "ready") {
        return (
            <span style={styles.muted(palette)}>
                {status.nodeCount} documents · {status.edgeCount} references
            </span>
        );
    }
    return (
        <span style={styles.muted(palette)}>
            {status.phase === "nodes"
                ? "Reading document list…"
                : `Indexing callers… ${status.done} / ${status.total}`}
        </span>
    );
}

/** A hairline under the bar while the sweep runs. A bottom dock has no room for a real bar. */
function ProgressLine({
    palette,
    status
}: {
    palette: Palette;
    status: IndexStatus | null;
}): JSX.Element | null {
    if (status === null || status.phase === "ready" || status.phase === "error") return null;
    const fraction = status.total === 0 ? 0 : status.done / status.total;
    return (
        <div style={styles.progressTrack(palette)}>
            <div style={styles.progressFill(palette, fraction)} />
        </div>
    );
}

function TabButton({
    palette,
    active,
    onClick,
    label,
    title
}: {
    palette: Palette;
    active: boolean;
    onClick: () => void;
    label: string;
    title?: string;
}): JSX.Element {
    return (
        <button type="button" onClick={onClick} title={title} style={styles.tabButton(palette, active)}>
            {label}
        </button>
    );
}

function Divider({ palette }: { palette: Palette }): JSX.Element {
    return <span style={styles.divider(palette)} />;
}

/**
 * Tooltip for a chip.
 *
 * Includes the document's Documentation field when it has one, so the pane answers the same question
 * the graph's hover card does.
 */
function rowTooltip(summary: NodeSummary): string {
    const lines = [summary.node.qualifiedName, KIND_LABEL[summary.node.kind]];
    if (summary.node.documentation !== undefined) lines.push("", summary.node.documentation);
    return lines.join("\n");
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const styles = {
    root: (p: Palette): React.CSSProperties => ({
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: p.background,
        color: p.text,
        font: '12px/1.5 "Segoe UI", system-ui, sans-serif',
        overflow: "hidden"
    }),
    /** The one toolbar row. Wraps rather than clipping when the dock is narrow. */
    bar: (p: Palette): React.CSSProperties => ({
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        padding: "5px 10px",
        borderBottom: `1px solid ${p.border}`,
        background: p.surface,
        flex: "0 0 auto"
    }),
    /**
     * Chips live in a strip with a hard ceiling, scrolling past it.
     *
     * Without the cap, ticking a module list of thirty would push the graph out of a dock that is
     * only a few rows tall to begin with.
     */
    chipStrip: (p: Palette): React.CSSProperties => ({
        display: "flex",
        alignItems: "center",
        alignContent: "flex-start",
        flexWrap: "wrap",
        gap: 5,
        padding: "5px 10px",
        maxHeight: 66,
        overflowY: "auto",
        borderBottom: `1px solid ${p.border}`,
        flex: "0 0 auto"
    }),
    canvas: { flex: 1, minHeight: 0, position: "relative" } as React.CSSProperties,
    input: (p: Palette): React.CSSProperties => ({
        width: 190,
        boxSizing: "border-box",
        padding: "3px 6px",
        background: p.background,
        color: p.text,
        border: `1px solid ${p.border}`,
        borderRadius: 3,
        outline: "none",
        font: "inherit"
    }),
    divider: (p: Palette): React.CSSProperties => ({
        width: 1,
        height: 16,
        background: p.border,
        flex: "0 0 auto"
    }),
    /** Used for both module tick-boxes and search hits, so the two read as one family. */
    chip: (p: Palette, on: boolean): React.CSSProperties => ({
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        borderRadius: 10,
        border: `1px solid ${p.border}`,
        background: on ? p.surface : "transparent",
        color: on ? p.text : p.textMuted,
        cursor: "pointer",
        font: "inherit",
        whiteSpace: "nowrap"
    }),
    checkbox: { margin: 0, cursor: "pointer" } as React.CSSProperties,
    anchor: { position: "relative", display: "inline-flex" } as React.CSSProperties,
    popover: (p: Palette): React.CSSProperties => ({
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        zIndex: 20,
        width: 260,
        display: "flex",
        flexDirection: "column",
        background: p.surface,
        border: `1px solid ${p.border}`,
        borderRadius: 4,
        boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
        // Bounded by the pane, not by a guessed pixel height: the dock can be dragged very short.
        maxHeight: "calc(100vh - 48px)",
        overflow: "hidden"
    }),
    popoverHead: (p: Palette): React.CSSProperties => ({
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: 6,
        borderBottom: `1px solid ${p.border}`,
        flex: "0 0 auto"
    }),
    popoverList: { overflowY: "auto", padding: "3px 0" } as React.CSSProperties,
    filterInput: (p: Palette): React.CSSProperties => ({
        flex: 1,
        minWidth: 0,
        padding: "2px 5px",
        background: p.background,
        color: p.text,
        border: `1px solid ${p.border}`,
        borderRadius: 3,
        outline: "none",
        font: "inherit"
    }),
    pickerRow: (p: Palette): React.CSSProperties => ({
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        cursor: "pointer",
        color: p.text
    }),
    pickerName: (p: Palette): React.CSSProperties => ({
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: p.text
    }),
    swatch: (colour: string): React.CSSProperties => ({
        width: 10,
        height: 10,
        borderRadius: 2,
        flex: "0 0 auto",
        background: colour
    }),
    count: (p: Palette): React.CSSProperties => ({
        color: p.textMuted,
        fontSize: 10
    }),
    muted: (p: Palette): React.CSSProperties => ({
        color: p.textMuted,
        whiteSpace: "nowrap"
    }),
    focusName: (p: Palette): React.CSSProperties => ({
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: "transparent",
        border: "none",
        padding: 0,
        color: p.text,
        font: "inherit",
        fontWeight: 600,
        cursor: "pointer",
        maxWidth: 260,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
    }),
    badge: { flex: "0 0 auto", cursor: "help" } as React.CSSProperties,
    primaryButton: (p: Palette): React.CSSProperties => ({
        padding: "2px 10px",
        background: p.accent,
        color: "#ffffff",
        border: "none",
        borderRadius: 3,
        cursor: "pointer",
        font: "inherit"
    }),
    linkButton: (p: Palette): React.CSSProperties => ({
        background: "transparent",
        border: "none",
        color: p.textMuted,
        cursor: "pointer",
        font: "inherit",
        padding: "0 4px",
        textDecoration: "underline"
    }),
    pinButton: (p: Palette, pinned: boolean): React.CSSProperties => ({
        padding: "1px 6px",
        background: pinned ? p.pinned : "transparent",
        color: pinned ? p.background : p.textMuted,
        border: `1px solid ${p.border}`,
        borderRadius: 3,
        cursor: "pointer",
        font: "inherit",
        fontSize: 11,
        whiteSpace: "nowrap"
    }),
    tabButton: (p: Palette, active: boolean): React.CSSProperties => ({
        padding: "2px 9px",
        background: active ? p.accent : "transparent",
        color: active ? "#ffffff" : p.textMuted,
        border: `1px solid ${active ? p.accent : p.border}`,
        borderRadius: 3,
        cursor: "pointer",
        font: "inherit"
    }),
    progressTrack: (p: Palette): React.CSSProperties => ({
        height: 2,
        background: p.border,
        flex: "0 0 auto"
    }),
    progressFill: (p: Palette, fraction: number): React.CSSProperties => ({
        height: "100%",
        width: `${Math.round(fraction * 100)}%`,
        background: p.accent,
        transition: "width 120ms linear"
    })
};
