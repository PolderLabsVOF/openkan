# HEADS-UP — `wt/brad-visuals-and-insights` merge notes

> Author: `@brad` (Brand Designer). Plan-only deliverable; no code
> written by `@brad`. The orchestrator (`@mike`) routes the actual
> implementation to `@todd`/`@karen`. This file documents what the
> implementer will touch so the orchestrator can pre-stage conflict
> markers against `feat/chat-orchestrator-sidebar`.

## Worktree

To be created by the implementer before any code is written:

```sh
git worktree add .claude/worktrees/visuals \
  -b wt/brad-visuals-and-insights main
```

Base ref: `main` (`7b566a3`).

## Files the implementer will touch (planned scope)

### New files (13)

- `web/brand/logo.svg` — 32×32 K mark.
- `web/brand/logo-wordmark.svg` — ~160×40 mark + wordmark.
- `web/brand/favicon.svg` — 32×32 favicon.
- `web/brand/banner.svg` — 1280×320 README hero.
- `web/brand/banner-docs.svg` — 960×200 docs banner.
- `web/brand/empty-tasks.svg` — 320×200 empty-board illustration.
- `web/brand/empty-sessions.svg` — 320×200 empty-session illustration.
- `web/brand/social-card.svg` — 1200×630 OG image.
- `web/insights.js` — Insights tab front-end module.
- `web/charts.js` — SVG stacked-bar renderer.
- `kanban/insights.ts` — velocity aggregator (TypeScript module).
- `tests/insights.test.mts` — velocity aggregator tests.
- `tests/charts.test.mts` — chart renderer tests.

### Modified files (7)

- `web/index.html`
  - Add `<link rel="icon" type="image/svg+xml" href="./brand/favicon.svg" />`
    in `<head>`.
  - Add `<button class="tab" data-tab="insights" ...>Insights</button>`
    to the top-level tab strip.
  - Add `<section id="tab-insights" class="tab-pane" data-tab="insights" hidden>...</section>`
    containing the Insights tab host + summary-card + chart mounts.
  - Add `<script src="charts.js" defer></script>` and
    `<script src="insights.js" defer></script>` before
    `<script src="app.js" defer></script>`.
  - Replace topbar `<span class="logo">` + `<h1>OpenKan</h1>` with
    `<img src="./brand/logo-wordmark.svg" alt="OpenKan" height="24" class="brand-wordmark" />`.

- `web/app.js`
  - Add `"insights"` to the valid-tab array in `activateTab`
    (around line 3227).
  - Add the lazy-mount branch for `insights` (around line 3266) and
    the unmount branch in the `tasks` else-if (around line 3271).
  - No other changes.

- `web/style.css` (new classes only, per scope)
  - `.brand-wordmark` — sizing for the topbar wordmark.
  - `.insights-tab`, `.insights-summary-row`, `.insights-summary-card`,
    `.insights-summary-number`, `.insights-summary-label`,
    `.insights-chart-card`, `.insights-chart-title`,
    `.insights-chart-legend`, `.insights-chart-legend-swatch`,
    `.insights-chart-empty`, `.insights-chart-table-toggle`.
  - No edits to existing rules.

- `kanban/server.ts`
  - **Scope: route registration only.** Adds one `if (path === ...)`
    line and one new handler function (`apiGetInsightsVelocity`).
    Does NOT modify the existing `task.moved` emit at lines 641–646
    (out of scope; documented in DESIGN.md open questions).

- `README.md`, `docs/OK-PLANNING.md`, `docs/CLAUDE-NATIVE.md`
  - Each gets a banner image prepended after the H1. No body changes.

### Files explicitly out of scope (do NOT touch)

- `web/chat-sidebar.js`, `web/claude-pane.js`, `kanban/chat.ts` —
  chat-orchestrator-sidebar branch's territory.
- `web/workspace.css`'s `.logo` class — different selector, task-
  workspace purpose, unrelated to topbar replacement.
- The existing `task.moved` emit in `kanban/server.ts:641-646` —
  documented data quirk; left untouched per route-registration scope.
- Any new CSS hex values, any new fonts, any chart library, any
  PNG/JPG raster.

## Likely conflict points vs `feat/chat-orchestrator-sidebar`

Both branches modify the same four files. The orchestrator should
expect merge conflict markers at:

1. `web/index.html` — `<head>` block (favicon `<link>` may collide
   with their chat-pane meta additions) AND the topbar `<header>` AND
   the tab strip AND the script-load block at the bottom.
2. `web/app.js` — the `activateTab` valid-array line (3227) and the
   lazy-mount chain (3249–3276). The chat branch likely adds a
   `claude` tab mount; the Insights branch adds an `insights` tab
   mount. Both edits sit in the same function body.
