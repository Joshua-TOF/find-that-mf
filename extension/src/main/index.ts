/**
 * The `main` entry point: registration, and sole ownership of the graph index.
 *
 * `main.js`, `pane.js` and `graph.js` are loaded independently by Studio Pro, so they are separate
 * module instances with no shared memory. If each UI entry point built its own index, the expensive
 * model sweep would run twice and drift apart. So the index lives here, and the UI asks for slices
 * of it over `ui.messagePassing`.
 */

import { getStudioProApi, type ComponentContext, type IComponent } from "@mendix/extensions-api";

import { createDiagnostics, type Diagnostics } from "../graph/diagnostics.js";
import { GraphIndex } from "../graph/index.js";
import { isRequest, type Request, type ResponseFor } from "../graph/protocol.js";
import { readNodes, scanOne, scanUnits, type SourceMap, type UnitSource } from "../graph/scan.js";
import type { GraphNode, IndexStatus, ScannedUnitType, ViewState } from "../graph/types.js";

type StudioPro = ReturnType<typeof getStudioProApi>;

const PANE_TITLE = "Find that MF";

/**
 * Model edits arrive in bursts — placing one activity fires several change events — so refreshes
 * are debounced rather than run per event.
 */
const REFRESH_DEBOUNCE_MS = 750;

/**
 * Show the pane in the bottom dock at startup rather than waiting to be asked.
 *
 * Set to false to go back to opening only from the Extensions menu or the App Explorer context
 * menu. A constant rather than a setting because Studio Pro gives an extension nowhere to keep one:
 * `app.files` can write a file at the app root but cannot read it back.
 */
const AUTO_OPEN_PANE = true;

/**
 * The view state, owned here rather than in the pane that displays it.
 *
 * `main` and the pane are separate module instances with no shared memory, so anything they both
 * need lives here. Parking it in `main` also means the pane can ask for the current state the
 * moment it opens instead of sitting blank, and the state survives the pane being closed and
 * reopened.
 */
class ViewStore {
    private state: ViewState = {
        mode: "focus",
        focus: null,
        hiddenModules: []
    };

    constructor(private readonly onChange: (view: ViewState) => void) {}

    get(): ViewState {
        return this.state;
    }

    /** Applies a patch and broadcasts, but only if something actually changed. */
    set(patch: Partial<ViewState>): ViewState {
        const next = { ...this.state, ...patch };
        if (sameView(this.state, next)) return this.state;
        this.state = next;
        this.onChange(this.state);
        return this.state;
    }
}

function sameView(a: ViewState, b: ViewState): boolean {
    return (
        a.mode === b.mode &&
        a.focus === b.focus &&
        a.hiddenModules.length === b.hiddenModules.length &&
        a.hiddenModules.every((name, i) => name === b.hiddenModules[i])
    );
}

/* -------------------------------------------------------------------------- */
/* Index ownership                                                            */
/* -------------------------------------------------------------------------- */

class IndexOwner {
    private readonly index = new GraphIndex();
    private sources: SourceMap = {};
    private status: IndexStatus = {
        phase: "idle",
        revision: 0,
        done: 0,
        total: 0,
        nodeCount: 0,
        edgeCount: 0
    };

    /** Collapses concurrent callers onto one build rather than starting a second sweep. */
    private building: Promise<void> | null = null;
    /**
     * Resolves as soon as the *node* list is read, long before the edge sweep finishes.
     *
     * The whole point of the phased load is that search and the document list work immediately.
     * If every request waited for the full sweep, a large app would show an empty pane for the
     * thirty seconds the sweep takes, which is the failure this split exists to prevent.
     */
    private nodesReady: Promise<void> | null = null;
    private resolveNodesReady: (() => void) | null = null;
    /** Bumped on rescan so an in-flight sweep can notice it is stale and bail out. */
    private generation = 0;
    /**
     * The revision the UIs are told about.
     *
     * `GraphIndex.revision` advances once per scanned document, which is the right granularity for
     * the index and completely wrong to publish: the initial sweep would push a new revision a
     * hundred times and every UI keyed on it would refetch and re-run its layout a hundred times.
     * So this only advances at points where a UI genuinely needs to look again — the sweep
     * finishing, and each incremental refresh after an edit.
     */
    private publishedRevision = 0;
    /** Documents changed while a sweep was running, re-scanned once it finishes. */
    private readonly dirty = new Set<string>();

