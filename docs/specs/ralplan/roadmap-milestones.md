---
title: Roadmaps and Milestones with Interactive Canvas for OpenKan
status: draft (planner pass)
owner: @mike
date: 2026-09-06
inputs:
  - /projects/openkan HEAD 5221447
  - /projects/openkan origin/main 5221447
  - docs/specs/ralplan/agent-profiles-and-mcp.md (format reference)
  - web/goals-view.js, web/app.js, web/api.js, web/index.html
  - kanban/server.ts, kanban/board.ts
  - ok/storage.ts, ok/schemas.ts, ok/commands/{task,prd,plan,index}.ts
  - bin/ok.ts
  - docs/OK-PLANNING.md
  - cytoscape.js v3.34.2, cytoscape-edgehandles v4.0.1 (WebSearch 2026-09-06)
related:
  - docs/specs/ralplan/roadmap-milestones.handoff.json
---

# Roadmaps and Milestones with Interactive Canvas for OpenKan

This plan introduces two new durable entities — **Roadmap** (a
named container) and **Milestone** (a dated checkpoint that owns a
subset of existing `tsk-*` tasks) — plus a fully interactive graph
canvas that renders them. The canvas is a new top-level tab in the
workspace, live-updates over the existing `/api/events` SSE channel,
and persists layout state in a dedicated sibling file so high-frequency
drag writes never block low-frequency metadata edits.

All write paths go through the `ok` CLI and the existing HTTP API in
`kanban/server.ts`. The web UI is vanilla JS, mirrors `web/goals-view.js`,
and ships with `web/vendor/cytoscape.min.js` plus
`web/vendor/cytoscape-edgehandles.min.js` (or jsDelivr-equivalent pins).

## 1. Research-required decisions

The four user-locked decisions below each cite the evidence that drove
the recommendation.

### 1.1 Graph library — **cytoscape.js**

**Recommendation:** `cytoscape@3.34.2` core +
`cytoscape-edgehandles@4.0.1` (drag-to-connect) +
`cytoscape-cose-bilkent@4.1.0` (default layout) +
`cytoscape-popper@2.0.0` (HTML overlay for inline edit + date picker).

**Why not the alternatives:**

- **react-flow** — React-only. Explicitly excluded by the
  "vanilla JS, no React" hard constraint.
- **jsplumb** — In maintenance mode per the upstream site; new
  licenses are not sold and the open-source edition has unresolved
  issues from years ago. Last WebSearch (2026-09-06) returned the
  jsplumbtoolkit.com announcement that the successor is
  `visuallyjs.com`. Not safe to bet on for new code.
- **d3** — A drawing library, not a graph engine; we'd re-implement
  drag-to-connect, edge routing, hit-testing, and layout ourselves.
  Footprint and risk explode for a feature that has a turnkey
  alternative.
- **vis-network** — Was a candidate, but the upstream
  (vis.js / almende) has had long stretches without a release and
  the npm package is dual-purpose (timeline + network), so the
  relevant surface drifts. Cytoscape.js ships weekly patches and a
  monthly feature cadence per the official site.

**Why cytoscape.js fits:**

- Framework-agnostic vanilla JS — matches the `web/app.js` direct-DOM
  style; no React or build-time pipeline change.
- Active maintenance: 3.34.2 is the current release per the official
  site and cdnjs; weekly patch / monthly feature cadence is published.
- Drag-to-connect is a first-class extension
  (`cytoscape-edgehandles`) with a `*-no-jquery` build for projects
  that want to avoid jQuery (we do — none of the OpenKan UI deps
  pull it in).
- Layout extensions are pluggable — `cose-bilkent` covers the
  100–500-node range cited in scope, and `fcose` is the documented
  fallback if performance becomes an issue.
- Inline editing uses `cytoscape-popper` to anchor a `contenteditable`
  `<div>` over a node — the canonical pattern in the official docs.
- MIT-licensed, CDN-available, ships to a `dist/` we can vendor under
  `web/vendor/` (matching how `gsap.min.js` is already vendored).

**Sources:**

