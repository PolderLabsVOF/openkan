# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The installer now keeps the OpenKan workflow skill synchronized for Codex,
  Claude Code, and shared agent skill discovery.
- The OpenKan skill now requires agents to claim durable tasks, keep task
  workspaces current, avoid overlapping active work, and record verification
  evidence before completion.
- The installer now owns a dedicated application directory at
  `${XDG_DATA_HOME:-$HOME/.local/share}/openkan` and updates it atomically.
- A single hosted `install.sh` can now bootstrap the complete source archive
  when piped directly to Bash.
- Production dependencies are installed inside the OpenKan application
  directory instead of being merged into another application's package.
- The `openkan` command is linked from a configurable `OPENKAN_BIN_DIR`,
  defaulting to `~/.local/bin`.

### Removed

- The retired host-specific plugin adapter and its SDK dependency.
- Legacy host branding from source, documentation, examples, and templates.

## [0.3.0] — 2026-07-30

### Added (Bizar control plane)

- **Bizar workspace:** OpenKan now surfaces Bizar agents, durable tasks,
  background sessions, feature status, progress, and message history in one
  dedicated management view.
- **Agent and session controls:** start named Bizar agents, send messages to
  running sessions, stop sessions, and receive live state updates.
- **Durable task controls:** create, claim, heartbeat, complete, and cancel
  Bizar tasks without bypassing Bizar's CLI and storage contracts.
- **REST and WebSocket bridge:** the OpenKan server delegates mutations to
  `bizar control` through a JSON CLI boundary and streams snapshots to the UI
  over a loopback-only WebSocket endpoint.
- **Cross-project verification:** `npm run e2e` starts the real OpenKan server
  and verifies Bizar state through REST, WebSocket, and browser assets.

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

## [0.2.0] — 2026-07-06

Released as **v0.2.0**.

- M2 shipped — Source link on every task.
- M3 shipped — Drift detection.
- M6 shipped — Sanity check script.
- M18 shipped — Final UI overhaul pass.

### Added (M2 — Source link on every task)

- Tasks imported from project docs via `kanban_import` now render a Source
  field in the task MDX: `> 📄 Source: docs/roadmap.mdx:42 (imported from line 42)`.
- The web UI shows a clickable source chip on every imported task card and in
  the task view's metadata panel. Clicking opens the source file at the
  given line in a new tab.

### Added (M3 — Drift detection)

- Imported tasks now store a `sourceHash` (sha256 of the source file at
  import time). The kanban server runs `fs.watch` on `.openkan/` and
  re-checks the hash on every file change; if the file's content hash
  diverges, the task's `stale: true` flag flips on.
- The web UI shows a "Stale" badge on stale cards and a "Re-derive tags"
  button in the task view to clear the flag.

### Added (M6 — Sanity check script)

- `npm run check` (or `node --experimental-strip-types scripts/sanity-check.ts`)
  validates the active project's `.openkan/` state. Catches: duplicate
  task IDs, missing source paths, stale tasks in `done` column, and
  orphaned per-task files. Exits non-zero on errors.

### Added (Dashboard polish)

- Source link chip on every task card and in the task view's metadata.
- Stale indicator (badge + button) for tasks whose source has changed.
- Full UI overhaul: tightened spacing rhythm (4/8/12/16/24/32),
  unified button/checkbox/pill treatments, redesigned toasts, modal
  animations, glassy topbar with `backdrop-filter: blur(12px) saturate(140%)`,
  focus rings, hover/active feedback, ARIA.
- New `npm run check` script.

### Fixed

- Right-click context menu actions now fire reliably (flattened submenus,
  removed dead submenu ghost elements that ate clicks, single
  capture-phase dismiss listener).
- Inline comment composer was silently dropping `author` when the
  /api/me round-trip raced the click; now reads the cached user
  synchronously.
- Project selector dropdown closes on outside click, Escape, and the
  second click on the trigger.
- Auto-detect on startup no longer creates duplicate entries (dedup
  by resolved path).
- Live `changelog.jsonl` no longer commits to git; the per-task
  `comments.json` and `inputs.json` do (for shared authorship).
- MDX frontmatter is no longer rendered as raw text in the task view;
  stripped before `marked()` rendering. `metadata.description` on the
  GET response is the frontmatter-stripped body text.

### Changed

- `package.json` adds `"check"` script.
- `install.sh` updated to deploy the new directories (`bin/`, `command/`,
  `skill/`) and bumps the install message to mention four tabs.

## [0.1.0] — 2026-07-06

### Added

- Initial plugin release — openkan v0.1.
- Five-column kanban board (Backlog, To Do, In Progress, Review, Done) served
  at `http://127.0.0.1:7777/`.
- Live UI updates over Server-Sent Events with polling fallback.
- Drag-and-drop between columns with optimistic UI and revert on error.
- Four initial agent tools: `kanban_add`, `kanban_move`, `kanban_start`,
  `kanban_view`.
- Per-task actions: Start (dispatches the agent), Abort, Delete, View Artifact.
- MDX artifact mirror under `.openkan/tasks/` and `.openkan/sessions/`.
- Initial host-integrated installer.

[Unreleased]: https://github.com/PolderLabsVOF/openkan/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PolderLabsVOF/openkan/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/PolderLabsVOF/openkan/releases/tag/v0.2.1
[0.2.0]: https://github.com/PolderLabsVOF/openkan/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PolderLabsVOF/openkan/releases/tag/v0.1.0