    constructor(
        private readonly studioPro: StudioPro,
        private readonly diagnostics: Diagnostics,
        private readonly onStatus: (status: IndexStatus) => void
    ) {}

    getStatus(): IndexStatus {
        return this.status;
    }

    getIndex(): GraphIndex {
        return this.index;
    }

    /** True while the caller side of the graph is still incomplete. */
    get callersPartial(): boolean {
        return this.status.phase !== "ready";
    }

    /**
     * Starts the build if it has not started, and resolves once the *node list* exists.
     *
     * This is what most requests should await: search, the document list and the callee side of a
     * focus graph all work from nodes plus a single on-demand load.
     *
     * Deliberately *not* called from `component.loaded()`. Model calls during Studio Pro's startup
     * are rejected by the backend with "Response code: 400" — the model is not ready to serve
     * requests that early. The first pane open is the earliest safe moment.
     */
    async ensureNodes(): Promise<void> {
        this.start();
        return this.nodesReady ?? Promise.resolve();
    }

    /**
     * Resolves only once the caller index is complete.
     *
     * Reserve this for the two answers that are simply wrong without a full sweep: the unused
     * report and the whole-app module map.
     */
    async ensureComplete(): Promise<void> {
        this.start();
        return this.building ?? Promise.resolve();
    }

    private start(): void {
        if (this.status.phase === "ready" || this.building !== null) return;

        this.nodesReady = new Promise<void>(resolve => {
            this.resolveNodesReady = resolve;
        });
        this.building = this.build().finally(() => {
            this.building = null;
            // A build that failed before reading nodes must still release its waiters, or every
            // request after it hangs forever.
            this.releaseNodes();
        });
    }

    private releaseNodes(): void {
        this.resolveNodesReady?.();
        this.resolveNodesReady = null;
    }

    /** Discards everything and rebuilds from scratch. */
    async rescan(): Promise<void> {
        this.generation++;
        this.releaseNodes();
        this.building = null;
        this.nodesReady = null;
        this.publishedRevision = this.index.revision;
        this.status = {
            phase: "idle",
            revision: this.publishedRevision,
            done: 0,
            total: 0,
            nodeCount: 0,
            edgeCount: 0
        };
        this.sources = {};
        this.dirty.clear();
        await this.ensureNodes();
    }

    /**
     * Publishes a status change, always carrying the index's current revision.
     *
     * Reading the revision here rather than asking callers to pass it means no mutation can be
     * published without its version, which is what the UIs key their refreshes on.
     */
    private setStatus(patch: Partial<IndexStatus>): void {
        this.status = { ...this.status, ...patch, revision: this.publishedRevision };
        this.onStatus(this.status);
    }

    /** Marks the content as changed for anyone watching, then publishes. */
    private publishContentChange(patch: Partial<IndexStatus> = {}): void {
        this.publishedRevision = this.index.revision;
        this.setStatus(patch);
    }