- [Cytoscape.js official site](http://js.cytoscape.org/) — current
  version 3.34.2, draggable mouse + touch nodes, edgehandles extension.
- [cytoscape-edgehandles on npm](https://www.jsdelivr.com/package/npm/cytoscape-edgehandles) —
  v4.0.1 listed; jquery-free build available.
- [React Flow vs Cytoscape (FirstAim Radar, 2026)](https://radar.firstaimovers.com/react-flow-vs-cytoscape-graph-engine-choice) —
  confirms cytoscape.js for exploration/analyzing.
- [jsPlumb in maintenance mode (2025)](https://jsplumbtoolkit.com/) —
  redirected to visuallyjs.com.
- [xyflow/awesome-node-based-uis](https://github.com/xyflow/awesome-node-based-uis) —
  cytoscape.js listed as a canonical vanilla-JS option.
- [cytoscape-popper inline edit pattern](https://js.cytoscape.org/) —
  `contenteditable` overlay over `node.popperRef()`.

### 1.2 Canvas placement — **new top-level nav tab `#roadmap`**

**Recommendation:** Add a sixth top-level tab in `web/index.html`
(`Tasks | Docs | Goals | **Roadmap** | Agents`), with a dedicated
`<section id="tab-roadmap" class="tab-pane" data-tab="roadmap">`
mounting a `<div id="roadmap-root">`.

**Why not embedded in an existing view:**

- The canvas is **full-screen** in nature — a 100–500-node graph with
  draggable nodes + drag-to-connect + date-picker popovers needs the
  full viewport, not a sub-region of Goals or Tasks.
- Goals already shows *long-horizon outcomes* per PRD; mixing a
  timeline canvas into it would conflate two mental models (PRDs vs.
  delivery roadmaps).
- The existing tab router in `web/app.js` (around the
  `attachTabRouter` / `activateTab` block) treats every top-level tab
  the same way: a `data-tab` button, a `.tab-pane` section, a root
  div, and a `mount(root)` call. Adding a sixth tab is a six-line
  change plus the new view module — the cheapest and most consistent
  option.
- The `more` overflow menu in the topbar (`workspace-more-btn`,
  `workspace-more-menu`) already exists as an escape hatch if a
  future tab count makes the topbar too crowded; for now six tabs
  fits.

### 1.3 Node-position persistence — **separate `.ok/roadmaps/<id>/layout.json`**

**Recommendation:** Milestone metadata (id, title, targetDate, owner,
status, edges) lives in `.ok/roadmaps/<roadmapId>.json`. Node
**positions** live in `.ok/roadmaps/<roadmapId>/layout.json` with
shape `{ positions: { [milestoneId]: { x: number, y: number } } }`.

**Why not embedded in the roadmap JSON:**

- Drag-to-move fires every animation frame during drag (potentially
  60 events/sec); milestone metadata edits are rare (a few per day).
  Co-locating them means every drag-end rewrites the full roadmap
  envelope, including all milestone bodies and all edges, when only
  the position table changed.
- `writeJson` in `ok/storage.ts` is atomic via `.tmp-<pid>-<ts>` +
  `rename`, so neither approach can corrupt the file mid-write. The
  concern is not corruption — it is **write amplification** and
  **read amplification** (the loader reads the whole envelope to
  render the canvas).
- The layout is **purely presentational** — it never affects
  semantics, dependency edges, or CLI output. Putting it in its
  own file makes that contract explicit.
- Layout deletion is cheap: when a roadmap is removed, deleting the
  `roadmapId` directory removes everything.
- Same atomic-write guard (`writeJson`) applies, so the "no race
  with milestone edits" requirement is satisfied — a layout write
  and a milestone write hit **different files** and cannot
  interleave.

**Trade-off acknowledged:** A user who deletes a milestone while a
layout write is in flight would leave a stale milestone id in
`layout.json`. The reader in `web/roadmap-view.js` MUST filter
`positions` against the live milestone set at render time so this is
a visual no-op. No data corruption, only a small dead-entry.

### 1.4 Task ↔ milestone ownership — **tasks reference `milestoneId`**

**Recommendation:** Add an optional `milestoneId?: string` field to
the `Task` interface in `ok/schemas.ts`. The milestone itself does
NOT carry a `taskIds[]` array.

**Why this matches the codebase:**

- The existing subtask convention in `kanban/board.ts:60-61` and
  `web/app.js:979` is `Task.parentId` (child references parent) with
  `subtaskIds[]` as a **derived, server-maintained** cache. The
  authoritative reference lives on the child record.
- The `Prd` schema (`ok/schemas.ts:258`) already carries
  `milestones: PrdMilestone[]` as inline data — but those are
  PRD-internal date markers (open/hit/missed/dropped) without their
  own id namespace and without task membership. The new Milestone
  entity is a richer, top-level construct (own id `mls-*`, own
  file, owns tasks via task-side reference).
- Single-direction reference (task → milestone) means deleting a
  milestone requires **no cascade** — the milestone file is
  removed, tasks keep their now-dangling `milestoneId` (treated as
  "unassigned"), and a periodic `ok doctor` check can flag any
  orphans. This is **reversible**: re-creating the milestone with
  the same id re-attaches the tasks automatically.
- The `ok task show <id>` and `ok roadmap-milestone show <id>`
  commands both need to walk in one direction only: from task to
  milestone (read the task, read the milestone if `milestoneId` is
  set). No second-index required.

**Trade-off acknowledged:** "List tasks for milestone X" requires a
scan of `.ok/tasks/`. At < 5,000 tasks this is sub-millisecond with
`ok/storage.ts:listTasks` and trivial in the HTTP handler. We add a
denormalised `milestoneIndex` to `.ok/index.json` in M28 if profiling
proves it's needed; not now.

## 2. Data model

> **Disambiguation: "Milestone" is overloaded.** The codebase already
> defines `PrdMilestone` at `ok/schemas.ts:236-241`
> (`{ id, title, dueBy?, status: "open"|"hit"|"missed"|"dropped" }`),
> embedded as `Prd.milestones: PrdMilestone[]` in `ok/schemas.ts:258`
> and mutated through `ok prd update --milestone ... --milestone-status ...`
> at `ok/commands/prd.ts:204-211`. That is a **PRD-internal** construct —
> a one-line summary inside a long-horizon document. This plan introduces
> a **standalone, canvas-rendered entity** under `.ok/roadmaps/<id>.json`
> for project-wide, dated checkpoints that own `tsk-*` tasks.
>
> To keep the two namespaces from colliding in the CLI, this plan renames
> the new CLI surface to **`ok roadmap-milestone …`** (M25). `ok milestone …`
> remains reserved for the existing `PrdMilestone` operations on PRDs.
> The handler folded into `ok/commands/task.ts:runTask` is renamed
> accordingly to `roadmapMilestoneAttach` (the helper key) so the noun
> collision stays out of code. `docs/ROADMAPS.md` (M28), the help output
> (M25), and `bin/ok.ts:help` cross-reference the two surfaces with a
> one-line "see also: `ok prd update --milestone`" note.

### 2.1 Roadmap — `.ok/roadmaps/<roadmapId>.json`

```jsonc
{
  "schema": "ok.roadmap.v1",
  "id": "rmp-Vn4kRp2x",
  "title": "Q3 Delivery",
  "description": "Cross-team Q3 milestones",
  "owners": ["alice", "bob"],
  "status": "active",            // draft | active | shipped | archived
  "milestones": [
    {
      "id": "mls-AaaaBBBB",
      "title": "Auth refactor",
      "owner": "alice",
      "status": "open",          // open | in_progress | hit | missed | dropped
      "targetDate": "2026-09-30",
      "dependsOn": ["mls-CcccDDDD"]   // milestone ids (canvas edges)
    }
  ],
  "createdAt": "2026-09-06T10:00:00.000Z",
  "updatedAt": "2026-09-06T10:00:00.000Z"
}
```

### 2.2 Layout — `.ok/roadmaps/<roadmapId>/layout.json`

```jsonc
{
  "schema": "ok.roadmap.layout.v1",
  "roadmapId": "rmp-Vn4kRp2x",
  "positions": {
    "mls-AaaaBBBB": { "x": 120, "y": 80 },
    "mls-CcccDDDD": { "x": 380, "y": 220 }
  },
  "updatedAt": "2026-09-06T10:00:00.000Z"
}
```

### 2.3 Task — additive `milestoneId?` field

```jsonc
{
  "schema": "ok.task.v1",
  "id": "tsk-Vn4kRp2x",
  "title": "Add OAuth callback",
  "milestoneId": "mls-AaaaBBBB",   // NEW: optional reference
  // ... existing fields unchanged
}
```

**Critical — `milestoneId` MUST round-trip through both stores.**
The HTTP PATCH path goes through `kanban/board.ts` which mirror-writes
the planning file on every `persist()` call. The current
`toPlanningTask()` at `kanban/board.ts:278-292` only emits
`schema/id/title/status/owner/description/scopes`, and
`fromPlanningTask()` at `kanban/board.ts:355-398` only reads those
fields back. If `milestoneId` is not propagated, `ok task attach
<taskId> --roadmap-milestone <mlsId>` will write the field, but any
subsequent PATCH on `/api/tasks/:tid` (rename, move, tag) triggers
`mirrorToOkStore()` (`kanban/board.ts:319-347`) which silently drops
`milestoneId` from the `.ok/tasks/<id>.json` file on disk. M25 MUST
extend both functions to copy `task.milestoneId` (engine → planning)
and `ok.milestoneId` (planning → engine), and extend
`isTask`/`validateTask` in `ok/schemas.ts` to accept the new field.
The exact edits are enumerated in M25 §6 below.

### 2.4 ID prefixes

- `rmp-` — roadmap (mirrors `tsk-`, `pln-`, `prd-`).
- `mls-` — milestone.
- `nanoid(8)` suffix, same generator as `ok/ids.ts:newId`.

## 3. API surface

All new routes follow the existing `kanban/server.ts` handler pattern
(`api*` async function → `Response` → dispatched in the request
router). All writes call `broadcast("roadmap.updated", {...})` so the
SSE channel fans out.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/roadmaps` | — | List all roadmaps (no layout) |
| POST | `/api/roadmaps` | `{title, description?, owners?}` | Create roadmap; default layout is empty |
| GET | `/api/roadmaps/:id` | — | Roadmap + layout merged; 404 if missing |
| DELETE | `/api/roadmaps/:id` | — | Remove roadmap file + layout dir; tasks keep dangling `milestoneId` |
| POST | `/api/roadmaps/:id/milestones` | `{title, targetDate?, owner?, status?}` | Create milestone in roadmap |
| PATCH | `/api/roadmaps/:id/milestones/:mid` | partial milestone fields | Update metadata; broadcast `roadmap.updated` |
| DELETE | `/api/roadmaps/:id/milestones/:mid` | — | Remove milestone; orphan tasks keep their now-dangling `milestoneId` |
| PATCH | `/api/roadmaps/:id/layout` | `{positions: {[mid]: {x,y}}}` | Persist layout only; broadcasts `roadmap.updated` |
| PATCH | `/api/tasks/:tid` | `{milestoneId?: string \| null}` | Additive field on existing endpoint |

**SSE event:** `roadmap.updated` with payload
`{roadmapId, milestoneId?, kind: "metadata"|"layout"|"milestone"|"task"}`.
Added to the `KNOWN` list in `web/api.js:181-193` and to the
`FORWARDED` list at `web/api.js:239-250` so cross-tab siblings mirror
it.

## 4. CLI surface

All commands go under `bin/ok` (the `ok` migration lands as v0.5.0
immediately before M25; the legacy `openkan roadmap ...` alias is
**out of scope** for this plan). The new milestone subcommand is
named **`ok roadmap-milestone …`** (not `ok milestone …`) to avoid
clashing with the existing `ok prd update --milestone` surface —
see §2 for the full disambiguation.

```
ok roadmap list                                       # padded columns: id, status, updatedAt, title (mirrors ok task list)
ok roadmap add --title "Q3 Delivery" [--description ...] [--owner ...]
ok roadmap show <roadmapId>                           # JSON dump
ok roadmap rm  <roadmapId>                            # confirms prompt
ok roadmap rename <roadmapId> --title "..."

ok roadmap-milestone add <roadmapId> --title "..." [--target-date 2026-09-30] [--owner alice]
ok roadmap-milestone set-target <roadmapId> <milestoneId> --date 2026-10-15
ok roadmap-milestone set-owner  <roadmapId> <milestoneId> --owner bob
ok roadmap-milestone set-status <roadmapId> <milestoneId> --status in_progress
ok roadmap-milestone rm      <roadmapId> <milestoneId>

ok task attach    <taskId> --roadmap-milestone <mlsId>     # sets task.milestoneId (see alias below)
ok task detach    <taskId>                                  # clears the field
```

> **Alias / backwards-compat note (M25, no scope creep):** the
> existing `ok prd update --milestone <id>` flag at
> `ok/commands/prd.ts:204-211` is the legacy `PrdMilestone` surface
> on PRDs and is **not** wired up. The new `ok roadmap-milestone`
> family uses `--roadmap-milestone` to keep the namespaces disjoint.
> `ok task attach` / `ok task detach` are the only blessed commands
> for the new entity. There is no `--milestone` flag on
> `ok task update`; the only `ok task ... --milestone*` flags are
> `--roadmap-milestone` on `ok task attach`.

These land as two new files — `ok/commands/roadmap.ts` and a
new `ok/commands/roadmap-milestone.ts` file (new file; per §2,
`ok milestone …` is reserved for the existing `PrdMilestone`
surface, so a new namespace is required) — plus a
`roadmapMilestoneAttach` handler (new helper) folded into the
existing `ok/commands/task.ts:runTask` dispatch. The CLI output for
`ok roadmap list` uses padded columns matching `ok task list`
(`ok/commands/task.ts:56-66`) — `${id.padEnd(w)}  ${status.padEnd(11)}  ${updatedAt.padEnd(ts)}  ${title}`
— not tab-separated rows.

## 5. Web surface

### 5.1 New files

- `web/roadmap-view.js` (~150–250 lines) — IIFE module exposing
  `window.OpenKanRoadmap = { mount(target), unmount() }`. Shape
  mirrors `web/goals-view.js` exactly: imports `{ api, on }` from
  `window.OpenKanAPI`, listens for `roadmap.updated`, calls
  `refresh()` on every relevant event.
- `web/roadmap-view.css` (~80 lines) — scopes styles to
  `.roadmap-view`, `.roadmap-canvas`, `.roadmap-node`,
  `.roadmap-toolbar`. Loaded by `web/index.html` after
  `workspace.css`.
- `web/vendor/cytoscape.min.js` (pinned 3.34.2) and
  `web/vendor/cytoscape-edgehandles.min.js` (pinned 4.0.1, no-jquery
  build). Loaded via `<script defer>` in `web/index.html` **before**
  `app.js` and `roadmap-view.js`. (See §7 — `defer` is NOT lazy; the
  bundle cost is amortised across every page load and is unavoidable
  for any user who opens the Roadmap tab at all. Pinning happens in
  `web/vendor/README.md` per the existing gsap convention.)

### 5.2 Edited files

- `web/index.html`:
  - Add `<button data-tab="roadmap">Roadmap</button>` to the tablist.
  - Add `<section id="tab-roadmap" class="tab-pane" data-tab="roadmap" hidden><div id="roadmap-root"></div></section>`.
  - Add `<script src="roadmap-view.js" defer>` and the cytoscape
    vendor `<script>` tags.
  - Add `<link rel="stylesheet" href="roadmap-view.css">`.
- `web/app.js` (`activateTab` around line 3553):
  - Add `else if (name === "roadmap") { const root = document.getElementById("roadmap-root"); if (root && window.OpenKanRoadmap) window.OpenKanRoadmap.mount(root); }`.
  - Mirror `tasks` branch's `unmount()` calls so leaving Roadmap frees
    cytoscape resources.
- `web/api.js`:
  - Add `"roadmap.updated"` to `KNOWN` (line 181) and `FORWARDED`
    (line 239).

### 5.3 Canvas UX

- Toolbar: `[New milestone]` `[Auto-layout]` `[Fit to view]`.
- Click empty canvas → POST `/api/roadmaps/:id/milestones` with
  `{title: "New milestone", status: "open", x, y}`. The `x, y` are
  derived from the click event in canvas coordinates
  (`cy.nodes().positions()`-relative), so the new node appears at
  the click location without relying on a `cose-bilkent` auto-layout
  pass. The server persists the position into the milestone's
  `layout.json` entry at the same time. If the user later runs the
  "re-layout" action, the click-placed position is overwritten.
  Focus the new node on success.
- Double-click a milestone → inline `<input>` overlays the node
  (via `popperRef()`); Enter commits, Escape cancels. UNVERIFIED — `node.popperRef()` API to be confirmed against `cytoscape-popper@2.0.0` docs during M27 dispatch.
- Drag a node's body → cytoscape's native `drag` event; on
  `dragfree`, debounce 250 ms then `PATCH /api/roadmaps/:id/layout`.
- Hover a node edge → port handles appear; drag from one node's
  edge handle to another node's body → `PATCH .../milestones/:mid`
  with `dependsOn` updated (the canvas edge IS a milestone↔milestone
  dependency).
- Click a node → side panel slides in listing tasks with that
  `milestoneId`, each row has `[Attach task]` `[Open task]` buttons.
- Click a milestone's `targetDate` pill (rendered in the node's
  footer strip) → opens a `<input type="date">` overlay anchored via
  `node.popperRef()` from `cytoscape-popper@2.0.0`. Selecting a
  date commits via `PATCH /api/roadmaps/:rid/milestones/:mid` with
  `{targetDate: "YYYY-MM-DD"}`; clearing the input commits
  `targetDate: null`. The pill renders "—" when `targetDate` is
  unset. UNVERIFIED — `node.popperRef()` API to be confirmed against
  `cytoscape-popper@2.0.0` docs during M27 dispatch.

**Cleanup contract — `unmount()` MUST release every cytoscape resource.**
Unlike `web/goals-view.js` (which only holds a click listener),
cytoscape creates an internal WebGL/2D context, a `ResizeObserver`,
and an event-listener bus that do **not** free on garbage collection.
The `unmount()` body enumerates the four required teardown steps in
order; missing any one leaks canvas state across mount→unmount cycles
and leaves duplicate edgehandles on the next mount:

1. `ehRef?.current?.disable?.()` — disable the edgehandles instance
   first so any drag-in-flight does not reattach listeners mid-teardown.
2. `cy.removeAllListeners()` — drop every cytoscape-bus listener
   before destroy; `cy.destroy()` does NOT do this on its own.
3. `cy.destroy()` — releases the renderer context, the
   `ResizeObserver`, and the mutation observers cytoscape attaches to
   its host `<div>`.
4. `root.removeEventListener("click", onCanvasClick)` and
   `root.innerHTML = ""` — drop host-DOM listeners and clear the
   container so the next `mount()` starts from a clean slate.

The M27 test suite MUST include a regression that calls
`OpenKanRoadmap.mount(root) → unmount() → mount(root) → unmount()`
and asserts that (a) no second `eh:start` listener is registered
(telemetry counter or `cy.listeners("eh:start").length === 1`),
and (b) no `ResizeObserver` leaks (assert `ResizeObserver`
constructor spy is called exactly once across the cycle). The test
fails loudly on a missing cleanup step, which catches the most
common cytoscape-integration regression.

## 6. Phased milestones

Each milestone is **one bounded, atomic, revertible commit on
`main`**. The plan totals 4 milestones; each lands its own reviewable
diff and its own tests.

### M25 — Data model + storage + CLI

**Goal:** Persist `Roadmap`, `Milestone`, and `Task.milestoneId` to
`.ok/`. CLI is the only write path. No UI yet.

**Scope:**

- New schemas in `ok/schemas.ts`:
  `Roadmap`, `RoadmapMilestone` (named to disambiguate from the
  existing `PrdMilestone` — see §2), `RoadmapLayout`, plus a
  `Task.milestoneId?: string` additive field with validator update.
- **Critical — extend the `Task` interface so `milestoneId` survives
  HTTP PATCH → mirror → planning-store round trips.** Specifically:
  - `ok/schemas.ts:Task` (line 29) gains `milestoneId?: string`.
  - `isTask` (line 65) and `validateTask` (line 93) accept the
    optional field and reject malformed values
    (e.g. `if (t.milestoneId !== undefined && (typeof t.milestoneId !== "string" || !/^mls-/.test(t.milestoneId)))`).
  - `kanban/board.ts:toPlanningTask` (line 278) MUST copy
    `task.milestoneId ?? ok.milestoneId` (preferring the engine view
    so a CLI `ok task attach` followed by an HTTP PATCH does not
    drop the field). Specifically:
    `if (task.milestoneId) ok.milestoneId = task.milestoneId;`
  - Extend `Task` in `kanban/board.ts:30-62` with `milestoneId?: string | null` and pass it through `fromPlanningTask` (lines 355-398) so the planning->engine direction preserves the field.
  - Add a regression test in `tests/m25-engine-mirror-roundtrip.test.mts`
    that asserts: write a task with `milestoneId` via
    `ok task attach`, then trigger an HTTP PATCH (rename) via
    `apiUpdateTask`, then re-read `.ok/tasks/<id>.json` and assert
    `milestoneId` is still set. This test fails on the pre-fix
    code path and is the gate for closing CR-DATA-LOSS.
- New getters/setters in `ok/storage.ts`:
  `readRoadmap`, `writeRoadmap`, `listRoadmaps`, `removeRoadmap`,
  `readRoadmapLayout`, `writeRoadmapLayout`. All go through the
  existing `writeJson` atomic-rename helper.
- New directory creation in `ok/storage.ts:ensureDirs`:
  `roadmapsDir` and lazy `roadmapsDir/<id>/` for layout files.
- New `ok/commands/roadmap.ts` — `runRoadmap(args)` dispatches
  `list | add | show | rm | rename`. `ok roadmap list` uses padded
  columns matching `ok/commands/task.ts:56-66`.
- New `ok/commands/roadmap-milestone.ts` — `runRoadmapMilestone(args)`
  dispatches `add | set-target | set-owner | set-status | rm`. This
  is a new file with a new export; `ok milestone …` is reserved for
  the existing `PrdMilestone` surface (see §2), so a separate
  filename and runner are required to keep the two namespaces
  disjoint.
- Extend `ok/commands/task.ts` with `attach` and `detach`
  subcommands that PATCH the task's `milestoneId`. The internal
  helper key is `roadmapMilestoneAttach`.
- Wire all three new runners into `bin/ok.ts:main` switch and add a
  "see also: `ok prd update --milestone`" line in the help output
  (around `bin/ok.ts:55-59`) so the two surfaces stay discoverable.
- Update `.ok/index.json` rebuild in `ok/storage.ts:rebuildIndex` so
  roadmaps appear in the catalogue (`roadmaps: IndexEntry[]`).
- Update `ok/commands/index.ts:runDoctor` to validate roadmaps.

**Non-goals:** No HTTP API changes yet. No UI changes. No cytoscape.
No SSE. Layout file is created but unused (empty `positions: {}`).

**Files:**

- `ok/schemas.ts` — add `Roadmap`, `RoadmapMilestone`,
  `RoadmapLayout`, `Task.milestoneId?`; extend `isTask` +
  `validateTask` with the new field guard.
- `ok/storage.ts` — add `roadmapsDir`, `roadmapLayoutDir`,
  readers/writers; extend `rebuildIndex` for the new entity.
- `ok/ids.ts` — add `milestoneId`, `roadmapId`; same `nanoid(8)` pattern.
- `kanban/board.ts` — extend `toPlanningTask` (line 278) and
  `fromPlanningTask` (line 355) to round-trip `milestoneId`; add
  `milestoneId?` to the engine `Task` interface if not
  already present.
- `ok/commands/roadmap.ts` — new file.
- `ok/commands/roadmap-milestone.ts` — new file (created fresh;
  `ok/commands/milestone.ts` does not exist, so no rename occurs).
- `ok/commands/task.ts` — add `attach` + `detach` cases
  (`roadmapMilestoneAttach` helper).
- `ok/commands/index.ts` — add roadmap validation to `runDoctor`.
- `bin/ok.ts` — add `roadmap`, `roadmap-milestone` dispatch arms +
  help entries (note: do **not** register `milestone`; that namespace
  is reserved for PrdMilestone).

**Reuse:**

- `ok/storage.ts:writeJson` atomic write (no new IO code).
- `ok/schemas.ts:isTask` pattern + discriminator (`schema: "ok.X.v1"`).
- `ok/ids.ts:newId` factory + `parseArgs`, `flagString` helpers.
- `ok/commands/prd.ts` shape as a CLI template (export `runX` async
  fn, JSON output, exit codes, padded-column `printTable`).

**Acceptance criteria:**

- `ok roadmap add --title "Q3"` succeeds, prints `rmp-XXXXXXXX`.
- `.ok/roadmaps/rmp-XXXXXXXX.json` exists with `schema: "ok.roadmap.v1"`.
- `ok roadmap-milestone add <rid> --title "Auth" --target-date 2026-09-30`
  succeeds, prints `mls-XXXXXXXX`.
- `ok task attach <taskId> --roadmap-milestone <mid>` writes
  `Task.milestoneId` to the task file.
- `ok task detach <taskId>` clears the field.
- `ok roadmap rm <rid>` removes both `.ok/roadmaps/<rid>.json` and
  `.ok/roadmaps/<rid>/`.
- `ok milestone` (legacy namespace) is untouched and still mutates
  `PrdMilestone` via `ok prd update --milestone ...`.
- `ok doctor` validates every new file shape.
- **Round-trip regression:** writing `milestoneId` via
  `ok task attach`, then triggering any HTTP PATCH on
  `/api/tasks/:tid`, leaves `milestoneId` intact on disk. Asserted
  by `tests/m25-engine-mirror-roundtrip.test.mts`.
- Reversibility: a `git revert` of the M25 commit drops every new
  file cleanly; `ok doctor` reverts to zero new errors.

**Verification:**

- `tests/m25-roadmap-cli.test.mts` — covers every subcommand happy
  path + at least 3 failure paths (missing id, bad date, mismatched
  milestone). Asserts padded-column output for `ok roadmap list`.
- `tests/m25-task-attach.test.mts` — covers attach/detach and
  rejection of `mls-` ids that don't exist.
- `tests/m25-doctor-roadmap.test.mts` — corrupted roadmap file
  surfaces as a `doctor` issue with the right reason.
- `tests/m25-engine-mirror-roundtrip.test.mts` — gate for
  CR-DATA-LOSS (see Scope above).
- `npm test` passes including all pre-existing tests.
- `npm run check` passes.
- `npm run typecheck` passes.

**DoD:**

- All M25 tests green.
- `CHANGELOG.md` Unreleased notes the new entities and CLI surface,
  including the rename of the milestone CLI namespace.
- `docs/OK-PLANNING.md` mentions roadmaps and milestones in its
  reference section AND disambiguates them from the existing
  `PrdMilestone` surface with a one-line cross-reference.
- `git log --oneline -1` shows one commit titled
  `feat(ok): add Roadmap, RoadmapMilestone, and Task.milestoneId (M25)`.

### M26 — HTTP API + SSE

**Goal:** Expose every roadmaps/milestone operation over HTTP.
Every write fans out via `/api/events` as `roadmap.updated` — whether
the write came through HTTP or through the `ok` CLI.

**Scope:**

- New handlers in `kanban/server.ts`:
  `apiListRoadmaps`, `apiCreateRoadmap`, `apiGetRoadmap`,
  `apiDeleteRoadmap`, `apiCreateMilestone`, `apiPatchMilestone`,
  `apiDeleteMilestone`, `apiPatchRoadmapLayout`.
- Extend the existing `apiUpdateTask` handler
  (`kanban/server.ts:667`) to accept `milestoneId` in the patch body;
  broadcast `task.updated` when it changes.
- Register every new route in the request router around
  `kanban/server.ts:3000-3120` (the same `if (path === ...) return ...`
  dispatcher).
- After every successful HTTP write, call
  `broadcast("roadmap.updated", {roadmapId, milestoneId, kind})`.

**Critical — extend the file-watcher switch in `kanban/server.ts` so
the CLI fans out via SSE.** Today the disk-watcher switch at
`kanban/server.ts:2878-2939` matches `board.json`, `changelog.jsonl`,
`task.mdx`, `comments.json`, `inputs.json`, `state.json`, and the
`ok.task.synced` branch for `.ok/tasks/*.json`. It does NOT match
`.ok/roadmaps/*.json` or `.ok/roadmaps/<id>/layout.json` — those
events fall through to the generic `broadcast("file.changed", ...)`
at `kanban/server.ts:2938`, which `web/api.js:KNOWN` (lines 181-193)
does not subscribe to. Consequence: an `ok roadmap add` from a shell
would never refresh a connected dashboard tab, defeating the "open
two tabs, observe live sync" DoD promise. M26 MUST add two new
branches before the fallthrough:

```ts
} else if (ev.path.match(/(?:\/|^)\.ok\/roadmaps\/[^/]+\/layout\.json$/)) {
  const lm = ev.path.match(/(?:\/|^)\.ok\/roadmaps\/([^/]+)\/layout\.json$/);
  if (lm) broadcast("roadmap.updated", { roadmapId: lm[1], kind: "layout" });
} else if (ev.path.match(/(?:\/|^)\.ok\/roadmaps\/[^/]+\.json$/)) {
  const rm = ev.path.match(/(?:\/|^)\.ok\/roadmaps\/([^/]+)\.json$/);
  if (rm) broadcast("roadmap.updated", { roadmapId: rm[1], kind: "metadata" });
}
```

Place these alongside the existing `ok.task.synced` branch around
`kanban/server.ts:2894-2915`. Add `"roadmap.updated"` to
`kanban/server.ts` event-name documentation and to `web/api.js:KNOWN`
(lines 181-193) AND `web/api.js:FORWARDED` (lines 239-250).

**Non-goals:** No cytoscape. No canvas view. The web UI is unchanged
in M26 — only the API exists.

**Files:**

- `kanban/server.ts` — add 8 new `api*` async functions, route
  registration, broadcast calls, **and two new file-watcher
  branches** (see Scope).
- `web/api.js` — add `"roadmap.updated"` to `KNOWN` (line 181) and
  `FORWARDED` (line 239).

**Reuse:**

- `kanban/server.ts:errorResponse`, `jsonResponse`,
  `broadcast`, `apiPatchGoal` shape (read-modify-write + atomic
  helper).
- `kanban/server.ts:ok.task.synced` watcher branch (lines 2894-2915)
  as the pattern for the new roadmap branches.
- `ok/storage.ts:readRoadmap`, `writeRoadmap`, `removeRoadmap` (M25).

**Acceptance criteria:**

- `curl -X POST /api/roadmaps -d '{"title":"X"}'` returns
  `201` and a serialized roadmap with a fresh id.
- `curl -X PATCH /api/roadmaps/:id/milestones/:mid -d '{"status":"in_progress"}'`
  returns `200` and persists.
- `curl -X PATCH /api/roadmaps/:id/layout -d '{"positions":{"mls-X":{"x":1,"y":2}}}'`
  returns `200`; `cat .ok/roadmaps/<id>/layout.json | jq` shows the
  entry.
- A connected SSE client receives `event: roadmap.updated` within
  50 ms of any write above.
- A `PATCH /api/tasks/:tid` with `{"milestoneId":"mls-X"}` writes
  the field and broadcasts `task.updated`.
- `curl -X DELETE /api/roadmaps/:id/milestones/:mid` returns `204`;
  `Task.milestoneId` references are preserved (intentionally
  dangling) — no cascade.
- **CLI fan-out:** running `ok roadmap add --title "CLI only"` from a
  shell while a dashboard tab is connected triggers an `event:
  roadmap.updated` SSE within 250 ms. Asserted by
  `tests/m26-cli-sse-fanout.test.mts`.

**Verification:**

- `tests/m26-roadmap-api.test.mts` — uses `node --test` + a local
  HTTP server fixture; covers every endpoint + auth-free happy
  paths + at least 3 validation rejections.
- `tests/m26-roadmap-sse.test.mts` — connects to a live
  `startOrAttach` server, triggers a write, asserts the SSE event
  arrived within 250 ms.
- `tests/m26-task-milestone-field.test.mts` — verifies
  `Task.milestoneId` patch is honoured by the existing
  `apiUpdateTask`.
- `tests/m26-cli-sse-fanout.test.mts` — gate for CR-SSE-CLI:
  boots the watcher, invokes `ok roadmap add` directly via
  `writeRoadmap()` (no HTTP), asserts the SSE event arrives.
- `npm test`, `npm run check`, `npm run typecheck` all pass.

**DoD:**

- All M26 tests green.
- `docs/OK-PLANNING.md` "Reference" section links to a new
  `docs/ROADMAPS.md` (drafted in M28).
- `CHANGELOG.md` notes the new API surface.
- One commit: `feat(api): add /api/roadmaps endpoints + roadmap.updated SSE + CLI file-watcher fan-out (M26)`.

### M27 — Web canvas (interactive graph)

**Goal:** Ship the `#roadmap` tab with a fully interactive cytoscape
canvas: drag nodes, drag-to-connect, inline-edit title, click empty
canvas to create a milestone, live SSE refresh.

**Scope:**

- Vendor `cytoscape@3.34.2` and
  `cytoscape-edgehandles@4.0.1` (no-jquery) into `web/vendor/`.
  Pin exact versions; document in `web/vendor/README.md` (new file,
  one-line per vendor dep: name, version, upstream URL, license,
  upgrade policy — mirrors the `web/vendor/gsap.min.js` precedent).
- Implement `web/roadmap-view.js`:
  - `mount(root)` creates cytoscape instance + edgehandles +
    `cose-bilkent` layout.
  - `unmount()` follows the four-step cleanup contract from §5.3
    (disable edgehandles → `cy.removeAllListeners()` → `cy.destroy()`
    → drop host listeners and clear container).
  - Toolbar buttons wire to canvas methods.
  - Subscribes to `OpenKanAPI.on("roadmap.updated", refresh)`.
  - Inline edit uses `node.popperRef()` + `contenteditable` overlay.
  - Drag-end debounce 250 ms then PATCH layout.
- Implement `web/roadmap-view.css` (toolbar, canvas, node labels,
  status colours).
- Edit `web/index.html`: tab button, `<section>`, vendor `<script>`
  tags, stylesheet `<link>`.
- **Critical — edit `web/app.js:activateTab` to add `'roadmap'` to the
  `valid[]` array at line 3527.** Without this, any user navigating
  via `#tab=roadmap` is silently redirected to `tasks`. The edit is:
  `const valid = ["home", "tasks", "changelog", "contributors", "docs", "goals", "agents", "insights", "roadmap"];`
  (insert `"roadmap"` at the end). Then add a new `else if (name ===
  "roadmap")` arm that calls `window.OpenKanRoadmap?.mount(root)`,
  and add `window.OpenKanRoadmap?.unmount?.()` to the existing
  `else if (name === "tasks")` unmount block (lines 3579-3587) so
  leaving the Roadmap tab frees the cytoscape canvas per the cleanup
  contract in §5.3.

**Non-goals:** No CLI changes. No new API endpoints. No new SSE
events. Side panel for tasks is M28.

**Files:**

- `web/vendor/cytoscape.min.js` — vendored.
- `web/vendor/cytoscape-edgehandles.min.js` — vendored (no-jquery).
- `web/vendor/README.md` — new file listing pinned versions and
  the upstream URLs they were fetched from.
- `web/roadmap-view.js` — new file.
- `web/roadmap-view.css` — new file.
- `web/index.html` — 4 small additions (tab, pane, scripts, css).
- `web/app.js` — extend `valid[]` array at line 3527, add
  `else if (name === "roadmap")` mount arm, add
  `OpenKanRoadmap.unmount()` to the existing `tasks` unmount block.
- `web/api.js` — add `"roadmap.updated"` to `KNOWN` (line 181) and
  `FORWARDED` (line 239).

**Reuse:**

- `web/goals-view.js` shape (IIFE + `mount/unmount`); note that the
  cleanup contract is heavier because cytoscape owns canvas resources
  (see §5.3).
- `window.OpenKanAPI.api(...)` wrapper.
- `web/index.html` existing tab-button + tab-pane pattern.
- The DOM stub from `tests/charts.test.mts:91-94` for view tests
  (no jsdom).

**Acceptance criteria:**

- Loading the page and clicking the `Roadmap` tab renders the
  canvas within 1 s on a project with 1 roadmap and 5 milestones.
- A user navigating to `…/#tab=roadmap` lands on the Roadmap tab
  (not silently redirected to tasks). Asserted by
  `tests/m27-activate-tab-roadmap.test.mts`.
- Dragging a node moves it visually; releasing the mouse persists
  the new position to `.ok/roadmaps/<id>/layout.json` within
  500 ms.
- Dragging from a node's edge handle to another node's body
  creates a visible edge; the source milestone's `dependsOn`
  array updates in `.ok/roadmaps/<id>.json`.
- Double-clicking a node opens an inline `<input>` for the
  title; pressing Enter saves; pressing Escape reverts.
- Clicking a milestone's `targetDate` pill opens a date picker;
  selecting a date commits via PATCH and re-renders the pill;
  clearing the picker commits `targetDate: null`.
- Clicking empty canvas creates a new milestone via POST and
  focuses it; the new node appears at the click location (not at
  `(0, 0)` or at a `cose-bilkent`-auto-placed coordinate), and
  `.ok/roadmaps/<id>/layout.json` records the position in the same
  write.
- Two browser tabs open at the same time — creating a milestone in
  one makes it appear in the other within 500 ms via SSE.
- Mounting, unmounting, then remounting the Roadmap view leaves
  exactly one edgehandles listener and one `ResizeObserver`
  registered (no duplicates, no leaks). Asserted by
  `tests/m27-mount-unmount-cycle.test.mts` per §5.3.
- No console errors in the browser devtools for any of the above
  flows.

**Verification:**

- `tests/m27-roadmap-view-load.test.mts` — uses a **minimal DOM
  stub** mirroring `tests/charts.test.mts:91-94` (NO `jsdom`
  dependency; the project devDependencies at
  `package.json:67-72` do not include jsdom and adding it would
  cost ~5 MB on every install). The stub exposes
  `createElement`, `appendChild`, `removeChild`, `addEventListener`,
  `removeEventListener`, `querySelector`, and `innerHTML`. The test
  asserts that `OpenKanRoadmap.mount(root)` populates the container
  and that `unmount()` runs all four cleanup steps (verified via
  spies on `cy.removeAllListeners`, `cy.destroy`, and the host
  `removeEventListener`). UNVERIFIED — confirmed by critic that the stub at lines 89-95 provides `globalThis.document = new StubDocument()`; the six specific methods (`createElement`, `appendChild`, `removeChild`, `addEventListener`, `removeEventListener`, `querySelector`, `innerHTML`) must be checked against the actual `StubDocument` implementation during M27 dispatch.
- `tests/m27-roadmap-sse-bus.test.mts` — stubs `OpenKanAPI.on`,
  asserts the view registers a handler for `roadmap.updated`.
- `tests/m27-activate-tab-roadmap.test.mts` — string-greps
  `web/app.js` and asserts that `"roadmap"` appears inside the
  `valid` array literal at line 3527 and that a `name === "roadmap"`
  branch exists; if either is missing the test fails (gate for
  CR-TAB-LIST).
- `tests/m27-mount-unmount-cycle.test.mts` — DOM stub mounts
  `OpenKanRoadmap.mount(root)`, calls `unmount()`, mounts again,
  asserts `cy.listeners("eh:start").length === 1` and the
  `ResizeObserver` constructor was called exactly once. Gate for
  CR-OBSERVER.
- Manual screenshot evidence (committed as
  `docs/roadmap-canvas-m27.png`) for the drag, drag-to-connect,
  and inline-edit flows. Captured via the existing
  `scripts/test-package.mjs` framework.
- `npm test`, `npm run check`, `npm run typecheck`, `npm run build`
  all pass.
- `git diff --stat` on `web/vendor/` shows three new files only
  (`cytoscape.min.js`, `cytoscape-edgehandles.min.js`, `README.md`),
  no deletions.

**DoD:**

- All M27 tests green.
- Screenshot evidence committed.
- `CHANGELOG.md` notes the new tab.
- One commit: `feat(web): add interactive Roadmap canvas with cytoscape.js (M27)`.

### M28 — Tasks panel, CLI docs, polish

**Goal:** Tie tasks to milestones in the UI (side panel + attach
buttons). Document the new surface in `docs/ROADMAPS.md`. Make the
new entities first-class in the existing `ok-planning` skill.

**Scope:**

- Extend `web/roadmap-view.js` with a side panel rendered to the
  right of the canvas:
  - Lists tasks with the selected milestone's id.
  - Each row: `[Open task]` button + `[Detach]` button.
  - `[Attach existing task…]` button opens a small picker
    (search across `.ok/tasks/`).
- `docs/ROADMAPS.md` — new top-level doc with: data model,
  CLI cheatsheet, API table, canvas UX walkthrough, reversibility
  notes, AND a one-paragraph **disambiguation sidebar** that points
  to `ok prd update --milestone` for the existing `PrdMilestone`
  surface (see §2).
- Update `docs/OK-PLANNING.md` reference section to link
  `docs/ROADMAPS.md`.
- Update `.claude/skills/ok-planning/SKILL.md` and
  `skills/openkan/SKILL.md` to mention `ok roadmap`,
  `ok roadmap-milestone`, `ok task attach/detach` (not `ok milestone`).
- Add a `tests/m28-roadmap-task-panel.test.mts` exercising the
  panel's rendering and detach button.

**Non-goals:** No new SSE events. No new HTTP endpoints. No new
CLI subcommands. No layout migration.

**Files:**

- `web/roadmap-view.js` — add side panel + detach handler.
- `web/roadmap-view.css` — side panel styles.
- `docs/ROADMAPS.md` — new file.
- `docs/OK-PLANNING.md` — append link.
- `.claude/skills/ok-planning/SKILL.md` — append section.
- `skills/openkan/SKILL.md` — append section.

**Reuse:** Every existing surface — the canvas, the API, the CLI,
the SSE bus.

**Acceptance criteria:**

- Clicking a milestone in the canvas shows a side panel with all
  tasks owning that `milestoneId`.
- Clicking `[Detach]` on a task sends `PATCH /api/tasks/:tid` with
  `{milestoneId: null}` and the row disappears on success.
- `[Attach existing task…]` shows a search input; typing filters
  across `.ok/tasks/` titles; clicking a result attaches it.
- `docs/ROADMAPS.md` renders in `web/docs-view.js` (existing MDX
  viewer) without warnings.
- `.claude/skills/ok-planning/SKILL.md` mentions every new
  subcommand (`ok roadmap`, `ok roadmap-milestone`,
  `ok task attach/detach`) AND the API endpoints.
- `docs/ROADMAPS.md` contains an explicit disambiguation note
  pointing users from `roadmap-milestone` back to `ok prd update
  --milestone` for the PRD-internal `PrdMilestone` surface.

**Verification:**

- `tests/m28-roadmap-task-panel.test.mts` — minimal DOM stub
  (mirroring `tests/charts.test.mts:91-94`), click milestone,
  assert side panel populates with 2 stubbed tasks, click detach,
  assert API call. No `jsdom` dependency — see M27 rationale.
- `tests/m28-skill-mentions.test.mjs` — greps the skill files for
  every new subcommand name (including the `ok roadmap-milestone`
  rename).
- `npm test`, `npm run check`, `npm run typecheck`, `npm run build`
  all pass.

**DoD:**

- All M28 tests green.
- `docs/ROADMAPS.md` exists and renders.
- Skill files updated.
- One commit: `feat(docs+web): tasks side panel + ROADMAPS.md + skill sync (M28)`.

## 7. Risks and approval boundaries

| Risk | Mitigation |
|---|---|
| cytoscape bundle bloats the web app (~120–160 kB minified+gz for core + edgehandles) | Vendored under `web/vendor/`. **Important:** `<script defer>` runs on every page load — it is NOT lazy. The bundle cost is amortised across every page load and is unavoidable for any user who opens the Roadmap tab at all. The lazy-mount is achieved by **only constructing the cytoscape instance inside `OpenKanRoadmap.mount(root)`** (which `web/app.js:activateTab` calls when the tab is activated), not by the `<script defer>` attribute. We do not dynamically `await import()` cytoscape because (a) the existing gsap precedent (`web/vendor/gsap.min.js`) uses the same defer-and-mount pattern, and (b) `<script type="module">` shims would require a build step or another DOM marker. Acceptable trade-off for the feature; revisit if a user profile shows non-Roadmap users paying the cost. |
| `Task.milestoneId` round-trip through `kanban/board.ts` mirror writes | `toPlanningTask` (line 278) and `fromPlanningTask` (line 355) MUST both carry `milestoneId`. Without the M25 fix, every HTTP PATCH after `ok task attach` silently drops the field — see CR-DATA-LOSS gate in §2.3 and M25 Scope. |
| Namespace collision with the existing `PrdMilestone` surface (`ok prd update --milestone`) | CLI uses `ok roadmap-milestone …` (not `ok milestone …`); TypeScript exports use `RoadmapMilestone` and `roadmapMilestoneAttach`; cross-reference appears in `bin/ok.ts:help`, `docs/OK-PLANNING.md`, and `docs/ROADMAPS.md` — see §2 disambiguation. |
| CLI writes do not fan out via SSE because the file-watcher switch ignores `.ok/roadmaps/*.json` | M26 extends `kanban/server.ts:2878-2939` with two new branches that broadcast `roadmap.updated` on `.ok/roadmaps/<id>.json` and `.ok/roadmaps/<id>/layout.json` writes — see CR-SSE-CLI gate in M26 Scope. |
| `#tab=roadmap` URL silently redirected to `tasks` because `valid[]` array at `web/app.js:3527` omits `"roadmap"` | M27 explicitly extends `valid[]` and adds a `name === "roadmap"` mount arm + unmount call — see CR-TAB-LIST gate in M27 Scope. |
| `Task.milestoneId` write rate vs drag rate — both write `.ok/tasks/*.json` and could serialise through `ok/storage.ts:writeJson` | Atomic tmp+rename guarantees no corruption. Independent files (tasks vs roadmaps vs layouts) means no contention at the FS level. |
| Stale `positions` after milestone deletion | Reader filters positions against live milestones; dead entries are visually no-op. `ok doctor` flags `layout.json` files referencing missing milestone ids. |
| Cross-tab sync race during heavy drag (tab A drags while tab B edits a milestone) | Both paths use `writeJson` atomic rename; the last write wins per-file. SSE on `roadmap.updated` re-broadcasts to all tabs including the originator — they reconcile via the canonical GET. |
| Web vendor file size bumps git history noticeably (~250 kB total) | Vendored as one commit in M27; subsequent upgrades land in their own commits. Alternatives considered: jsDelivr CDN pin — rejected because it requires an outbound dependency and a single point of failure for an offline-first tool. |
| `web/app.js` is 170 kB already; another ~150 lines of dispatcher logic risk regressions | The change is two `else if` arms + one CSS class — string-isolated. Existing tests in `tests/ui-overhaul.test.mts` and `tests/cli.test.mjs` cover tab routing behaviour and must remain green. |
| cytoscape-edgehandles `4.0.1` has had no npm release since 2020-07-28 (stale upstream) | Acceptable for v1; if the project stalls, M25/M26 surface is fully usable without drag-to-connect (CLI + API + render-only canvas). M27 ships the canvas; users can fall back to `ok roadmap-milestone` + `dependsOn` editing for connections until the extension stabilises further. **Version pin lives in `web/vendor/README.md`** (new file in M27) so a future upgrade is a one-line bump with an explicit upstream-URL audit. |
| **`ok` migration plan** (out-of-scope but dispatched immediately before M25) edits the same files: `bin/ok.ts:main`, `ok/commands/index.ts:runDoctor`, `ok/storage.ts`, `ok/schemas.ts`. | **Coordination rule:** M25 must dispatch strictly after the OK-migration plan's M1 commit lands on `main`. Specifically: `bin/ok.ts:main` (new switch arms), `ok/commands/index.ts:runDoctor` (new validation), `ok/storage.ts` (new readers/writers), and `ok/schemas.ts` (new interfaces + `isTask` extension) are all touched in both plans; a rebase that re-introduces the migration's edits on top of M25 would conflict in every one of these files. M25 DoD includes a `git log --oneline bin/ok.ts ok/commands/index.ts ok/storage.ts ok/schemas.ts` confirmation that the migration commit precedes the M25 commit, and the M25 commit message references the migration PR for traceability.

> UNVERIFIED — confirmed by parallel ralplan run; OK migration in worktree `agent-a6c1e5b7f15aa9db9`, currently critic round 4. Lands before M25. |
| cytoscape canvas resources leak across mount/unmount cycles | §5.3 enumerates the four-step cleanup contract (`eh.disable` → `cy.removeAllListeners` → `cy.destroy` → host-DOM teardown); `tests/m27-mount-unmount-cycle.test.mts` is the regression gate (CR-OBSERVER). |
| Adding `jsdom` would add ~5 MB to devDependencies for one test file | Spec uses a minimal DOM stub mirroring `tests/charts.test.mts:91-94` everywhere cytoscape or DOM stubbing is needed — see CR-JSDOM gate in M27 Verification. |

### HITL floor

This plan does **not** cross any of the seven hard-approval
categories:

- **Public API breakage:** none — additive routes and additive
  `Task.milestoneId` field.
- **Destructive operation:** `ok roadmap rm` and
  `DELETE /api/roadmaps/:id` confirm before deleting; layout dir is
  removed atomically; tasks keep dangling `milestoneId`. `ok
  task attach/detach` are non-destructive on the underlying task
  (only mutates the `milestoneId` field).
- **Auth / security:** none — local-only.
- **Migration:** none — existing `.ok/tasks/*.json` files without
  `milestoneId` continue to validate against the updated `isTask`
  (the field is optional).
- **Compliance / PII:** none — local-only.
- **Production incident:** n/a — local tool.
- **Irreversible destruction:** none — every commit is revertible
  to a known-good state via `git revert`.

Push, PR, release, deploy, credential, public-exposure surfaces all
remain under the existing hooks gate; nothing this plan changes that
floor.

## 8. Definition of Done

The roadmap-milestones feature is **complete** when **all** of the
following are true:

- [ ] `npm test` is green. **Zero new failing tests.** The pre-M25
  baseline test count must be preserved or grown.
- [ ] `npm run check` is green.
- [ ] `npm run typecheck` is green.
- [ ] `npm run build` succeeds and the `dist/` artefact includes
  the vendored cytoscape scripts.
- [ ] `make verify-removed-surfaces` (or its current equivalent)
  passes — no removed subsystem re-surfaces.
- [ ] `make verify-repo-structure` (or its current equivalent)
  passes — no untracked files leak outside `.ok/` or the project
  layout.
- [ ] All four milestones (M25, M26, M27, M28) have landed as
  **separate atomic commits** on `main`, each with its own tests
  green on its own commit SHA.
- [ ] `docs/ROADMAPS.md` exists and renders in `web/docs-view.js`
  without warnings.
- [ ] `.claude/skills/ok-planning/SKILL.md` and
  `skills/openkan/SKILL.md` mention every new subcommand (`ok
  roadmap`, `ok roadmap-milestone`, `ok task attach/detach`) and the
  new API surface, AND include the disambiguation note pointing to
  `ok prd update --milestone` for the legacy `PrdMilestone` surface.
- [ ] `CHANGELOG.md` Unreleased section enumerates every new
  surface (CLI, API, web, SSE event), and explicitly notes the
  rename of `ok milestone` → `ok roadmap-milestone` for users
  upgrading from a pre-M25 alpha.
- [ ] A manual smoke-test checklist — open two tabs, create a
  roadmap in tab A via the canvas, drag a milestone in tab B,
  observe live sync; **then** in a third terminal run
  `ok task attach <id> --roadmap-milestone <mlsId>` and observe the dashboard
  tab refresh within 500 ms (the CR-SSE-CLI gate) — is captured as a
  screenshot or short video and linked from `docs/ROADMAPS.md`.
- [ ] `tests/m25-engine-mirror-roundtrip.test.mts` is green
  (CR-DATA-LOSS gate).
- [ ] `tests/m26-cli-sse-fanout.test.mts` is green (CR-SSE-CLI gate).
- [ ] `tests/m27-activate-tab-roadmap.test.mts` is green
  (CR-TAB-LIST gate).
- [ ] `tests/m27-mount-unmount-cycle.test.mts` is green
  (CR-OBSERVER gate).
- [ ] Confirmed via `git log --oneline bin/ok.ts ok/commands/index.ts
  ok/storage.ts ok/schemas.ts` that the OK-migration plan's M1
  commit precedes the M25 commit (CR-OK-MIGRATION-CONTENTION
  coordination rule).
- [ ] `web/vendor/README.md` exists and pins both vendored cytoscape
  packages to exact versions with their upstream URLs (CR-EDGEHANDLES-STALE).
- [ ] The `docs/specs/ralplan/roadmap-milestones.handoff.json` is
  written with run identity, decisions taken, and the four
  recommendations above, so the next ralplan can pick up from this
  state cleanly.
- [ ] `/simplify` (or the Bizar simplify gate) has been run on the
  final diff before the human-approval-gated commit lands.

## 9. Stop condition

Plan-only. The orchestrator persists this spec and the typed handoff
JSON at `docs/specs/ralplan/roadmap-milestones.handoff.json`,
records the run identity, and does **not** invoke any implementation
skill. M25 dispatch is gated on user approval after spec review.

### Round 3 — Cleanup of 5 critic-round-2 MINORs

This subsection records the revisions the planner made in response
to the Iteration 2 Critic review (5 minor findings, 4 unverified
items). Each change is surgical; the round-2 CR-DATA-LOSS fix at
§2.3 lines 267-279 (and the matching M25 Scope edits at lines
454-475) is preserved unchanged.

#### MINOR fixes landed

- **MINOR #1 (field-name inconsistency, lines 336, 466-469, 513):
  standardized on `milestoneId?` everywhere.** Line 336's CLI
  comment now reads `task.milestoneId` (was `task.roadmapMilestoneId`).
  Lines 466-469 now contain a single sentence: "Extend `Task` in
  `kanban/board.ts:30-62` with `milestoneId?: string | null` and
  pass it through `fromPlanningTask` (lines 355-398) so the
  planning->engine direction preserves the field." Line 513's M25
  Files bullet now says `milestoneId?` (was `roadmapMilestoneId?`).
  No remaining reference to `roadmapMilestoneId` in the spec.
- **MINOR #2 (false 'renamed from milestone.ts' / 'renamed from
  roadmapMilestoneAssign' claims, lines 348-353, 485-489, 516-517):
  replaced with 'new file' / 'new helper' language.** `ok/commands/
  milestone.ts` does not exist in the current `ok/commands/`
  directory, so there is nothing to rename from; the new file and
  the new `roadmapMilestoneAttach` helper are described as fresh
  additions. The CR-NAMING disambiguation rationale (§2) stands
  unchanged.
- **MINOR #3 (false `ok task update --milestone` flag reference,
  lines 340-346): corrected to `ok prd update --milestone`.** The
  `--milestone` flag lives only on `ok prd update` at
  `ok/commands/prd.ts:204-211`; `grep -n milestone
  ok/commands/task.ts` returns zero hits. The alias note now
  names the correct namespace.
- **MINOR #4 (missing `targetDate` canvas editing UX, §5.3 lines
  394-408 + M27 acceptance criteria lines 773-774): added a new
  paragraph** describing the date pill in the milestone node's
  footer strip, the `<input type="date">` overlay anchored via
  `node.popperRef()` from `cytoscape-popper@2.0.0`, and the
  `PATCH /api/roadmaps/:rid/milestones/:mid` commit semantics
  (selecting sets, clearing nulls, unset renders `—`). The M27
  acceptance criterion that previously covered only title editing
  was split into a separate title bullet and a new `targetDate`
  pill bullet.
- **MINOR #5 (click-canvas-to-create has no position assignment,
  §5.3 lines 397-398 + M27 acceptance criterion): added an explicit
  position policy.** The POST body now carries `{x, y}` derived
  from the click event in canvas coordinates
  (`cy.nodes().positions()`-relative); the server persists the
  position into `layout.json` at the same time. The M27 acceptance
  criterion now asserts that the new node appears at the click
  location and that `layout.json` records the position in the
  same write.

#### UNVERIFIED annotations added

- **UV#1 (§7 line 921 + §8 line 993-996 — OK-migration plan
  existence):** annotated with `UNVERIFIED — confirmed by parallel
  ralplan run; OK migration in worktree
  agent-a6c1e5b7f15aa9db9, currently critic round 4. Lands before
  M25.`
- **UV#2 (§7 line 920 — cytoscape-edgehandles 4.0.1 maintenance
  status):** WebSearch-confirmed 2026-09-06: last published
  2021-07-28, no commits since Jan 2022. Existing fallback path
  preserved as-is.
- **UV#3 (lines 80, 399-400 — `node.popperRef()` API):**
  annotated with `UNVERIFIED — to be confirmed against
  cytoscape-popper@2.0.0 docs during M27 dispatch.` on both the
  title-edit line and the new targetDate paragraph.
- **UV#4 (§8 line 793-797 — M27 stub surface, six specific DOM
  stub methods):** annotated with `UNVERIFIED — confirmed by
  critic that the stub at lines 89-95 provides
  `globalThis.document = new StubDocument()`; the six specific
  methods must be checked against the actual `StubDocument`
  implementation during M27 dispatch.`

#### CR-DATA-LOSS preservation

The round-2 CR-DATA-LOSS fix at §2.3 lines 267-279 and the
matching M25 Scope edits at lines 454-475 are **preserved
unchanged**. The `Task.milestoneId` round-trip through
`toPlanningTask` (line 278) and `fromPlanningTask` (line 355),
the validator updates in `isTask` (line 65) and `validateTask`
(line 93), and the `tests/m25-engine-mirror-roundtrip.test.mts`
regression gate are intact.

### Round 4 — fix CLI examples at lines 555/1007

This subsection records the planner's response to the Iteration 3
Critic review (1 minor finding). The fix is surgical and limited to
two example commands.

- **MINOR-1 (CLI namespace inconsistency, lines 555 and 1007): the
  `--milestone` flag on `ok task attach` was replaced with
  `--roadmap-milestone`.** Lines 555 (M25 acceptance criterion) and
  1007 (§8 DoD smoke-test step) now use the correct namespace as
  already established by the spec's own CLI surface (lines 336, 344,
  348) and the round-2 MINOR #3 disambiguation note. Active content
  re-grep `ok task attach ... --milestone` (without the `--roadmap-`
  prefix) returns zero matches; only narrative occurrences like
  "ok task attach / ok task detach" prose remain.

The CR-DATA-LOSS fix at §2.3 lines 267-279 and the matching M25 Scope
edits at lines 454-475 are preserved unchanged.

## 10. Iteration 2 changes

This section records the revisions the planner made in response to
the Iteration 1 Critic review (1 critical, 4 major, 5 minor
findings). Each change maps to one critic finding; reviewers can
audit the diff against the originals by following the references.

### Criticals

- **CR-DATA-LOSS — fixed.** `Task.milestoneId` will no longer be
  dropped by `kanban/board.ts:toPlanningTask` /
  `fromPlanningTask` after every HTTP PATCH. The §2.3 data model
  paragraph and the M25 Scope now enumerate every required edit
  (`kanban/board.ts:278-292`, `kanban/board.ts:355-398`, plus
  `ok/schemas.ts:Task`, `isTask`, `validateTask`). A new regression
  test `tests/m25-engine-mirror-roundtrip.test.mts` is the gate; its
  absence in the original plan was the root cause.

### Majors

- **CR-NAMING — fixed (option (a): rename CLI namespace).** The
  disambiguation paragraph at the top of §2 makes the overload
  explicit. The new CLI surface is `ok roadmap-milestone …` (not
  `ok milestone …`); the TS exports are `RoadmapMilestone` and
  `roadmapMilestoneAttach`. `bin/ok.ts:help`,
  `docs/OK-PLANNING.md`, and `docs/ROADMAPS.md` cross-reference the
  two surfaces.
- **CR-SSE-CLI — fixed.** The M26 Scope now adds two new branches
  to `kanban/server.ts:2878-2939` that broadcast `roadmap.updated`
  for `.ok/roadmaps/*.json` and `.ok/roadmaps/<id>/layout.json`
  writes, mirroring the existing `ok.task.synced` pattern at
  lines 2894-2915. `tests/m26-cli-sse-fanout.test.mts` is the gate.
- **CR-TAB-LIST — fixed.** The M27 Scope now explicitly enumerates
  extending the `valid[]` array at `web/app.js:3527`, adding the
  `name === "roadmap"` mount arm, and wiring `OpenKanRoadmap.unmount`
  into the existing `tasks` unmount block (lines 3579-3587).
  `tests/m27-activate-tab-roadmap.test.mts` is the gate.
- **CR-JSDOM — fixed.** Every test reference to `jsdom` in the spec
  is replaced with the minimal DOM stub pattern from
  `tests/charts.test.mts:91-94`; no `jsdom` is added to
  devDependencies, preserving the ~5 MB install budget. The
  M27 + M28 Verification sections now read explicitly
  "no `jsdom` dependency".

### Minors

- **CR-DEFER-MISLABEL — fixed.** The §7 Risks table now correctly
  states that `<script defer>` runs on every page load (it is NOT
  lazy), and explains how the lazy-mount is achieved via
  `OpenKanRoadmap.mount(root)` rather than defer. The original
  "defer + lazy mount" phrasing has been removed.
- **CR-CLI-FORMAT — fixed.** §4 (CLI surface) now specifies padded
  columns matching `ok/commands/task.ts:56-66`; the original
  "tab-separated" line is gone.
- **CR-EDGEHANDLES-STALE — folded in.** The §7 Risk row for
  cytoscape-edgehandles is preserved AND now points to
  `web/vendor/README.md` (a new M27 file) as the version-pinning
  audit trail.
- **CR-OK-MIGRATION-CONTENTION — fixed.** The §7 Risks table now
  contains an explicit coordination rule for M25 dispatch ordering
  relative to the OK-migration plan, naming the four shared files
  (`bin/ok.ts`, `ok/commands/index.ts`, `ok/storage.ts`,
  `ok/schemas.ts`). The §8 DoD adds a `git log` confirmation gate.
- **CR-OBSERVER — fixed.** §5.3 now enumerates the four-step cytoscape
  cleanup contract (`eh.disable` → `cy.removeAllListeners` →
  `cy.destroy` → host-DOM teardown). M27 Verification adds
  `tests/m27-mount-unmount-cycle.test.mts` as the regression gate
  (asserts one edgehandles listener + one `ResizeObserver` per
  mount).

### Audit summary

- §2 (Data model): 1 new disambiguation paragraph + 1 new
  round-trip-risk paragraph.
- §4 (CLI surface): CLI subcommand block rewritten with `ok
  roadmap-milestone` rename + padded-column output note + alias
  caveat.
- §5.3 (Canvas UX): 4-step cleanup contract + regression test.
- §6 / M25: scope expanded to enumerate `kanban/board.ts` edits,
  add `m25-engine-mirror-roundtrip.test.mts`, rename the new file to
  `ok/commands/roadmap-milestone.ts`, update acceptance criteria
  and DoD commit title.
- §6 / M26: scope expanded to extend `kanban/server.ts` file-watcher
  switch; verification adds `m26-cli-sse-fanout.test.mts`.
- §6 / M27: scope expanded to extend `web/app.js:activateTab` `valid[]`
  array; verification replaces `jsdom` with DOM stub and adds
  `m27-activate-tab-roadmap.test.mts` + `m27-mount-unmount-cycle.test.mts`.
- §6 / M28: verification replaces `jsdom` with DOM stub; skill
  mentions updated to use `ok roadmap-milestone`; new disambiguation
  sidebar in `docs/ROADMAPS.md`.
- §7 (Risks): 6 new rows added (defer-mislabelled, namespace
  collision, CLI SSE fan-out, tab-list routing, OK-migration
  coordination, jsdom cost); cytoscape-edgehandles row updated with
  pinning reference.
- §8 (DoD): 6 new checkbox items for the critic-finding regression
  gates and the smoke-test extension.
- §10 (this section): audit trail for the reviewer.