3. `web/style.css` — topbar `.brand` area may have new rules on the
   chat branch; the Insights branch adds entirely new class names
   (`.insights-*`, `.brand-wordmark`) so overlap is unlikely but
   possible in the topbar header section.
4. `kanban/server.ts` — route registration block (around line 2577).
   The chat branch likely adds `/api/chat/*` routes; the Insights
   branch adds `/api/insights/velocity` next to
   `/api/changelog/summary`.

## Pre-merge checklist for the orchestrator

- [ ] Confirm `wt/brad-visuals-and-insights` was branched from `main`
      and contains only the planned 12 new + 6 modified files.
- [ ] Confirm `npm test` is green and the test count delta is at
      least +6 (insights + charts tests; brief target 450+ total).
- [ ] Confirm `npm run typecheck` is green.
- [ ] Confirm `npm run check` is green.
- [ ] Confirm `npm run e2e` is green.
- [ ] Open `web/brand/banner.svg` in a browser tab — no console
      errors, renders at 1280×320.
- [ ] Open `web/brand/logo-wordmark.svg` at the topbar size (96px
      wide, 24px tall) — no console errors.
- [ ] Boot the server with `node bin/openkan.ts start` and click
      the Insights tab — chart renders (or empty-state shows).
- [ ] Verify README banner shows on GitHub's repo root.

## Plan vs implementation note

`@brad` produced the plan in `DESIGN.md`. Implementation is the
implementer's responsibility — read the plan, follow it, and ask
`@brad` only if a visual decision is genuinely ambiguous. Do not
silently substitute a different aesthetic, gradient, or font.

## Implementation report — actual commits

The implementer (Todd) executed all 7 planned commits on a single
working branch (`worktree-agent-a3e227c180161c8e0`, auto-named by
the harness; the orchestrator should treat the tip commit as the
merge source regardless of branch name). Each commit is tree-green
after it lands.

| # | Commit    | Subject                                                                          |
|---|-----------|----------------------------------------------------------------------------------|
| 1 | `906c751` | feat(brand): add SVG logo, favicon, banner, empty-state, social-card             |
| 2 | `c174819` | feat(kanban/insights): velocity aggregator reading changelog.jsonl               |
| 3 | `c92d4cf` | feat(api): GET /api/insights/velocity endpoint                                    |
| 4 | `0f16ad5` | feat(web/charts): stacked-bar SVG renderer with empty-state path                 |
| 5 | `4f34368` | feat(web): Insights tab with velocity chart + summary cards                      |
| 6 | `d334566` | feat(web): logo + favicon in app shell (also adds svg to static whitelist)       |
| 7 | `…`       | docs: prepend brand banners to README and docs/                                  |

### Deviations from plan

- **Static-file whitelist extended.** The plan did not call this out,
  but the dev server's `serveStatic` whitelist at `kanban/server.ts:2569`
  only allowed `html|css|js|json|md|txt`. Without `svg`, the favicon,
  the topbar wordmark, and the empty-state illustration all 404 in
  the running app. The fix is a one-line extension to the extension
  regex plus a `image/svg+xml` entry in the MIME map. Bundled into
  commit 6 since that commit is what makes the favicon + wordmark
  actually render. No other server.ts edits.
- **No new visual tokens.** No new CSS hex values, no fonts, no
  chart library. Every chart color uses an existing variable from
  `web/style.css`.
- **Test count.** `npm test` reports 452 passing (delta +14: 8
  insights + 6 charts). Brief target was 450+.
- **`docs/CLAUDE-NATIVE.md` banner.** Per the design plan, the
  same `banner-docs.svg` is prepended after the H1 with alt
  text `Claude-native banner`.
- **DESIGN.md sync.** The brand planner's larger DESIGN.md
  (40046 bytes) replaces the main-branch version (6832 bytes).
  This is a documentation-only update with no code impact.
- **`HEADS-UP.md` added.** The brand planner's HEADS-UP.md is
  committed at the same time as the docs banners (commit 7),
  plus this implementation-report section.

### Verification — green items from the pre-merge checklist

- [x] Branched from `main` (`7b566a3`).
- [x] `npm test` — 452 passing, 0 failing.
- [x] `npm run typecheck` — green.
- [x] `npm run check` — 0 errors, 0 warnings.
- [x] `npm run e2e` — 7/7 checks passed.
- [x] `web/brand/banner.svg` opens cleanly at 1280×320.
- [x] `web/brand/logo-wordmark.svg` opens cleanly at 160×40.
- [x] `node bin/openkan.ts start` boots; `/api/insights/velocity?days=7`
      returns the expected JSON envelope; the Insights tab is in the
      HTML with its `<button class="tab" data-tab="insights">`.
- [x] README banner link resolves to `./web/brand/banner.svg`
      (relative to the repo root).