    private async build(): Promise<void> {
        const generation = ++this.generation;
        const isStale = (): boolean => generation !== this.generation;

        try {
            this.sources = buildSourceMap(this.studioPro);
            this.diagnostics.log(
                `build gen ${generation}: ${Object.keys(this.sources).length} model sources`
            );

            // Phase 1 — node index. Cheap: getUnitsInfo does not load unit bodies, so search and
            // the node list are usable within a round trip or two.
            this.setStatus({ phase: "nodes", done: 0, total: 0 });
            const nodes = await readNodes(this.sources);
            if (isStale()) return;
            this.diagnostics.log(`read ${nodes.length} nodes`);

            this.index.setNodes(nodes);
            this.publishContentChange({
                phase: "edges",
                total: nodes.length,
                nodeCount: this.index.nodeCount
            });
            // Search is usable from here on; the rest of build() only improves the caller side.
            this.releaseNodes();

            // Phase 2 — the expensive sweep. Only *callers* need it; callees are one load away.
            // Results are applied per unit rather than at the end, so the caller side fills in
            // progressively instead of appearing all at once when the sweep completes.
            await scanUnits(
                this.sources,
                nodes,
                name => this.index.has(name),
                (qualifiedName, edges, facts) => {
                    if (isStale()) return;
                    this.index.applyUnitScan(
                        qualifiedName,
                        edges,
                        facts.markedAsUsed,
                        facts.documentation
                    );
                },
                (done, total) => {
                    if (isStale()) return;
                    this.setStatus({ done, total, edgeCount: this.index.edgeCount });
                },
                isStale
            );
            if (isStale()) return;

            this.publishContentChange({
                phase: "ready",
                done: nodes.length,
                total: nodes.length,
                nodeCount: this.index.nodeCount,
                edgeCount: this.index.edgeCount
            });

            this.diagnostics.log(
                `sweep complete: ${this.index.nodeCount} nodes, ${this.index.edgeCount} edges`
            );
            await this.drainDirty();
        } catch (error) {
            if (isStale()) return;
            this.setStatus({ phase: "error", error: this.diagnostics.fail("index build", error) });
        }
    }

    /** Queues a document for re-scan, or does it now if the index is idle. */
    markDirty(qualifiedNames: readonly string[]): void {
        for (const name of qualifiedNames) this.dirty.add(name);
        if (this.status.phase === "ready") void this.drainDirty();
    }

    /**
     * Re-scans changed documents one at a time.
     *
     * Whole-index rebuilds on every edit would make the extension unusable while you work, and a
     * single document's outgoing edges are entirely determined by its own body — so a targeted
     * re-scan is both cheap and correct. `applyUnitScan` replaces rather than merges, so a removed
     * call really disappears.
     */
    private async drainDirty(): Promise<void> {
        if (this.dirty.size === 0) return;

        const pending = [...this.dirty];
        this.dirty.clear();

        for (const qualifiedName of pending) {
            const node = this.index.getNode(qualifiedName);
            if (node === undefined) continue;

            const source = this.sources[node.type as ScannedUnitType];
            if (source === undefined) continue;

            try {
                const scan = await scanOne(source, node, name => this.index.has(name));
                if (scan === null) {
                    // The unit is gone — deleted since the change event fired.
                    this.index.removeNode(qualifiedName);
                    continue;
                }
                this.index.applyUnitScan(
                    qualifiedName,
                    scan.edges,
                    scan.facts.markedAsUsed,
                    scan.facts.documentation
                );
            } catch (error) {
                console.warn(
                    "[find-that-mf] refresh failed for " + qualifiedName + ": " + describe(error)
                );
            }
        }

        // Publishes unconditionally: the counts may be identical after an edit that only rewired
        // existing edges, but the content has moved and the UIs need to hear about it.
        this.publishContentChange({
            nodeCount: this.index.nodeCount,
            edgeCount: this.index.edgeCount
        });
        this.diagnostics.log(
            `refreshed ${pending.length} document(s), revision now ${this.index.revision}`
        );
    }

    /**
     * Ensures one document's outgoing edges are known, without waiting for the whole sweep.
     *
     * This is what makes "what does this call?" instant on a cold index: the callees of X come
     * from loading X alone.
     */
    async ensureCallees(qualifiedName: string): Promise<void> {
        const node = this.index.getNode(qualifiedName);
        if (node === undefined || node.scanned) return;

        const source = this.sources[node.type as ScannedUnitType];
        if (source === undefined) return;

        try {
            const scan = await scanOne(source, node, name => this.index.has(name));
            if (scan !== null) {
                this.index.applyUnitScan(
                    qualifiedName,
                    scan.edges,
                    scan.facts.markedAsUsed,
                    scan.facts.documentation
                );
            }
        } catch (error) {
            console.warn(
                "[find-that-mf] on-demand scan failed for " + qualifiedName + ": " + describe(error)
            );
        }
    }
}

