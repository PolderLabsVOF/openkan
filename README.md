# openkan

MDX-kanban task board plugin for OpenCode. Runs locally, no sync, no auth.

<!-- badge: version -->
v0.1.0 &nbsp;|&nbsp; MIT &nbsp;|&nbsp; [PolderLabs](https://github.com/PolderLabsVOF)

---

OpenKan turns any OpenCode project into a five-column kanban (Backlog, To Do, In Progress, Review, Done). Every task and every agent session is mirrored to disk as MDX under `.openkan/`, giving you a browsable, version-controllable log of all work done.

The plugin starts a small HTTP server on `127.0.0.1` (default port `7777`). There is no auth and no remote access — it is a single-user, single-machine tool. Support for **multi-project** tracking lets you switch between repos via `--project` or the topbar dropdown.

---

## Screenshot

<!-- Add a screenshot of the kanban UI here (capture http://127.0.0.1:7777 in a real session). -->
A screenshot would show a five-column drag-and-drop board with task cards, live SSE updates, and per-task action buttons (Start, Abort, Delete, View Artifact). The UI is plain HTML/CSS with no build step.

---

## Features

**Board**
- Five fixed columns: Backlog, To Do, In Progress, Review, Done
- Drag-and-drop reordering within columns; optimistic UI with revert on error
- Live updates via Server-Sent Events; 5-second polling fallback
- A **Needs you** lane surfaces tasks where the agent is `waiting-for-input`
- **Multi-project** switching via `--project` flag or topbar dropdown

**MDX-centric tasks (M7+)**
- `.openkan/tasks.json` is the canonical tasks index; every task points at a rich MDX artifact
- Each task lives in its own directory: `tasks/<id>/` with `task.mdx`, `comments.json`, `inputs.json`, `state.json`
- The MDX is the workspace — the agent writes to it, the user reads and comments on it
- First-class `waiting-for-input` state: the agent can pause and ask a structured question; the user answers in the UI; the task resumes
- Inline MDX components the agent can use: `<Ask>`, `<Choice>`, `<Input>`, `<Confirm>`, `<Preview>`

**Inline comments (M8+)**
- Click anywhere on a rendered MDX block to leave a comment anchored to that block
- Comments are persisted to `tasks/<id>/comments.json` with the source line and block id
- The agent reads the file and sees exactly which block the user was reacting to
- Resolve / re-open; comment threads survive server restarts

**Live TSX/JSX previews (M9+)**
- The agent can embed a TSX snippet via `<Preview tsx="…" props="…" />` to show an interactive UI
- TSX runs in a sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`); no DOM, no network, no storage
- Built-in component library: `Button`, `Card`, `Row`, `Column`, `Text`, `Heading`, `Image`, `ColorSwatch`, `Code`
- Compile-time and render-time limits; failures degrade to a placeholder, never break the page

**Tools**
- Custom OpenCode tools: `kanban_add`, `kanban_move`, `kanban_start`, `kanban_view`, `kanban_import`
- Plus for the M7+ workflow: `kanban_ask` (agent asks), `kanban_comments` (read with block context), `kanban_preview` (dry-run a TSX snippet)
- Multi-project and **Docs tab** tools: `kanban_projects` (manage projects), `kanban_docs` (browse docs folder)
- `kanban_start` dispatches the OpenCode agent on a task, auto-moving it to In Progress
- `kanban_view` is read-only; supports column and status filters

**Dashboard (M10)**
- Four tabs: **Tasks** (the board), **Docs** (file tree + MDX/MD viewer), **Changelog** (every state change), **Contributors** (git attribution)
- Append-only `.openkan/changelog.jsonl` log of every state change
- Settings modal (gear icon) — reads/writes `.openkan/config.json`
- Improved drag-and-drop with ghost card, drop indicator line, multi-card drag, invalid-drop shake
- Sort dropdown (newest, oldest, priority, effort, last activity)
- Saved filters (`localStorage`, up to 5) and contributor filter (`@me`)
- Light theme support

**Organize (M11)**
- `/organize` OpenCode slash command — delegates to the agent to re-categorize, clean up, and group the board
- `kanban_organize` tool — batch operations applied atomically with a single changelog event
- Auto-progress notes appended to the task MDX under `## Agent progress`
- "Move to next column" / Archive / Restore buttons in the task action menu

**Search and bulk operations (M12)**
- Full-text + filter search across title, description, tags, assignees, and MDX content
- `kanban_search` tool and web UI search bar (live, debounced, URL-persisted)
- `kanban_bulk` tool — atomic batch operations (move, set-priority, add-tags, assign, archive, restore, delete)
- Web UI selection mode: Ctrl/Cmd-click cards to select, floating action bar for bulk actions
- `GET /api/template` — canonical task MDX template returned at runtime
- Canonical template available at `skills/openkan/templates/task.mdx`
- Real-time agent progress: tool calls auto-appended to task MDX under `## Agent progress`; state transitions handled automatically
- Artifact viewer in new tab: `GET /artifacts/tasks/<id>` with theme support

**Keyboard control (M13)**
- `j/k` navigation, `1-5` to move selected cards, `/` to focus search, `Cmd+K` command palette, `?` help overlay
- Skip-link, focus rings, ARIA roles — full keyboard control of the dashboard
- Keyboard-navigable everywhere; screen-reader-friendly labels

**Live sync (M14)**
- `fs.watch` catches external edits (hand-edited MDX, `git pull`, another agent process)
- Cross-tab `BroadcastChannel` keeps two tabs in sync — no refresh needed
- Self-write suppression avoids loops; exponential-backoff SSE reconnection

**Edit + Subtasks**
- `PATCH /api/tasks/:id` to edit title/description; re-derives tags, category, priority, effort
- "Edit" button in task view + `e` keyboard shortcut on a focused card
- Subtasks via `parentId` — no transitive nesting; cascade archive/restore/delete
- `GET /api/tasks/:id/subtasks` returns the subtask list
- Subtask count badge on parent card; subtask section in the task detail view

**Artifact viewer polish**
- Self-contained HTML artifact page — no dependency on the kanban stylesheet
- Inlined light/dark theme via `data-theme` attribute; `?theme=` override
- Proper page scrolling, nicer typography, rounded code blocks, striped tables

**Changelog filter**
- `?completedOnly=true` on `/api/changelog` returns only terminal/done-like events
- Web UI toggle for "Completed only" in the changelog tab

**Multi-project + Docs tab**
- Track tasks across multiple repos from a single CLI; switch between projects via `--project` flag or the topbar dropdown
- A fourth "Docs" tab renders the project's `docs/` folder with a file tree + sanitized MDX/MD viewer

**Comment authorship**
- Every inline comment records the author (git user name, or `agent:<name>`) and timestamp
- The UI shows avatar + name + time + resolved footer

**UX polish (M17)**
- **Inline editing** (click title/description to edit in place), settings dialog with sidebar sections (Project / Server / UI / Sandbox / Import / Contributors / Advanced), full design-token consistency pass across buttons/chips/cards, right-click context menus everywhere (board, task view, project), archived items hidden by default

**Persistence**
- Board state in `.openkan/board.json`; tasks index in `.openkan/tasks.json` (M7)
- Per-task directory `tasks/<id>/` with `task.mdx`, `comments.json`, `inputs.json`, `state.json`
- Per-session MDX transcripts under `.openkan/sessions/`
- `board.mdx` human-readable mirror of board state

**Security**
- Server binds to `127.0.0.1` only — no auth, no LAN exposure
- TSX previews run in a sandboxed iframe: scripts only, no same-origin, no network
- `.openkan/sessions/` is gitignored; treat it as sensitive content

---

## Table of contents

- [Installation](#installation)
- [Usage](#usage)
- [Custom OpenCode tools](#custom-opencode-tools)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Development](#development)
- [Security](#security)
- [Contributing](#contributing)
- [Support](#support)
- [Security policy](#security-policy)
- [Authors and maintainers](#authors-and-maintainers)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Skill

openkan ships with a SKILL.md for AI agents at [`skills/openkan/SKILL.md`](./skills/openkan/SKILL.md). When installed, agents see it automatically and learn how to use the kanban tools, the MDX artifact workflow, live TSX previews, inline comments, the **Docs tab** file browser, and the auto-tagging system. Example task MDX files are in [`skills/openkan/examples/`](./skills/openkan/examples/).

---

## Installation

### Global install (recommended)

```sh
./install.sh
```

Copies the plugin into `~/.config/opencode/` by default. Override the target directory:

```sh
./install.sh /path/to/opencode-config
OPENCODE_CONFIG_DIR=/path/to/opencode-config ./install.sh
```

OpenCode loads the plugin from its global `plugins/` directory and runs `bun install` against the global `package.json` at startup. Restart OpenCode after install, then open `http://127.0.0.1:7777/`.

### Manual install

1. Copy `kanban/` into `~/.config/opencode/kanban/`
2. Copy `plugins/kanban.ts` and `plugins/tools.ts` into `~/.config/opencode/plugins/`
3. Copy `web/` into `~/.config/opencode/web/`
4. Copy `.opencode/command/` into `~/.config/opencode/command/` (adds the `/organize` slash command)
5. Merge `package.json` dependencies into `~/.config/opencode/package.json`
6. Restart OpenCode and open `http://127.0.0.1:7777/`

---

## Usage

### Standalone CLI

The plugin ships with a CLI for managing the server independently of OpenCode:

```sh
# from inside the openkan project
bun bin/openkan.ts init              # create .openkan/ in the current project
bun bin/openkan.ts start             # start the server, default 127.0.0.1:7777
bun bin/openkan.ts open              # open the UI in the default browser
bun bin/openkan.ts status            # is it running? on what port?
bun bin/openkan.ts logs --follow     # tail .openkan/server.log
bun bin/openkan.ts config list       # show all settings
bun bin/openkan.ts config set port 7788
bun bin/openkan.ts stop              # graceful shutdown
bun bin/openkan.ts reset --hard      # wipe everything
```

When installed via `./install.sh`, the same commands are available as `openkan …`:

```sh
openkan start --port 7788
openkan status
```

The CLI shares its start/stop code with the OpenCode plugin entrypoint, so a server started by the CLI is the same server OpenCode would start.

### Inside OpenCode

On first run the plugin creates `.openkan/` in the active project and writes an empty `board.json`.

A typical agent loop using the kanban tools:

1. `kanban_view` — see what is on the board and in which columns
2. `kanban_add title="..." description="..."` — create a new task (defaults to To Do column)
3. `kanban_start taskId="tsk-xxx"` — dispatch the agent on a task; this sets its status to `running` and creates a linked session
4. Do the work; the plugin watches session events and writes a per-session MDX transcript under `.openkan/sessions/`
5. `kanban_move taskId="tsk-xxx" column="done"` — move the task to the Done column when finished

You can also drag-and-drop in the UI at `http://127.0.0.1:7777/`.

---

## Custom OpenCode tools

| Tool | Purpose | Key parameters |
|---|---|---|
| `kanban_add` | Create a new task | `title` (required), `description`, `column` (default: `todo`), `agent` |
| `kanban_move` | Move a task to a different column and/or reorder it | `taskId`, `column` (required), `order` (optional) |
| `kanban_start` | Dispatch the OpenCode agent on a task; creates a linked session | `taskId` (required), `agent` (optional override), `model` (optional, in `providerID/modelID` form) |
| `kanban_view` | Read-only list of tasks, optionally filtered | `column` (optional), `status` (optional: `idle`/`running`/`done`/`failed`/`cancelled`/`waiting-for-input`) |
| `kanban_import` | Scan `.md`/`.mdx` for `- [ ]` and create Backlog tasks | `include`, `exclude`, `configPath` |
| `kanban_ask` | Ask the user a structured question inside the task MDX; sets state to `waiting-for-input` | `taskId`, `type` (`ask`/`choice`/`input`/`confirm`), `question`, `options?`, `blockId?` |
| `kanban_comments` | List comments for a task, with block context (line + excerpt) | `taskId` |
| `kanban_preview` | Dry-run a TSX snippet, returns the compiled JS or an error | `tsx`, `props?` |
| `kanban_archive` | Archive a task (hides from board, keeps on disk) | `taskId` |
| `kanban_restore` | Restore an archived task to its last column and order | `taskId` |
| `kanban_changelog` | Read the append-only change log (`.openkan/changelog.jsonl`) | `count`, `taskId` |
| `kanban_git_attribution` | Get commits and contributors for a task via `git log` | `taskId` |
| `kanban_organize` | Apply a batch of operations atomically with one changelog event | `operations` (JSON array) |
| `kanban_search` | Full-text + filter search across all task content | `query`, `column`, `tags`, `priority` |
| `kanban_bulk` | Atomic batch operation on multiple tasks | `kind` (`move`/`set-priority`/`add-tags`/`archive`/`delete`/`restore`), `taskIds`, `column`, `priority`, `tags` |
| `kanban_edit` | Edit a task's title and/or description (wraps `PATCH /api/tasks/:id`) | `taskId` (required), `title?`, `description?` |
| `kanban_projects` | List, add, remove, or switch active project | `action` (`list`/`add`/`remove`/`switch`), `name`, `root` |
| `kanban_docs` | Browse docs folder, read a doc file | `path` (optional — when omitted returns the tree) |

Task IDs are generated as `tsk-` followed by 8 nanoid characters (e.g. `tsk-abc12345`); session IDs are `ses-xxxxxxxx` of the same shape. The mutating tools broadcast SSE events so the UI updates immediately; read-only tools (`kanban_view`, `kanban_comments`) do not. `kanban_start` resolves the agent name against the OpenCode agent list; it falls back to the primary agent or `"build"`.

**Editing and subtasks** are handled through the REST API directly:
- `PATCH /api/tasks/:id` accepts `{ title, description, tags?, category?, priority?, effort?, parentId? }`
- `POST /api/tasks` with `{ title, parentId: "tsk-..." }` creates a subtask
- `GET /api/tasks/:id/subtasks` lists all subtasks of a task
- `GET /api/changelog?completedOnly=true` filters the changelog to terminal events

All tools run with live file-watch. Changes made via a tool or by editing task MDX files directly appear instantly in any open browser tab — cross-tab sync via `BroadcastChannel` keeps all tabs in sync without a refresh.

## MDX workflow

Each task's MDX is the agent's rich workspace. The agent writes prose, code, and inline components. The user opens the task detail view in the localhost UI, reads the MDX rendered as HTML, and can:

- **Click any block** to leave an inline comment anchored to that block
- **Respond to a prompt** when the task is in `waiting-for-input` (`<Ask>`, `<Choice>`, `<Input>`, `<Confirm>`)
- **Try a live preview** when the agent has embedded a TSX component

The MDX file is the source of truth; `comments.json` and `inputs.json` are the conversation log layered on top.

## MDX template

A canonical task template lives at [`skills/openkan/templates/task.mdx`](./skills/openkan/templates/task.mdx). New tasks with no description auto-initialize from it. The template is also served at runtime via `GET /api/template`.

The template includes frontmatter placeholders for all fields (`title`, `id`, `column`, `state`, `priority`, `effort`, `tags`, `category`, `assignees`) and standard sections: Goal, Context, Acceptance criteria, Files to touch, Safety, and Agent progress.

---

## Configuration

Project settings live in `.openkan/config.json` and are exposed through both a flat and a sectioned API:

- `GET /api/config` — flat object of all keys (legacy, kept for back-compat).
- `GET /api/config-sections` — returns the same config grouped into sections: `project`, `server`, `ui`, `sandbox`, `import`, `contributors`, `advanced`. The settings dialog in the web UI uses this endpoint and renders a left-side sidebar of section links with the fields for the active section on the right.
- `PATCH /api/config-sections/:sectionId` — body `Array<{ key, value }>`; persists the section's fields. The legacy `PATCH /api/settings` continues to work.

Per-task settings (agent, model, assignees) live on the task itself. The server binds to `127.0.0.1` on TCP port `7777`; the port is currently hard-coded in `kanban/server.ts` and not configurable at runtime. (An environment-variable override is a planned future addition.)

---

## Project layout

Plugin source (this repo):

```
openkan/
├── kanban/
│   ├── board.ts            # Board state (board.json read/write, withWrite lock)
│   ├── changelog.ts        # Append-only changelog (.openkan/changelog.jsonl) (M10)
│   ├── git.ts              # Git-log-derived contributors and commit attribution (M10)
│   ├── archive.ts          # Archive/restore task flag (M10)
│   ├── watcher.ts          # fs.watch + SSE file-change events (M14)
│   ├── projects.ts         # Multi-project registry (M16)
│   ├── docs.ts             # Docs folder tree + render (M16)
│   ├── mdx.ts              # MDX serializer for tasks and sessions
│   ├── mdx-render.ts       # Server-side MDX → HTML with block markers (M7+)
│   ├── comments.ts         # Comments CRUD per task (M8+)
│   ├── inputs.ts           # Pending-input request CRUD (M7+)
│   ├── tsx-sandbox.ts      # TSX compile + iframe sandbox HTML (M9+)
│   ├── import.ts           # Checkbox scanner (M1)
│   └── server.ts           # HTTP + SSE server (Node built-in http, port 7777)
├── plugins/
│   ├── kanban.ts           # Main plugin: starts server, wires session events
│   └── tools.ts            # Custom tools (kanban_add/move/start/view/import/ask/comments/preview/archive/restore/changelog/git_attribution/organize)
├── bin/
│   └── openkan.ts          # Standalone CLI (M7+): init/start/stop/status/open/config/logs/reset
├── web/
│   ├── index.html          # Kanban UI with three-tab layout (M10)
│   ├── style.css
│   ├── app.js              # Board + task-detail view router
│   ├── mdx-viewer.js       # MDX viewer with click-to-comment (M8+)
│   ├── docs-view.js        # Docs tab file tree + viewer (M16)
│   ├── settings.js         # Settings modal (M10)
│   ├── changelog-view.js   # Changelog tab (M10) — includes "Completed only" toggle
│   ├── contributors-view.js# Contributors tab with git attribution (M10)
│   ├── keyboard.js         # Keyboard navigation (M13)
│   ├── command-palette.js  # Command palette (M13)
│   ├── cross-tab.js        # BroadcastChannel cross-tab sync (M14)
│   ├── preview-frame.html  # Sandboxed TSX runtime (M9+)
│   └── edit-modal.js       # Edit task title/description modal
├── .opencode/
│   └── command/
│       └── organize.md     # /organize slash command (M11)
├── docs/                   # Milestone plan
│   ├── README.mdx
│   └── milestones/
│       ├── M0.mdx … M6.mdx
│       └── M7.mdx, M8.mdx, M9.mdx
├── install.sh              # Copies into ~/.config/opencode/ and links bin/openkan as `openkan`
├── package.json            # ESM, deps include marked, nanoid, sanitize-html
└── LICENSE                  # MIT
```

Per-project runtime tree (created on first run; M7+ adds per-task directories):

```
project/
└── .openkan/
    ├── board.json             # Canonical kanban state (version: 1)
    ├── board.mdx              # Human-readable mirror of board.json
    ├── tasks.json             # Tasks index (M7+)
    ├── config.json            # Project-level config (M1+)
    ├── tasks/
    │   ├── tsk-xxxxxxxx.mdx   # Flat layout: per-task artifact page
    │   └── tsk-xxxxxxxx/      # M7+: per-task directory
    │       ├── task.mdx       #   rich MDX artifact
    │       ├── comments.json  #   inline comments with block anchors
    │       ├── inputs.json    #   pending and answered user inputs
    │       └── state.json     #   per-task state + lastError
    └── sessions/
        └── ses-xxxxxxxx.mdx   # Per-session transcript (sensitive — gitignore this dir)
```

Add `.openkan/sessions/` to your `.gitignore`. Keep `.openkan/tasks/` in version control — it is the durable record of your work. The flat `tasks/<id>.mdx` and the directory `tasks/<id>/` layouts both work; the server auto-migrates to the directory form on first access.

---

## Roadmap

The milestone plan lives in `docs/README.mdx`.

| Milestone | Status |
|---|---|
| M0 | Shipped — base plugin |
| M1 | Shipped — import checkboxes from project docs |
| M2–M6 | Pending — source links, drift detection, idempotent reimport, structured handoff packets, sanity-check script |
| M7 | Shipped — tasks index, MDX-centric model, `waiting-for-input` state |
| M8 | Shipped — inline comments on rendered MDX |
| M9 | Shipped — TSX/JSX preview components in MDX |
| M10 | Shipped — dashboard with three tabs, changelog, git attribution, archive, settings, improved drag-and-drop |
| M11 | Shipped — `/organize` slash command, `kanban_organize` batch operations, auto-progress notes |
| M12 | Shipped — search, bulk operations, MDX template, real-time progress, artifact viewer |
| M13 | Shipped — keyboard control, command palette, accessibility |
| M14 | Shipped — live file-watch, cross-tab sync |
| M15 | Shipped — edit + subtasks, artifact viewer polish, changelog filter, right-click refactor |
| M16 | Shipped — Docs tab + Multi-project + Comment authorship |
| M17 | Shipped — UX polish: inline editing on tasks, settings dialog with section sidebar, full design-token consistency pass, right-click context menus, archived items hidden by default |

---

## Development

The plugin is plain TypeScript with ESM and no build step.

Iterate on the UI (hot reload):
```sh
# refresh the browser after editing web/index.html, web/style.css, or web/app.js
# SSE reconnects automatically
```

Iterate on the server or tools (requires restart):
```sh
# restart OpenCode after editing kanban/*.ts or plugins/*.ts
```

---

## Security

- The server binds to `127.0.0.1` only. There is **no auth**.
- Do **not** expose the port to your LAN or the public internet — anyone who can reach the port can read the board, create tasks, and dispatch the agent.
- Treat `.openkan/sessions/` as sensitive: it contains a full transcript of what the agent saw and did, including file paths and command output.
- Add `.openkan/sessions/` to `.gitignore`.
- **M9 TSX previews** run in a sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`). They cannot read the parent DOM, cannot make network requests, and cannot persist state. The parent → sandbox channel is one-way (props in); sandbox → parent is one-way (response events out). TSX source is capped at 32KB and compile time at 2s.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for code conventions and the PR process.

---

## Support

For questions, bug reports, and feature requests, open an issue on GitHub.

---

## Security policy

See [.github/SECURITY.md](./.github/SECURITY.md) for how to report vulnerabilities.

---

## Authors and maintainers

<!-- Add your name or maintainer info here -->
PolderLabs — [GitHub](https://github.com/PolderLabsVOF)
Berk de Rooij - [GitHub](https://github.com/drB0rk)
Nizar Amine - [GitHub](https://github.com/Nizar-max)

---

## Acknowledgements

OpenKan is built on top of [OpenCode](https://github.com/opencode-ai/opencode). It uses [marked](https://marked.js.org/) for MDX serialization and [sanitize-html](https://www.npmjs.com/package/sanitize-html) for task content sanitization. Task IDs are generated with [nanoid](https://nanoid.net/).

---

## License

MIT — see [LICENSE](./LICENSE).
