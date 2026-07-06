# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — Unreleased

### Added (Docs tab + Multi-project + Comment authorship)

- **Docs tab (4th tab)**: full file browser for the project's `docs/`
  folder. Recursive collapsible tree on the left (4-level deep); rendered
  MDX/MD viewer on the right with the same nice typography as the artifact
  viewer. URL hash `#tab=docs&doc=milestones/M7.mdx` for shareable links.
- **Multi-project support**: registry at `~/.config/openkan/projects.json`,
  one entry per project (id, name, root, addedAt, active).
  `GET /api/projects`, `POST /api/projects`, `DELETE /api/projects/:id`,
  `PATCH /api/projects/:id/active`. CLI flag `--project /abs/path` switches
  at start time. Web UI project switcher in topbar (chip with dropdown).
- **Comment authorship**: every comment now stores `author` (git user
  name or "agent:<name>"), `createdAt`, `resolvedBy`, `resolvedAt`.
  Comments panel shows avatar + name + relative time + resolved footer.
  POST `/api/tasks/:id/comments` requires `author` in the body.
- **File-tree safer**: paths containing `..` or escaping the docs root are
  rejected with 400. Tree walks capped at 4 levels of depth.
- **REST endpoints added**: `GET /api/docs`, `GET /api/docs/<path>?raw=0/1`,
  `GET /api/projects`, plus the multi-project CRUD endpoints above.
- **Comment composer fix**: ensure clicks on MDX blocks open the composer
  reliably; POST includes `author`; the new comments appear in the panel.

### Added (Inline editing + Settings sidebar + UX consistency pass)

- **Inline editing on tasks.** Clicking the title or description in the
  task view makes them contenteditable. Save on Enter / blur / Save
  button. PATCH `/api/tasks/:id` with title/description; tags re-derive
  automatically. The popup Edit modal is still in the footer as a fallback.
- **Settings dialog reorganized.** Sidebar with section nav (Project,
  Server, UI, Sandbox, Import, Contributors, Advanced). Each section's
  fields render in the right panel and persist via
  `PATCH /api/config-sections/:sectionId`.
- **Docs viewer fixed.** `GET /api/docs/<path>` now returns both `html`
  and `rendered` keys (alias) — fixes the "no content" rendering bug.
- **Project selector dropdown** now closes on outside click, Escape, or
  after a selection — was staying open.
- **Right-click context menu actions** debugged and stabilized: flatten
  submenus, drop capture-phase trickery, log every click for visibility.
  Comments composer (with author field) is now wired correctly.
- **Archived items by default hidden** instead of crossed-out in the
  board. The "Archived" filter toggle still exposes them when needed.
- **Full UI/UX consistency pass.** All buttons, chips, fields, transitions,
  focus rings, typography, and spacing now use the unified design tokens
  at the top of `web/style.css`. Spacing rhythm 4/8/12/16/24/32; radii
  4/6/8/999; transitions 120ms; system-ui font stack.
- **Right-click context menu in the task view** with Copy / Copy as
  Markdown / Open in new tab / Add comment here / Copy line / Copy block
  hash.
- **Comment composer reliability.** `console.debug` markers on every
  composer step so a failure is visible. Send `author` (from
  `/api/me`) on POST.
- **New API endpoints:** `GET /api/config-sections`,
  `PATCH /api/config-sections/:sectionId`.

## [0.2.0] — Unreleased

### Added (Edit + Subtasks + Artifact polish + Changelog filter)

- `PATCH /api/tasks/:id` accepts `title` and `description`; updates also
  re-derive tags/category/priority/effort and rewrite the task MDX
- "Edit" button in the task view opens an edit modal pre-filled with the
  current title and description. `e` shortcut on a focused card.
- Tasks can have subtasks via `parentId`. No transitive nesting. Cascade
  on archive/restore/delete. `GET /api/tasks/:id/subtasks` returns the
  list. Subtask section in the task view; count badge on the parent card.
- Artifact viewer (new tab) is fully self-contained: inlined styles,
  proper page scrolling, light/dark theme, "← Back to board" link, nicer
  typography and component styling (code blocks, blockquotes, tables,
  images).