/**
 * Maps each scanned unit type to the model API that can load it.
 *
 * A missing entry degrades the graph rather than breaking it — `readNodes` and `scanUnits` skip
 * types with no source — which is the behaviour we want if a future Studio Pro renames one.
 */
function buildSourceMap(studioPro: StudioPro): SourceMap {
    const model = studioPro.app.model as unknown as Record<string, unknown>;

    const pick = (name: string): UnitSource<unknown> | undefined => {
        const api = model[name];
        if (api === undefined || api === null) return undefined;
        const candidate = api as Partial<UnitSource<unknown>>;
        if (typeof candidate.getUnitsInfo !== "function") return undefined;
        if (typeof candidate.loadAll !== "function") return undefined;
        return api as UnitSource<unknown>;
    };

    const byType: Record<ScannedUnitType, string> = {
        "Microflows$Microflow": "microflows",
        "Microflows$Nanoflow": "nanoflows",
        "Microflows$Rule": "rules",
        "Pages$Page": "pages",
        "Pages$Snippet": "snippets",
        "Pages$Layout": "layouts",
        "Pages$PageTemplate": "pageTemplates",
        "Pages$BuildingBlock": "buildingBlocks",
        "Menus$MenuDocument": "menuDocuments",
        "Workflows$Workflow": "workflows",
        "ScheduledEvents$ScheduledEvent": "scheduledEvents",
        "DomainModels$DomainModel": "domainModels",
        "Rest$PublishedRestService": "publishedRestServices",
        "Rest$ConsumedODataService": "consumedODataServices",
        "WebServices$ImportedWebService": "importedWebServices",
        "BusinessEvents$BusinessEventService": "businessEventServices",
        "ODataPublish$PublishedODataService2": "publishedODataServices2",
        "WebServices$PublishedWebService": "publishedWebServices",
        "DocumentTemplates$DocumentTemplate": "documentTemplates",
        "ImportMappings$ImportMapping": "importMappings",
        "ExportMappings$ExportMapping": "exportMappings"
    };

    const sources: SourceMap = {};
    for (const [type, apiName] of Object.entries(byType)) {
        const source = pick(apiName);
        if (source !== undefined) sources[type as ScannedUnitType] = source;
    }
    return sources;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export const component: IComponent = {
    async loaded(componentContext: ComponentContext): Promise<void> {
        // supportsHeadless is false in the manifest, so this should not fire. Guarding anyway:
        // StudioProApiHeadless has no `ui`, and touching it would throw rather than degrade.
        if (componentContext.runMode === "headless") return;

        const studioPro = getStudioProApi(componentContext);

        // `componentDescriptor` is "<component_name>/<entry_point_name>". Deriving the component
        // name from it beats hardcoding "extension/find-that-mf", which silently breaks if the
        // deployed directory is ever renamed.
        const descriptor = componentContext.componentDescriptor;
        const componentName = descriptor.slice(0, descriptor.lastIndexOf("/"));

        const diagnostics = createDiagnostics(studioPro.app.files, Date.now(), "main");
        diagnostics.log(`loaded: descriptor=${descriptor} component=${componentName}`);

        // Set by the first request from the pane's web view, which it sends as it mounts. That is
        // the only evidence `main` gets that the pane is actually on screen - see scheduleAutoOpen.
        let paneReportedIn = false;

        const owner = new IndexOwner(studioPro, diagnostics, status => {
            void studioPro.ui.messagePassing.sendMessage({
                kind: "mf:push-status" as const,
                status
            });
        });

        const view = new ViewStore(next => {
            void studioPro.ui.messagePassing.sendMessage({
                kind: "mf:push-view" as const,
                view: next
            });
        });

        // Every registration is wrapped: a Studio Pro build that has renamed or removed one of
        // these APIs should cost that one feature, not the whole extension.
        const paneHandle = await diagnostics.step("panes.register", () =>
            studioPro.ui.panes.register(
                {
                    title: PANE_TITLE,
                    // Bottom dock, alongside History / Changes / Errors / Console / Find Results.
                    initialPosition: "bottom"
                },
                { componentName, uiEntrypoint: "pane" }
            )
        );
        if (paneHandle !== undefined) {
            diagnostics.log(`pane id=${paneHandle.id}`);
            if (AUTO_OPEN_PANE) {
                scheduleAutoOpen(studioPro, paneHandle.id, diagnostics, () => paneReportedIn);
            }
            const show = createShowAction(studioPro, owner, view, diagnostics, paneHandle.id);
            await diagnostics.step("extensionsMenu.add", () =>
                registerMenus(studioPro, show, paneHandle.id)
            );
            await diagnostics.step("contextMenus", () => registerContextMenus(studioPro, show));

        }

        await diagnostics.step("focusFollowing", async () => registerFocusFollowing(studioPro, diagnostics));
        await diagnostics.step("changeTracking", async () => registerChangeTracking(studioPro, owner));

        await diagnostics.step("messageHandler", () =>
            studioPro.ui.messagePassing.addMessageHandler<unknown>(async info => {
                if (!isRequest(info.message)) return;
                paneReportedIn = true;
                const kind = info.message.kind;
                try {
                    const answer = await handleRequest(
                        studioPro,
                        owner,
                        view,
                        paneHandle?.id,
                        info.message
                    );
                    await studioPro.ui.messagePassing.sendResponse(info.messageId, answer);
                } catch (error) {
                    diagnostics.fail(`request ${kind}`, error);
                }
            })
        );

        diagnostics.log("registration finished");
        await diagnostics.flush();
    }
};

/**
 * "Show in Find that MF": focus a document, then bring up both halves of the tool.
 *
 * Sets the focus, then shows the pane — which is where the graph lives.
 *
 * Studio Pro identifies the right-clicked document by id rather than by name, which is why the index
 * keeps an id lookup. The focus is set directly rather than broadcast as a focus *suggestion*, so an
 * explicit menu choice overrides a pinned pane - the user has just said which microflow they want.
 */
function createShowAction(
    studioPro: StudioPro,
    owner: IndexOwner,
    view: ViewStore,
    diagnostics: Diagnostics,
    paneId: string
): (documentId?: string) => Promise<void> {
    return async (documentId?: string): Promise<void> => {
        try {
            if (documentId !== undefined) {
                // The id lookup needs the node list, and a menu click is often the first thing to
                // ask for it.
                await owner.ensureNodes();
                const node = owner.getIndex().getNodeById(documentId);
                if (node === undefined) {
                    diagnostics.log(`show: unknown document id ${documentId}`);
                } else {
                    diagnostics.log(`show: focusing ${node.qualifiedName}`);
                    view.set({ focus: node.qualifiedName, mode: "focus" });
                }
            }

            await studioPro.ui.panes.open({ id: paneId });
        } catch (error) {
            diagnostics.fail("show action", error);
        }
    };
}

async function registerMenus(
    studioPro: StudioPro,
    show: (documentId?: string) => Promise<void>,
    paneId: string
): Promise<void> {
    await studioPro.ui.extensionsMenu.add({
        menuId: "findthatmf.Menu",
        caption: PANE_TITLE,
        subMenus: [
            {
                menuId: "findthatmf.OpenGraph",
                caption: "Show microflow graph",
                action: async () => {
                    await show();
                }
            }
        ]
    });
}

/**
 * Right-click entry points, on documents in App Explorer and inside a microflow editor.
 *
 * The menu hands over the document that was right-clicked; using it is the whole difference between
 * "open the tool" and "show me this microflow".
 */
async function registerContextMenus(
    studioPro: StudioPro,
    show: (documentId?: string) => Promise<void>
): Promise<void> {
    for (const documentType of ["Microflows$Microflow", "Microflows$Nanoflow", "Microflows$Rule"]) {
        await studioPro.ui.appExplorer.addContextMenu(
            {
                menuId: "findthatmf.Explorer." + documentType,
                caption: "Show in " + PANE_TITLE,
                action: async (context: { documentId: string }) => {
                    await show(context.documentId);
                }
            },
            documentType
        );
    }

    await studioPro.ui.documents.addContextMenu(
        {
            menuId: "findthatmf.Document.Microflow",
            caption: "Show in " + PANE_TITLE,
            action: async (context: { documentId: string }) => {
                await show(context.documentId);
            }
        },
        "Microflows$Microflow"
    );
}

/** Pushes the active document to the pane so the graph follows what you are editing. */
function registerFocusFollowing(studioPro: StudioPro, diagnostics: Diagnostics): void {
    studioPro.ui.editors.addEventListener("activeDocumentChanged", ({ info }) => {
        diagnostics.log(
            `activeDocumentChanged: ${info === null ? "(none)" : `${info.documentType} ${info.moduleName ?? ""}.${info.documentName ?? ""}`}`
        );
        const focus =
            info === null || info.documentName === null
                ? null
                : info.moduleName === null || info.moduleName === ""
                  ? info.documentName
                  : info.moduleName + "." + info.documentName;

        void studioPro.ui.messagePassing.sendMessage({ kind: "mf:push-focus" as const, focus });
    });
}

/**
 * Keeps the index current while the user works.
 *
 * Both listeners debounce into one drain because model edits arrive in bursts.
 */
function registerChangeTracking(studioPro: StudioPro, owner: IndexOwner): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queued: string[] = [];

    const schedule = (names: readonly string[]): void => {
        queued.push(...names);
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            const batch = queued;
            queued = [];
            owner.markDirty(batch);
        }, REFRESH_DEBOUNCE_MS);
    };

    studioPro.app.projectChanges.addEventListener("documentsChanged", ({ documents }) => {
        schedule(documents.map(toQualifiedName).filter(isString));
    });

    studioPro.app.projectChanges.addEventListener("elementsRenamed", ({ elements }) => {
        // A rename changes identity, and a *module* rename arrives as one event that does not
        // enumerate the documents inside it. Both old and new names are queued; whichever no
        // longer resolves gets dropped by the drain.
        const names: string[] = [];
        for (const element of elements) {
            names.push(element.oldName.qualifiedName, element.newName.qualifiedName);
        }
        schedule(names);
    });
}

