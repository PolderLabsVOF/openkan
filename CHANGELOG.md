# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-09-08

### Added

- **Board-sync (single-store, dual API).** `ok task add` now posts to the local
  dashboard with the new `tsk-*` id as `clientId` so the task appears on the
  board at `http://127.0.0.1:7777/` immediately. When the dashboard is offline,
  `ok task add` falls back to writing `.ok/board.json` directly; the boot-time
  reconciler promotes any pending offline entries onto the board on the next
  server start, idempotent by `clientId`. `apiCreateTask` accepts `clientId`
  and refuses to create duplicates when a board task already carries that id
  (new optional `offlineMirrorId?: string` field). `ok task claim`,
  `ok task heartbeat`, and `ok task complete` now PATCH the matching board
  task, not just the offline cache, so agent leases are visible to operators
  on the dashboard.
- `ok board delete <id>` — new subcommand that calls `DELETE /api/tasks/<id>`.
  Replaces the previous need to issue raw `DELETE` HTTP calls when an operator
  needed to clean up an accidental duplicate.

### Fixed

- `ok serve --mode=background` (and `ok start --mode=background`): the v0.5.1 fix
  (`detachForBackground()` + `await new Promise(() => {})`) only unref'd stdio handles,
  which does NOT free the controlling terminal while the HTTP listener keeps the Node
  event loop alive. The CLI process remained attached to the TTY and the user's shell
  prompt never returned. Replaced with a proper spawn-detach pattern: the parent CLI
  spawns a detached child running `--mode=foreground` (which binds the port), waits
  for HTTP to respond, writes `pid:port` to the pidfile, prints the startup message,
  and exits 0. The detached child owns the HTTP listener; `ok stop` SIGTERMs the
  child PID. On Windows, `windowsHide: true` suppresses the detached child's console
  window.
- Windows CLI: resolve `PROJECT_ROOT` with `fileURLToPath` so test path
  lookups stop emitting `C:\C:\...` and can find `bin/ok.ts`; the previous
  `URL.pathname` form failed all 11 cases in `tests/cli.test.mjs` on
  Windows with "Cannot find module".
- Windows CLI: offender scan in `tests/cli-migration.test.mts` excludes
  itself by resolved absolute path so platform-native separators no longer
  flag the test file as a legacy `bin/openkan` reference.
- `ok --version` in the compiled `dist/` layout walks up to the filesystem
  root before giving up on `package.json`; previously `node dist/bin/ok.js
  --version` printed "ok: version unavailable".
- Windows CLI: compare entrypoint file URLs correctly so `ok` commands run
  instead of exiting silently; also handle spaces, `#`, and `%` in install paths.
- Windows atomic writes: `kanban/io.ts:writeFileAtomic` now uses a unique
  `<path>.tmp-<pid>-<ts>-<rand8>` suffix per call, retries the rename
  briefly on EPERM/EBUSY/EACCES (antivirus/indexer/OneDrive holds), and
  best-effort unlinks the tmp on unrecoverable failure so the next
  persist never collides with a leftover orphan. POSIX behavior
  unchanged (single `renameSync` on the happy path).
- Windows session archive: `kanban/chat.ts:archiveSession` routes through
  new `kanban/io.ts:moveOver` so re-archiving an already-archived
  session replaces the destination (Windows EEXIST) and survives brief
  AV holds via busy-spin retry instead of throwing.

- Chat sidebar: restore the Project / Files / Plugins / Activity tabs row
  that was silently missing from the rendered shell; replace the legacy
  `display:none` CSS with real pill-row styles matching the topbar tabs.

### Added

- **Tray diagnostics.** `bin/tray.ts` now captures the underlying error from
  every failure mode (`node-systray` import failure, constructor failure,
  early-exit failure) and surfaces it verbatim instead of collapsing to a
  generic "libappindicator missing on Linux" message. The fallback reporter
  in `ok serve` / `ok start` prints a platform-aware install hint:
  `apt install libappindicator3-1` on Debian/Ubuntu, `dnf install
  libappindicator-gtk3` on Fedora, a macOS Go-binary check on Darwin, and a
  reinstall hint when the bundled `bin/assets/tray/` icons are missing.
  `tests/tray-error-reporting.test.mts` (16 cases) covers every failure mode
  end-to-end.

