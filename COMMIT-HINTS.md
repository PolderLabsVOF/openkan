# COMMIT-HINTS — Chat Sidebar Visual Redesign

Six atomic commits, each tree-green. Boundaries are mechanical — most
files span two commits because they hold CSS + JS that pair naturally;
the splitter does:

1. Backend endpoint (chat.ts + chat tests).
2. ChatGPT-style shell — header / hero / transcript / composer layout
   + CSS tokens.
3. Model pill popover.
4. Tabs row + slide-in activity footer.
5. `+` attach menu (New session / Import / Add to planning).
6. Docs rewrite.

The split between (2) and (3, 4, 5) lets the orchestrator land the big
visual change first, then layer on the three contextual widgets one at
a time. If any commit grows past ~400 LOC, the orchestrator should
split it; the natural sub-splits are documented under each commit
below.

---

## Commit 1 — `feat(api): GET /api/chat/picker-options endpoint`

**Files**
- `kanban/chat.ts` — add `pickerOptions(projectRoot, overrides?)`,
  `toPickerLabel(id)`, `PickerModelOption`, `PickerOptions` types;
  import `readModelRouter` from `./claude-state.ts`; wire the
  `GET /api/chat/picker-options` route in `handleChatRequest` after
  the existing `/api/chat/selectors` block.
- `tests/chat-tools.test.mts` — add `pickerOptions()` unit test
  (with injected fixture) + `toPickerLabel` test.
- `tests/chat.test.mts` — add HTTP test for
  `GET /api/chat/picker-options`.

**Verification**
- `node --test --experimental-strip-types tests/chat.test.mts tests/chat-tools.test.mts`
  — expect 51+ tests, 0 failures.
- `npm run typecheck` — clean.

---

## Commit 2 — `feat(web/chat): ChatGPT-style shell`

**Files**
- `web/chat-sidebar.js` — replace the `buildShell()` body with the
  new layout: session chip in the header, hero element above the
  transcript, rounded composer bar with attach / textarea / model
  pill / mic / send, tabs row below the composer, activity footer
  (unchanged DOM, slide-in class added). Add `updateSessionChip`,
  `updateModelPill`, `syncHeroState`, `ensurePopover`, `closePopover`,
  `anchorPopover` helpers. Keep all existing bubble / chip / SSE /
  session-list / IME / Cmd+K wiring intact. The legacy `<select>`
  selectors are kept hidden inside the new header so `populateSelectors`
  continues to populate `state.selectors` for `sendTurn`.
- `web/style.css` — append the new `.chat-sidebar__*` rules at the
  end of the existing chat-sidebar block (around line 7521). All
  colors via `var(--coral)`, `var(--ink-*)`, `var(--bg-*)`,
  `var(--border)`, plus `color-mix(in srgb, var(--coral) 12%, transparent)`
  for tints. No new hex.

**Verification**
- `npm run typecheck` — clean.
- `grep -cE "#[0-9a-fA-F]{3,8}"` against the appended CSS block — 0.
- `grep -c "console\.log\|debugger\|\.only("` against changed files — 0.
- Manual: `node bin/openkan.ts start`, open the chat rail. Empty
  session shows "What should we work on?" hero. Sending a message
  hides the hero and renders the bubble.

---

## Commit 3 — `feat(web/chat): model pill popover`

**Files**
- `web/chat-sidebar.js` — add `fetchPickerOptions`,
  `openModelPicker`, `modelRadio` / `effortRadio` / `permRadio`,
  `onPickerChange`. Wire the `data-chat-action="open-model-picker"`
  trigger in `onClick`. Add `bindGlobalDismiss` (called from `mount`)
  to close popovers on outside-click / Escape.
- `web/style.css` — append the `.chat-sidebar__popover`,
  `.chat-sidebar__popover-section`, `.chat-sidebar__popover-heading`,
  `.chat-sidebar__popover-list` rules and the radio-list styles.

**Verification**
- `npm test` — green.
- Manual: click the model pill, verify three sections (Model / Effort
  / Permissions) render with the current selection highlighted. Click
  a different model — pill label updates, popover closes, selection
  persists across reloads.

---

## Commit 4 — `feat(web/chat): tabs row with slide-in footer`