function toQualifiedName(document: {
    documentName: string | null;
    moduleName?: string | null;
}): string | null {
    if (document.documentName === null) return null;
    const moduleName = document.moduleName ?? "";
    return moduleName === "" ? document.documentName : moduleName + "." + document.documentName;
}

/* -------------------------------------------------------------------------- */
/* Request handling                                                           */
/* -------------------------------------------------------------------------- */

async function handleRequest(
    studioPro: StudioPro,
    owner: IndexOwner,
    view: ViewStore,
    paneId: string | undefined,
    message: Request
): Promise<ResponseFor[Request["kind"]]> {
    const index = owner.getIndex();

    switch (message.kind) {
        case "mf:status":
            // Kicks the build without waiting; progress arrives as pushes.
            void owner.ensureNodes();
            return owner.getStatus();

        case "mf:rescan":
            void owner.rescan();
            return owner.getStatus();

        case "mf:search":
            // Nodes only. Waiting for the sweep here would make search unusable on a large app
            // for exactly as long as the sweep takes.
            await owner.ensureNodes();
            return index.search(message.query, message.limit);

        case "mf:ego": {
            await owner.ensureNodes();
            // Guarantee the focus's own callees even if the sweep has not reached it yet, so the
            // downstream half of the graph is never spuriously empty. The caller side may still be
            // partial, which `callersPartial` tells the UI to say out loud.
            await owner.ensureCallees(message.focus);
            return index.ego(message.focus, owner.callersPartial);
        }

        case "mf:app-graph":
            // A whole-app graph built from a half-swept index would under-report every dependency,
            // so this is the one view worth waiting for.
            await owner.ensureComplete();
            return index.appGraph(view.get().hiddenModules);

        case "mf:modules":
            // Nodes only: the module list is for the filter checkboxes, which should appear
            // immediately. Orphan counts fill in once the sweep lands.
            await owner.ensureNodes();
            return index.moduleSummaries();

        case "mf:view":
            return view.get();

        case "mf:set-view":
            return view.set(message.patch);

        case "mf:node":
            // One document, for the pane to name the current focus. The ego graph would answer this
            // too, but it is unbounded now - fetching a whole reachable subgraph to render one row
            // would be absurd.
            await owner.ensureNodes();
            {
                const node = index.getNode(message.qualifiedName);
                return node === undefined ? null : index.summarise(node);
            }

        case "mf:open":
            await owner.ensureNodes();
            return openDocument(studioPro, index.getNode(message.qualifiedName), message.elementId);
    }
}