### Changed

- Chat top bar trimmed to a single 44px row: conversation title and a
  keyboard-accessible overflow menu (`⋯`). Project, Files, Plugins, Chat
  sessions, and Get desktop app live behind the menu (each wired to the
  existing `openTab()` routing). The legacy Project/Files/Plugins tab row
  is hidden via CSS rather than deleted so the overflow menu continues to
  work. No new npm dependencies.
- Chat sidebar: kanban task references now show the task title prominently,
  the column as a small colored pill, and the truncated task ID as a small
  monospace badge — both in the mention tray and in turn banners. The
  mention tray empty state shows a clear hint.

### Accessibility

- Chat sidebar: the desktop-app CTA is no longer marked as an ARIA tab, so
  screen readers announce it as a regular link rather than as part of the
  Workspace tabs list.
- Chat sidebar: the tabs row now supports the ARIA keyboard pattern
  (Left/Right arrows move focus between tab buttons with wrap, Home/End jump
  to first/last).
- Chat sidebar: the mention tray empty hint is marked `aria-hidden` so the
  visible hint text isn't announced twice alongside the tray's `aria-label`.

## [0.5.1] - 2026-09-07

### Fixed

- `ok serve --mode=background` (and tray-mode fallback when tray init fails)
  no longer exit the CLI immediately after starting the HTTP listener.
  Background-mode processes now detach from the controlling terminal,
  survive parent shell SIGHUP, and stay alive until `ok stop` (SIGTERM)
  cleanly shuts the server down. The pidfile's PID is now reliably the
  live server PID.

## [0.5.0] - 2026-09-07

### Changed

- OK migration M2 — drops the legacy `openkan` binary; `openkan <cmd>`
  invocations no longer work after upgrade. The `ok` CLI is the only
  entry point. README and `install.sh` updated to point at `ok`.

## [0.4.0] - 2026-09-05

### Added

- Bundled OpenKan Claude agent, automatic installation that preserves customized
  profiles, and an explicit `openkan agent install` command.
- Chat agent selection with OpenKan as the default and installed custom profiles
  available alongside the general-purpose Claude Code agent.

### Changed

- Improved chat drafts, send recovery, transcript navigation, and responsive
  composer controls.
- Streamlined task creation with optional settings, retained drafts, accessible
  errors, and duplicate-submission protection.
- Improved project recency handling and refreshed the installation guide.

## [0.3.0]


### Added

- Public npm distribution with compiled JavaScript, both `openkan` and `ok`
  executables, bundled UI, explicit skill installation, and isolated package
  installation/server smoke tests.
- Offline `openkan task`, `plan`, `prd`, `goal`, and `progress` commands;
  command-first board collaboration and project selection without handwritten
  HTTP requests. Planning commands locate an existing parent `.ok/` workspace.
- CI package verification on Node 22 and 24.

### Changed

- The dashboard now uses a cohesive responsive workspace design with a compact
  navigation shell, board health summary, progressive filters, denser task
  cards, mobile column snapping, and a redesigned task workspace.
- Changelog and contributor views now include clear page-level context, and
  switching tabs from task detail closes the detail view instead of leaving it
  over the newly selected section.
- `DESIGN.md` is now the durable product and accessibility contract for
  frontend work.
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
  import time). The kanban server runs `fs.watch` on `.ok/` and
  re-checks the hash on every file change; if the file's content hash
  diverges, the task's `stale: true` flag flips on.
- The web UI shows a "Stale" badge on stale cards and a "Re-derive tags"
  button in the task view to clear the flag.

### Added (M6 — Sanity check script)

- `npm run check` (or `node --experimental-strip-types scripts/sanity-check.ts`)
  validates the active project's `.ok/` state. Catches: duplicate
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
- MDX artifact mirror under `.ok/tasks/` and `.ok/sessions/`.
- Initial host-integrated installer.

[Unreleased]: https://github.com/PolderLabsVOF/openkan/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PolderLabsVOF/openkan/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/PolderLabsVOF/openkan/releases/tag/v0.2.1
[0.2.0]: https://github.com/PolderLabsVOF/openkan/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PolderLabsVOF/openkan/releases/tag/v0.1.0