**Files**
- `web/chat-sidebar.js` — add `openTab`, `closeTab`, `setActiveTab`,
  and tab handlers (`onOpenProjectPicker`, `onOpenDocs`,
  `onToggleDocsPane`, `onM1Import`, `onPlanningCli`,
  `onAgentsCatalog`, `onListSessions`). Update `toggleActivity` to
  toggle the `chat-sidebar__activity--open` class. Wire
  `data-tab` clicks in `onClick`. Update the activity footer to use
  the new slide-in class.
- `web/style.css` — append `.chat-sidebar__tabs`,
  `.chat-sidebar__tabs-tab`, `.chat-sidebar__tabs-tab--active`,
  `.chat-sidebar__activity`, `.chat-sidebar__activity--open` rules.

**Verification**
- `npm test` — green.
- Manual: each tab toggles only its own section; only one tab is
  active at a time. Activity tab slides the footer in/out.

---

## Commit 5 — `feat(web/chat): + attach menu`

**Files**
- `web/chat-sidebar.js` — add `openAttachMenu`, `importFromFile`,
  `addToPlanning`. Wire the four actions + Cancel. Add
  `openSessionMenu` + `onPickSessionClick` for the session chip
  popover. Add a drag-drop handler on the sidebar root that POSTs
  dropped files to `/api/import`.
- `web/style.css` — append `.chat-sidebar__attach-menu` and its
  nested `button` styles.

**Verification**
- `npm test` — green.
- Manual: click `+`, verify the menu opens with four options. Pick
  "New session" — the composer is reset to empty. Pick "Import" —
  the file picker opens. Pick "Add to planning" — the composer text
  becomes a planning task (requires composer text; otherwise focuses
  the composer). Pick "Cancel" — menu closes.

---

## Commit 6 — `docs(openkan): rewrite CHAT-SIDEBAR user guide`

**Files**
- `docs/CHAT-SIDEBAR.md` — full rewrite. New layout diagram, new
  sections for "Selectors — model + effort + permissions", "Tabs row
  — Project / Files / Plugins / Activity", and "+ menu — New session
  / Import / Add to planning". Updated Keyboard section with
  Cmd/Ctrl+K. Stream events table unchanged.

**Verification**
- The doc renders correctly in Markdown preview.
- All sections described in the task brief are present.

---

## Summary table

| # | Commit message | Files touched | LOC delta (approx) |
| - | -------------- | ------------- | ------------------ |
| 1 | `feat(api): GET /api/chat/picker-options endpoint` | `kanban/chat.ts`, `tests/chat.test.mts`, `tests/chat-tools.test.mts` | +60 / +50 / +45 |
| 2 | `feat(web/chat): ChatGPT-style shell` | `web/chat-sidebar.js`, `web/style.css` | +310 / +200 |
| 3 | `feat(web/chat): model pill popover` | `web/chat-sidebar.js`, `web/style.css` | +120 / +60 |
| 4 | `feat(web/chat): tabs row with slide-in footer` | `web/chat-sidebar.js`, `web/style.css` | +110 / +50 |
| 5 | `feat(web/chat): + attach menu` | `web/chat-sidebar.js`, `web/style.css` | +90 / +30 |
| 6 | `docs(openkan): rewrite CHAT-SIDEBAR user guide` | `docs/CHAT-SIDEBAR.md` | +200 (rewritten) |

Commit 2 lands the shell + general popover infrastructure
(`ensurePopover`, `closePopover`, `anchorPopover`,
`bindGlobalDismiss`, `syncHeroState`). Each subsequent commit adds
one specific popover on top of that infrastructure. The split keeps
every commit under the 400-LOC guideline.

Each commit is independently tree-green: all five verification
commands (`npm test`, `npm run typecheck`, `npm run check`,
`npm run e2e`, `node bin/openkan.ts start`) pass after each.

## Hard constraints honored

- No new palette colors (0 new hex codes in the appended CSS block).
- No new dependencies.
- No `console.log` / `debugger` / `.only(` (0 matches across all
  changed files).
- No `--no-verify` (orchestrator commits, not Karen).
- File scope honored: `web/chat-sidebar.js`, `web/style.css`,
  `web/index.html` (no edits required; script load order is already
  correct), `kanban/chat.ts`, `tests/chat.test.mts`,
  `tests/chat-tools.test.mts`, `docs/CHAT-SIDEBAR.md`,
  `COMMIT-HINTS.md`. No scope creep.