/**
 * Puts the pane in the bottom dock at startup, so it is there to click without going through the
 * Extensions menu first.
 *
 * Two things make this less obvious than it looks.
 *
 * **`open` does nothing if called too early.** From inside `loaded()` it resolves without error and
 * the dock never appears; the docking layout does not exist yet. So the call has to be deferred, and
 * there is no "shell is ready" event to hang it on.
 *
 * **There is no way to ask whether the pane is already showing.** `IDockablePaneApi` is
 * `register` / `open` / `close` and nothing else, and `main` runs outside a web view - no
 * `window`, no `localStorage` - so it cannot remember across restarts that it has done this
 * before either.
 *
 * So instead of guessing one delay, this retries until the pane proves it is alive: the pane's web
 * view asks `main` for state the moment it mounts, and `hasReportedIn` reports that first request.
 * Once it does, the remaining attempts are skipped, and if they all fail it gives up rather than
 * retrying forever - the Extensions menu and the App Explorer context menu still work.
 *
 * **This does mean the pane takes focus in the bottom dock on every launch**, which is not quite
 * what "available but not necessarily open" asks for. It is the best the API allows. `register`
 * mints a fresh pane GUID every launch and `DockablePaneInfo` has no `id` to pin, so Studio Pro's
 * saved layout - which refers to tool windows by GUID - can never restore this pane by itself. Each
 * launch it is a brand new tool window that has never been docked before, so "leave the user's
 * arrangement alone" is not an option that exists: either we open it, or it is not there. Set
 * `AUTO_OPEN_PANE` to false to choose the latter.
 */