- `?completedOnly=true` on `/api/changelog` returns only terminal events.
  Web UI has a "Completed only" toggle.
- Right-click menu refactored: confirm() dialogs replaced with
  toast-with-undo; submenus flattened; visible toast on every action.
- Filter section rewritten: pill-shaped colored chips for categories and
  tags, avatar-based contributor filters, single-pill archive segmented
  control.
- Auto-assign fix: `git config user.name` (no `--local`) so global git
  configs are picked up too.

### Added (M13: Keyboard + command palette + a11y)

- Full keyboard control: `j/k`/`h/l` navigation, `1-5` to move selected
  cards, `/` to focus search, `?` for help, `Cmd+K` for command palette
- Command palette with fuzzy search across actions and tasks
- Skip-link to main content, visible focus indicators on all interactive
  elements, ARIA roles on cards / modals / palette
- Accessibility: keyboard-navigable everywhere, screen-reader-friendly labels

### Added (M14: Live file-watch + cross-tab sync)

- `fs.watch` on `.openkan/` with debounce — external edits to MDX files
  trigger UI updates without a refresh
- SSE events for file changes: `board.changed`, `task.mdx.changed`,
  `task.comment.added`, `task.input.asked`, `changelog.appended`
- Self-write suppression so the server's own writes don't loop
- `BroadcastChannel('openkan')` cross-tab sync — edit in one tab, see it
  in another
- Exponential-backoff SSE reconnection

### Added (M7.1)

- Auto-tagging and auto-categorization on every task. Derives `tags`, `category`, `priority`, and `effort` from title + description. Override with `#tag` in the title.
- New `GET /api/tags` endpoint for filter UIs.
- New tag/category/priority/effort sidebar in the task detail view.
- New filter bar at the top of the board (category + tag chips).
- New `skills/openkan/SKILL.md` teaching agents how to use openkan effectively.
- `kanban_add` now accepts an optional `tags` argument.
- `skills/openkan/examples/` — 4 example task MDX files: simple-task, with-ask, with-choice, with-preview.

### Added (M10: Dashboard)

- Dashboard with three tabs: Tasks, Changelog, Contributors. URL hash selects the active tab.
- Append-only `.openkan/changelog.jsonl` log of every state change.
- New `GET /api/changelog`, `GET /api/changelog/summary` endpoints.
- `kanban/git.ts` — git-log-derived contributors, commits, and commit-to-task attribution.
- New `GET /api/contributors` endpoint.
- Tasks have an `archived: boolean` flag; archive/restore via `POST /api/tasks/:id/{archive,restore}`.
- `GET /api/tasks-index?includeArchived=true` includes archived tasks.
- Settings modal (gear icon in topbar) reads/writes `.openkan/config.json` via `GET/PATCH /api/settings`.
- Improved drag-and-drop: ghost card, drop indicator line, multi-card drag (Ctrl/Cmd-click), invalid-drop shake.
- Sort dropdown: newest, oldest, priority, effort, last activity.
- Saved filters via `localStorage` (up to 5).
- Filter by contributor (`all | @me | <name>`).
- Light theme support (`:root[data-theme="light"]`).
- New tools: `kanban_archive`, `kanban_restore`, `kanban_changelog`, `kanban_git_attribution`.

### Added (M11: Organize + auto-progress)

- `/organize` OpenCode slash command — delegates to the agent to re-categorize, clean up, and group the board.
- `kanban_organize` tool — applies a batch of operations (re-tag, set priority, move, archive, add area) atomically with a single changelog event.
- `POST /api/organize` endpoint.
- Auto-progress notes — when the OpenCode session reports tool calls, a one-liner is appended to the task's MDX under `## Agent progress`.
- Agent progress timeline in the task detail view.
- "Move to next column" button in the task action menu.
- Archive / Restore buttons in the task action menu.

### Added (M12: Search + bulk + template + real-time)

