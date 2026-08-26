# Find That MF

A microflow call graph inside Mendix Studio Pro. Answers three questions without leaving the IDE:

- **What calls this microflow?** — including pages, scheduled events, workflows, published REST
  operations, entity event handlers and menu items, not just other microflows.
- **What does it call?**
- **Is anything calling it at all?** — with Mendix's **Mark as used** flag respected, so the report
  is safe to act on.

It ships as a **web extension** (TypeScript, Studio Pro 11's Extensibility API). The predecessor to
this tool parsed the `.mpr` SQLite file from outside Studio Pro; that is no longer necessary —
`studioPro.app.model.microflows` hands over fully typed units.

---

## Repository layout

```
extension/          the extension itself (TypeScript + React + esbuild)
  src/manifest.json entry points, as Studio Pro sees them
  src/main/         registration and the graph index (all model I/O lives here)
  src/graph/        scanner, index, wire protocol, shared types
  src/ui/           the bottom-dock pane: controls, and the graph it hosts
  test/             vitest, no Studio Pro required
testapp/            Mendix app for end-to-end checks - NOT in the repo, see below
tools/              launch scripts
.github/workflows/  CI: typecheck, test, build
```

---

## Install it in your own app

There is no packaged release yet, so it is a build-and-copy:

```powershell
cd extension
npm install
npm run build
```

That writes `extension\dist\find-that-mf\` and copies it into `<app>\extensions\find-that-mf\`.
Point it at the app you actually want with `MX_APP_DIR`:

```powershell
$env:MX_APP_DIR = "C:\Mendix\MyApp"
npm run build
```

Then launch that app with the extension flag — see *The flag that matters* below; without it Studio
Pro ignores the extension silently. `tools\run-studiopro.cmd -Mpr "C:\Mendix\MyApp\MyApp.mpr"` does
it for you, and finds the newest installed Studio Pro 11 on its own.

Everyone opening the app needs both the flag and a copy of `extensions\find-that-mf\`, which is why
the directory is usually git-ignored rather than committed. Packaging it as an add-on module removes
both requirements and is not done yet — see *Versions* at the end.

---

## Develop it

```powershell
cd extension
npm install
npm run build          # once
npm run build:dev      # watch, redeploying on every change
npm test               # 73 unit tests, no Studio Pro needed
cd ..
.\run-testapp.cmd      # build, then launch Studio Pro on testapp\
```

---

### Recreating the test app

The test app is **not** in this repository — it is ~19 MB of binary `.mxunit` files that Studio Pro
rewrites on every open, which is a lot of churn for something rebuildable in ten minutes. The build
deploys to `..\testapp` by default, so putting one there needs no configuration.

```powershell
& "C:\Program Files\Mendix\11.12.0\modeler\mx.exe" create-project --output-dir .\testapp MfGraphTestApp
```

Then hand-build the fixture in `MyFirstModule`, which is what the checks below assume — seven empty
microflows wired into a shape that exercises the awkward cases:

```
A ──► A1 ──┐
│          ├──► B ──► C ──┬──► C1
└──► A2 ───┘              └──► C2 ──┐
      ▲                             │
      └─────────────────────────────┘   C2 ──► A closes a cycle
```

- **Fan-out then fan-in** (`A` splits to `A1`/`A2`, both reach `B`) — a node reachable by two paths
  of different lengths, which is what broke the focus-mode edge colouring the first time.
- **The `C2 ──► A` back-edge** — a cycle the traversal has to terminate on, and the reason depth is
  the *shorter* of the two BFS distances rather than whichever walk arrived first.
- `MyFirstLogic`, left over from the template and called by nothing, is the orphan case.

Worth adding on top, though nothing below depends on them: a microflow called from inside a loop, a
microflow in a custom error handler, one with **Mark as used** ticked and no callers, and callers of
each non-microflow kind (a page button, a page datasource, a scheduled event, an entity event
handler, a published REST operation, a nanoflow).

Any Mendix app works for a smoke test — point `MX_APP_DIR` at it. The fixture above only matters for
reproducing the specific behaviours in the table below.

---

### The flag that matters

Studio Pro ignores a development web extension **silently** — no error, no log line, it simply never
loads — unless it is launched with:

```
--enable-extension-development
```

Always launch through `run-testapp.cmd` or `tools\run-studiopro.cmd`. Opening Studio Pro normally
and wondering where the pane went is an easy hour to lose.

**Do not also pass `--enable-web-extensions`.** Guidance written for earlier 11.x pairs the two
flags, but 11.12 rejects the second one and says so in its own log:

```
WARN Mendix.Modeler.Common.CommandLine.OptionParser
     Ignoring these unknown command-line options: --enable-web-extensions
```

```powershell
.\run-testapp.cmd --no-build      # launch what is already deployed
.\tools\run-studiopro.cmd -StudioPro "C:\Program Files\Mendix\11.6.4\modeler\studiopro.exe"
```

### Opening the pane

**It opens itself.** The pane appears in the bottom dock a moment after Studio Pro finishes loading,
alongside History / Changes / Errors / Console. **Extensions → Find That MF → Show microflow graph**
and the App Explorer's **Show in Find that MF** both still work, and are the way back if you close
it.

Getting that far took three findings, all verified the hard way:

- **Do not call `panes.open` from `component.loaded()`.** It resolves without error and then does
  not show the pane, because the docking layout does not exist that early. There is no "shell is
  ready" event to wait for either, so the call is deferred and retried — `scheduleAutoOpen` in
  `src\main\index.ts` keeps trying until the pane's web view sends its first request, which is the
  only evidence `main` ever gets that the pane is really on screen.
- **`panes.register` mints a fresh GUID every launch** (`4f9c3719…`, `ca0ac757…`, `9b12fe16…` on
  successive runs), and `DockablePaneInfo` has no `id` field to pin it. Studio Pro's saved layout
  refers to tool windows by GUID, so it can never restore this pane by itself: every launch it is a
  brand new tool window that has never been docked before. A position you drag it to will not
  survive a restart, and "leave it where the user put it" is not a behaviour that can be built on
  this API. Fixing it needs an `id` on `DockablePaneInfo`.
- **`main` is not a web view.** No `window`, no `localStorage`. Combined with `app.files` being
  write-only in practice, an extension has nowhere to remember anything across restarts — which is
  why the retry loop is driven by a live signal rather than a "have I done this before?" flag.

The consequence to be aware of: because the pane cannot be restored, only opened, it *takes* the
bottom dock's focus on every launch rather than sitting there unselected. Set `AUTO_OPEN_PANE` to
`false` in `src\main\index.ts` if you would rather it stayed out of the way until asked.

### What the pin does

By default the pane **follows the editor**: opening a microflow moves the focus to it. Click
**Following editor** to pin, and the focus stays where it is no matter what you open — so you can
walk through callers in the editor without losing the graph you were reading. Click again to resume
following.

Mechanically the "active document changed" event is a *suggestion*: `main` broadcasts it, and the
pane converts it into a view change only when unpinned. That keeps `main` the single owner of the
focus while leaving the veto with the UI that knows about pinning.

### Interactions

Hovering a node shows a card with its **Documentation** field — the one thing about a microflow a
graph cannot draw and that people actually write down. `Projects$Document.documentation` is read
during the sweep (it lives on the unit body, like `markAsUsed`) and truncated to 600 characters at
the scanner, because a whole-app graph ships hundreds of nodes over `ui.messagePassing`. Pane rows
carry the same text in their native tooltip.

A single click waits ~220 ms before opening, so a double click can cancel it. Without that, the
first half of a double click opened the document and Studio Pro switched away to the microflow
editor — the refocus happened on a tab you could no longer see.

The status bar carries a **Fit** button. The view auto-fits until you pan or zoom, after which the
viewport is yours; Fit takes it back.

| Where | Action |
|---|---|
| App Explorer, right-click a microflow → **Show in Find that MF** | Focuses it and shows the pane |
| Graph node, click | Open that document |
| Graph node, double-click | Refocus the graph on it |
| Graph edge, hover | Highlight it and name both ends |
| Pane search result, click | Make it the focus |
| Pane focus row, click | Open that document |

### Diagnostics

There is no console you can read without attaching a WebView2 debugger from VS Code, and Studio
Pro's own log records only that extensions were loaded, never what they did. So each entry point
keeps a log — startup steps, timings, and any thrown error with its stack.

**Nothing is written unless something fails.** Lines are buffered in memory and the first failure of
a session flushes the lot to `find-that-mf.<entry-point>.log` at the app root, so a failure report
still carries the full run-up to it while a healthy install leaves nothing behind. To trace a run
that goes wrong *without* throwing, set `VERBOSE = true` in `src\graph\diagnostics.ts`.

```
session started 2026-01-02T03:04:05.000Z
+   0.000s [main] loaded: descriptor=extension/find-that-mf/main component=extension/find-that-mf
+   0.001s [main]    ok panes.register
+   0.354s [main] build gen 1: 21 model sources
+   0.820s [main] read 161 nodes
+   3.262s [main] sweep complete: 161 nodes, 29 edges
+   3.501s [main] FAIL appExplorer.addContextMenu: t is not a function
```

The first line is absolute; every other stamp is relative to it. That is deliberate — a log left
over from an earlier session is otherwise indistinguishable from the current one.

An opt-in marker file would be tidier than a compile-time constant, but `app.files` will `putFile`
an arbitrary path at the app root and then neither `getFile` nor `getFiles` can see it again — reads
are limited to subtrees Mendix knows about — so there is nothing to read a marker back with.

### Debugging the UI

`extension\.vscode\launch.json` launches Studio Pro with an Edge/WebView2 debugger attached. If a
pane renders blank, open the web view devtools and look for a CSP violation or a failed chunk load —
`main.js` imports a shared `chunk-*.js` by relative path.

---

## How it works

Two entry points, one owner of state:

```
main.js   registers the pane, owns the graph index AND the view state,
   │      does every model call
   │  ui.messagePassing
   └──► pane.js   bottom dock: toolbar, module filter, and the graph itself
```

`main.js` and `pane.js` are separate ES modules with no shared memory, so anything they share
lives in `main` and the pane asks for slices of it. Only `main` ever answers a request:
`sendMessage` is a broadcast whose `onResponse` fires for the *first* responder, so two
answerers would be a race.

**The pane holds everything.** The graph used to live in a working-area tab with the pane as a
remote control; the tab is gone. Once the graph rendered inline, two copies of the same graph
were on screen at once, which is worse than either alone. `src/ui/graph-view.tsx` is the graph;
`pane.tsx` is the toolbar around it.

The trade-off is real: a dock strip is shorter than a working-area tab, so a large graph means
dragging the dock taller. Restoring the tab is a small change — it was `ui.tabs.open` with a
second UI entry point, and the view component already takes no tab-specific props.

### Staying in sync

The index publishes a **revision** with every status update, and the UIs re-fetch when it changes.
Two details matter:

- `phase` is not enough. After the first sweep it sits at `"ready"` forever, so editing a microflow
  re-scanned the index correctly but changed nothing a UI could observe — the graph went on showing
  pre-edit callers until the mode was toggled. That was the bug the revision fixes.
- The revision is published **coarsely**: when the node list lands, when the sweep completes, and
  after each incremental refresh. `GraphIndex.revision` itself advances once per scanned document,
  which is right for the index and catastrophic to publish — the initial sweep would push a hundred
  revisions and every UI would re-run its layout a hundred times.

The tab additionally keeps a signature of what it drew and skips re-laying-out an unchanged graph,
so an edit in an unrelated module does not make the canvas jump.

### The two views

**Focus** is the default: one microflow, its callers upstream and callees downstream to an
adjustable depth.

**Whole app** draws every document in one flat space. There are deliberately no module boxes —
nesting documents inside compound module nodes reads well on paper and badly in practice, because
the boxes dominate the canvas and the layout engines that handle compound graphs place their children
far enough apart to make it worse. Instead:

- **Colour carries the module**, assigned from a categorical palette by the module's position in the
  app's sorted module list. Hashing the name was tried first and failed the only test that matters:
  on a stock app three of five modules came out the same shade of green. With a handful of modules
  any hash over a hue circle collides visually far too often.
- **The module name is on the node as well**, so the colour is never the only clue.
- **Shape carries the document family** (whole-app and focus alike), subtly: a microflow or rule is a plain rounded box, anything
  client-side (nanoflow, page, snippet, layout, building block, menu) is a pill, a trigger (scheduled
  event, workflow, entity event handler) has slanted ends, and integration documents (published
  services, mappings, document templates) have a folded corner. Four silhouettes rather than one per
  type: the question being asked is "is this a microflow or not", and a shape per document type would
  be noise. Nanoflows sit with the client family deliberately - telling those from microflows is
  exactly the distinction that was hard to see.
- The pane's **module dropdown** lists every module with a tickbox and the same colour swatch, so it
  is both the filter and the legend. Unticked modules and every edge touching them are left out.
  It is a dropdown rather than a row of chips because a blank app has five modules and a real one has
  thirty or more — enough to fill a dock that is only a few rows tall before the graph got any of it.
  The button states the count, and the panel has its own filter box and is capped against the pane's
  height rather than a guessed pixel value.
- Documents that are neither callable nor connected are omitted — a stock app carries dozens of
  layouts that reference nothing and are referenced by nothing. The count is printed in the tab's
  status line rather than silently dropped. Callable documents are always kept even when isolated,
  because an uncalled microflow is the interesting case, not noise.

### Focus mode

**Unbounded in both directions.** There are no depth limits and no controls for them: the walk
follows every caller and every callee to exhaustion. That is not just convenience — it is what
makes the colouring sound. A node with no incoming edge in the drawn graph genuinely has no caller
anywhere in the scanned model, rather than merely sitting at the edge of an arbitrary depth cut.

Colour is spent on the flow rather than the module, since the question here is what reaches this
and what it reaches:

| | |
|---|---|
| **Yellow** | the focus |
| **Green** node | an entry point — nothing calls it |
| **Red** node | a dead end — it calls nothing |
| Neutral grey | everything in between |
| **Green** edge | flows toward the focus |
| **Red** edge | flows away from it |

The module is still written on every node, so nothing is lost by taking colour away from it.
Whole-app mode keeps module colours, because there the question is structural.

#### Getting the direction right in a cycle

Edges are classified by **which side their target lands on**, derived from settled distances —
not by which traversal found them first. With `A → A1 → B → C → C2 → A` focused on `B`, the caller
walk comes back round to `C` after four hops, so discovery order put `C` *upstream* and painted
`B → C` — B's own outgoing edge — as incoming. Depth is now the shorter of the two distances
(ties go to the caller side), which puts `C` one hop downstream where it belongs, and the edge
colour follows from that. `C2 → A` correctly reads as green: it is the path looping back into B.

### Layout

Force-directed (`fcose`), always. A layered left-to-right option existed and was removed: a call
graph is not a tree, and the moment there is a cycle a layered layout has to route the back edge
against the ranks and draws it straight through whatever node is in the way.

Hovering an edge lifts it above everything else, which is how you trace one line out of a tangle.

### Finding references

A microflow can be referenced from **35 distinct places** across 13 namespaces —
`Microflows$MicroflowCall.microflow`, `Pages$MicroflowSettings.microflow`,
`ScheduledEvents$ScheduledEvent.microflow`, `Microflows$Microflow.concurrencyErrorMicroflow`,
`Rest$PublishedRestService.authenticationMicroflow`, and so on.

Rather than 35 hand-written extractors, `src/graph/scan.ts` walks each loaded unit as plain
`$Type`-tagged JSON and emits an edge wherever a property **named** `microflow` / `nanoflow` /
`rule` (or ending in `Microflow` / `Nanoflow`) holds a string that **resolves** to a known document.
That covers every site, survives whatever Mendix adds next, and the resolution check is what keeps
`Pages$GridActionButton.maintainSelectionAfterMicroflow` (a boolean) and
`microflowParameter` (a parameter name) out.

Each edge records the nearest enclosing drawable element's `$ID`, which `editDocument(document,
{ id })` can use to land on the exact call activity rather than the top of the microflow. **No UI
currently surfaces this.** Clicking an edge did it, and was removed: clicking a line to open a
*different* document reads as a mis-click. The id is still recorded — it is also what distinguishes
two calls to the same microflow from the same caller — so the capability is one handler away if a
better affordance turns up.

### Loading, in three phases

`loadAll` is the only bulk read available (`loadUnits` exists on `IModelComponentApiBase` but is
`Omit`ted from the public type). Its `maxUnitsToLoad` defaults to 10 and it **throws** rather than
truncating when the filter matches more, so loads are batched — eight at a time, sequentially,
because firing them all at once turns a background refresh into a visible stall.

1. **Nodes** — `getUnitsInfo()` per document type. No unit bodies. Search works immediately.
2. **Callees on demand** — the callees of X come from loading X alone, so the downstream half of a
   focus graph never waits for the sweep.
3. **Callers** — the full sweep, in the background, streaming results into the index as it goes and
   pushing progress to the pane. Until it finishes, the pane says "still indexing" rather than
   implying an empty caller list means nothing calls this.

Model calls are never made from `component.loaded()`: during Studio Pro's startup the model backend
rejects them with `Response code: 400`. The build starts on first pane open.

While you work, `documentsChanged` and `elementsRenamed` re-scan only the affected documents,
debounced 750 ms because model edits arrive in bursts.

---

## "Mark as used"

Mendix ships a per-document **Mark as used** checkbox (`Microflows$MicroflowBaseBase.markAsUsed`, so
microflows, rules and nanoflows all have it) because a static call graph cannot see every caller:
`Core.execute(...)` from a Java action, reflection, an external trigger. Developers tick it so
colleagues don't "clean up" something that is genuinely in use.

A tool that ignored the flag would confidently report a flagged microflow as dead — worse than not
reporting at all, because someone would act on it. So:

| Callers | `markAsUsed` | Badge | Meaning |
|---|---|---|---|
| 0 | off | ⚠ (amber) | Uncalled as far as the model knows — a real cleanup candidate |
| 0 | on | 🔒 | The author asserts an invisible caller. **No warning.** |
| ≥1 | on | 🔒 | Shown anyway — the flag is a fact about the document, not only an excuse |
| ≥1 | off | none | Ordinary |

The **Unused** tab splits its two lists accordingly, so a cleanup sweep never has to guess which it
is looking at. A microflow that is both called *and* marked appears in neither list — it is badged,
but it is not unused.

`markAsUsed` lives on the unit **body**, never on `UnitInfo`, so it is only known once a document
has been loaded. Badges therefore appear as the sweep progresses, and nothing is ever flagged as an
orphan before it has been looked at.

---

## What has been verified

Against the Blank template's own modules (Atlas, Administration, FeedbackModule — 161 documents),
using the fixture app described above:

| | |
|---|---|
| Pane placement | Appears in the bottom dock at startup, titled *Find That MF*, without being asked |
| Index | 161 documents, 29 references |
| Node list | 0.8 s |
| Full caller sweep | 3.3 s for 161 units (~2 s per 100 units) |
| Focus following | Opening a microflow refocuses the pane on it |
| Orphan badge | `MyFirstModule.MyFirstLogic` correctly flagged ⚠ with "Nothing in the model calls this" |
| Whole-app view | 40 documents, 29 references, 121 unconnected omitted — one fetch, one layout |
| Module colours | Administration blue, FeedbackModule purple, Atlas_Web_Content orange, MyFirstModule teal — all distinct |
| Orphan rings | The three the CLI reports, and only those |
| Context menu | **Show in Find that MF** on a microflow focuses that microflow and shows the pane |

`npm run validate` runs the same scanner headlessly over any `.mpr` via `mx dump-mpr`, and ends with
a **completeness audit**: every document it called unused is brute-force searched for across the raw
model, and any hit is reported as a suspected miss rather than a dead microflow. That audit is what
found two real gaps in the first version —

- `Pages$PageTemplate` and `Pages$BuildingBlock` were not being scanned, which made Atlas's
  `ACT_Login` and `DS_LoginContext` look unused;
- `Mappings$ValueMappingElement.converter` holds a microflow name under a property name that gives
  no hint of it, so the name-based allowlist missed it.

Both are fixed, and the audit now reports clean on the test app. Run it against a large real app
before trusting the unused list.

```powershell
cd extension
npm run validate -- "C:\path\to\YourApp.mpr"
```

## Not our bug: "t is not a function"

Studio Pro sometimes replaces a document editor with its web-component error boundary —
*"t is not a function / Please close and reopen this UI component"*. **This is a known Studio Pro
bug and has nothing to do with this extension.** Close and reopen the tab.

Recorded here because it looks alarming and it is tempting to go hunting: it showed up once during
development, did not recur in six further launches, and the extension's own log
(`find-that-mf.main.log`) showed every API call succeeding with no error from either entry point.
Do not spend an afternoon on it.

## Cytoscape does not render inside Studio Pro's WebView

The graph is drawn as **SVG**. Cytoscape was the obvious choice and its on-screen renderer simply
does not paint here. Established by reading the pixels back:

| Check | Result |
|---|---|
| Geometry (`nodes()`, `extent()`, `renderedBoundingBox()`) | Correct — nodes sized, positioned, inside the viewport |
| Node style (`background-color`, `opacity`, `display`) | Correct |
| Canvas layers (3, `1718x1013`, `visible`, `opacity: 1`) | Present, correctly sized for `devicePixelRatio` 1.75 |
| `cy.png()` | **Works** — a 50 KB image of the graph |
| Pixels in the on-screen layers | **Zero non-transparent**, after `resize()`, `forceRender()`, a delay, and a full instance rebuild |
| A hand-made canvas filled red in the same document | **Paints fine** |

So canvas works in this WebView, and Cytoscape can render — but its layered on-screen draw path
never runs. Rebuilding the instance does not help; an uncapped retry just pegs a core.

Cytoscape is still used, **headless**, for layout (`src/ui/layout.ts`): dagre for *Layered*, fcose
for *Free*. It hands back coordinates and `graph.tsx` draws SVG — the same DOM path the pane uses,
which demonstrably works. Nodes are `<rect>` plus two `<text>` lines, edges are quadratic `<path>`s
with a marker arrowhead, and pan/zoom is a transform on one `<g>`.

If you ever swap renderer again, the diagnostic that settles it in one run is reading
`getImageData` back off the canvases — every other signal Cytoscape offers looks healthy while the
screen stays blank.

## Known gaps

- **`TabInfo.icon` does not render on 11.12.** Recorded because it cost an afternoon: a PNG data
  URL, a relative PNG path and an inline SVG data URL all produced a tab with no icon at all, while
  every neighbouring Studio Pro tab showed one. No longer reachable — there is no tab any more — but
  worth knowing before trying again.
- **Project-level microflows** — after-startup, before-shutdown and health-check microflows are not
  exposed by the web model API (no `Projects` namespace member references a microflow). They will
  show as uncalled. Mark them as used.
- **`Core.execute(...)` from Java** is invisible unless the microflow is passed as a Java action
  *parameter* (`Microflows$MicroflowParameterValue`), which the scanner does see. For the rest,
  that is what Mark as used is for.
- **Microflow expressions** cannot call microflows, so nothing is missed there.
- The **System** module is skipped: cost with no payoff.

---

## Versions

Targets Studio Pro **11.12**, pinned to `@mendix/extensions-api@0.11.0-mendix.11.12.0`. The package
version encodes the Studio Pro version it targets. Mendix broke the menu API in 11.6, so keep the
pin and expect churn on upgrade.

Mendix 10 is out of scope — it uses a `webextensions\` deploy directory and a considerably thinner
model API.

Packaging as an add-on module (so colleagues can install it without
`--enable-extension-development`) is not done yet; see Mendix's *Packaging Your Extension* guide
when it is wanted.

---

## Licence

MIT — see [LICENSE](LICENSE).