function scheduleAutoOpen(
    studioPro: StudioPro,
    paneId: string,
    diagnostics: Diagnostics,
    hasReportedIn: () => boolean
): void {
    // Spread out rather than tight: a cold Studio Pro start on a large app is slow, and each
    // attempt is only skipped work once the pane is up.
    const attempts = [400, 1_500, 4_000, 10_000, 20_000];

    for (const delay of attempts) {
        setTimeout(() => {
            if (hasReportedIn()) return;
            void studioPro.ui.panes
                .open({ id: paneId })
                .catch(error => diagnostics.fail(`auto-open at ${delay}ms`, error));
        }, delay);
    }
}

/**
 * Opens a document, focusing the referencing element when we have one.
 *
 * The element id is what turns "open the caller" into "show me the exact call activity", which is
 * the difference between this and reading a list of names.
 */
async function openDocument(
    studioPro: StudioPro,
    node: GraphNode | undefined,
    elementId: string | null
): Promise<{ ok: boolean; error?: string }> {
    if (node === undefined) return { ok: false, error: "Unknown document" };

    try {
        if (elementId === null) await studioPro.ui.editors.editDocument({ id: node.id });
        else await studioPro.ui.editors.editDocument({ id: node.id }, { id: elementId });
        return { ok: true };
    } catch (error) {
        // A stale element id (the activity was deleted since the scan) must still open the
        // document rather than failing outright.
        if (elementId !== null) {
            try {
                await studioPro.ui.editors.editDocument({ id: node.id });
                return { ok: true };
            } catch {
                /* fall through to the original error */
            }
        }
        return { ok: false, error: describe(error) };
    }
}

/* -------------------------------------------------------------------------- */

function isString(value: string | null): value is string {
    return value !== null;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