- `GET /api/search` — full-text + filter search across title, description, tags, assignees, and MDX content
- `POST /api/tasks/bulk` — atomic batch operations (move, set-priority, add-tags, assign, archive, restore, delete)
- `GET /api/template` — canonical task MDX template with all fields explained
- `kanban_search` and `kanban_bulk` tools
- Web UI: search bar in the filter row (live, debounced, URL-persisted)
- Web UI: selection mode (Ctrl/Cmd-click cards; floating action bar for bulk move / priority / archive / delete)
- Web UI: MDX viewer polished typography (headings, code blocks, blockquotes, tables, image embeds, anchor links on hover)
- Web UI: artifact new-tab respects theme via `?theme=`, `localStorage`, or `prefers-color-scheme`
- Auto-template: new tasks with no description start from the canonical MDX template
- Real-time agent progress: tool calls auto-appended to task MDX under `## Agent progress` while the agent is working
- Selection mode and bulk action bar documented in the skill

### Added

- **M7: Tasks index & MDX-centric model** — `.openkan/tasks.json` canonical
  index, per-task directories (`tasks/<id>/` with `task.mdx`, `comments.json`,
  `inputs.json`, `state.json`), `waiting-for-input` state, `<Ask>`/`<Choice>`/
  `<Input>`/`<Confirm>` inline MDX components, `kanban_ask` / `kanban_respond`
  tools, standalone CLI (`openkan` command).
- **M8: Inline comments** — click-to-comment on rendered MDX blocks, anchored
  by content-hash block IDs, persisted to `tasks/<id>/comments.json`, resolved
  comments, `kanban_comments` tool.
- **M9: TSX/JSX previews** — `<Preview tsx="…" props="…">` live previews in a
  sandboxed iframe (`sandbox="allow-scripts"`, no same-origin), built-in
  component library (Button, Card, Row, Column, etc.), `kanban_preview` tool.
- **New tools**: `kanban_ask`, `kanban_respond`, `kanban_comments`,
  `kanban_preview`.
- **New CLI subcommands**: `init`, `start`, `stop`, `status`, `open`, `config`,
  `logs`, `reset` — all accessible via `openkan` after install.
- **New dependency**: `sucrase` (runtime TSX compile via esbuild).
- **Node.js test suite**: `node --test tests/` covering io, inputs, comments,
  mdx-render, migration, tsx-sandbox, and CLI parsing.
- `bin/openkan.mjs` shim for `openkan` command on `$PATH`.
- `.gitignore` now tracks `.openkan/tasks/`, `.openkan/board.json`,
  `.openkan/config.json`, `.openkan/tasks.json` while ignoring transient state.

### Changed

- Static-file route in `kanban/server.ts` now allows any `.html`/`.css`/`.js`/
  `.json`/`.md`/`.txt` file under `webRoot` (Tyr's new `api.js`, `mdx-viewer.js`,
  `task-view.js`, `preview-frame.html` are now served correctly).
- `bin/openkan.mjs` shim ships as the npm `bin` entry point; the `.ts` source
  is compiled at runtime via `node --experimental-strip-types`.

### Fixed

- `kanban/server.ts` static whitelist: regex-based instead of hardcoded list,
  preventing 404s on new web assets.

## [0.1.0] — 2026-07-06

### Added

- Initial plugin release — openkan v0.1.
- Five-column kanban board (Backlog, To Do, In Progress, Review, Done) served
  at `http://127.0.0.1:7777/`.
- Live UI updates over Server-Sent Events with polling fallback.
- Drag-and-drop between columns with optimistic UI and revert on error.
- Four custom OpenCode tools: `kanban_add`, `kanban_move`, `kanban_start`,
  `kanban_view`.
- Per-task actions: Start (dispatches the agent), Abort, Delete, View Artifact.
- MDX artifact mirror under `.openkan/tasks/` and `.openkan/sessions/`.
- Install script (`install.sh`) that copies the plugin into the global OpenCode
  config directory.

[Unreleased]: https://github.com/PolderLabsVOF/openkan/compare/v0.1.0...HEAD
[0.2.0]: https://github.com/PolderLabsVOF/openkan/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PolderLabsVOF/openkan/releases/tag/v0.1.0
