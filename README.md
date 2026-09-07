<div align="center">

<img src="web/brand/banner.svg" alt="OpenKan — local-first project management for people and coding agents" width="960">

[![npm](https://img.shields.io/npm/v/%40polderlabs%2Fopenkan?color=0f766e&label=npm)](https://www.npmjs.com/package/@polderlabs/openkan)
[![license](https://img.shields.io/badge/license-MIT-0f172a)](LICENSE)
[![Claude Code](https://img.shields.io/badge/works%20with-Claude%20Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![release](https://img.shields.io/github/v/release/PolderLabsVOF/openkan?color=2563eb&label=release)](https://github.com/PolderLabsVOF/openkan/releases)
[![Bizar integration](https://img.shields.io/badge/planning-Bizar-f59e0b)](https://www.npmjs.com/package/@polderlabs/bizar)

### Local-first kanban with a native Claude Code control plane

Tasks, goals, docs, and agent activity. In your repository. No hosted service.

`5 kanban columns` · `chat sidebar with tabs` · `.ok/ workspace` · `live SSE + WS`

</div>

---

## Quick start

OpenKan is a Node.js CLI plus a local dashboard. It binds to `127.0.0.1:7777`
by default and stores everything in `.ok/` inside your repository — no hosted
service, no account, no telemetry.

**Requires Node.js 22 or newer and npm.** The npm package ships compiled
JavaScript, so installation needs neither TypeScript nor a build step. Claude
Code is optional and only needed for Claude-powered chat.

```sh
npm install -g @polderlabs/openkan

cd /path/to/your/project
ok init
ok start
```

The dashboard opens in your browser (or visit <http://127.0.0.1:7777/>).
Installation also installs the OpenKan Claude agent and skill, preserving any
locally edited files. Chat picks the OpenKan agent by default; switch to Claude
Code or any installed profile from the agent picker. Set
`OPENKAN_SKIP_AGENT_INSTALL=1` to skip the automatic install and run
`ok skill install` later.

<details>
<summary><strong>Run without a global install</strong></summary>

```sh
npx --package @polderlabs/openkan ok init
npx --package @polderlabs/openkan ok start
```

</details>

<details>
<summary><strong>Run the server in the background</strong></summary>

For long-running sessions, detached from the controlling terminal:

```sh
ok serve --mode=background
ok status     # check it's alive
ok logs --tail 100
ok stop       # SIGTERM
```

`--mode=background` survives parent shell SIGHUP and stays up until you stop it.
The pidfile's PID is reliably the live server PID.

</details>

<details>
<summary><strong>Update an existing installation</strong></summary>

```sh
ok stop
npm install -g @polderlabs/openkan@latest
ok start
```

Refresh the agent skill separately if you installed it before:

```sh
ok skill install --agent all --force
```

The package name is **`@polderlabs/openkan`**. Its executable is **`ok`**; use
the scoped name when installing or updating.

</details>

## Why OpenKan?

- **Local-first by design** — every record lives in `.ok/` inside the
  repository. Commit it for a shared work history; ignore it for a private
  scratch space. There is no database server to provision and no cloud
  account to lose access to.
- **Kanban + chat in one tool** — the board, docs, chat sidebar, and
  planning CLI share the same workspace. Drag a task card into the chat
  composer to attach it to the conversation; mention it with `@T-…` and the
  sidebar renders the task title, its column pill, and its truncated ID.
- **Claude Code native** — the chat sidebar talks to Claude Code (or your
  installed custom agent) directly. Pick the agent, model, effort, and
  permission mode from the composer; watch tool calls stream into the
  transcript in real time.
- **Bizar-ready planning** — tasks, PRDs, plans, and goals are stored as
  versionable JSON. Drop them into any repo and pair with the
  [Bizar Harness](https://www.npmjs.com/package/@polderlabs/bizar) for an
  end-to-end autonomy stack.
- **No hosted service** — the dashboard binds to localhost with no login
  layer. Bring your own reverse proxy if you need remote access; do not
  expose it to an untrusted network as-is.

## The board

The dashboard renders a five-column board at `http://127.0.0.1:7777/`:

| Column | Purpose |
| --- | --- |
| **Backlog** | New ideas, parked work, imported `- [ ]` items. |
| **To Do** | Ready to pick up. |
| **In Progress** | Active work — one agent per task by default. |
| **Review** | Awaiting sign-off. |
| **Done** | Closed tasks, kept for the work history. |

Drag-and-drop moves cards between columns with optimistic updates; the server
pushes changes back over Server-Sent Events so every open dashboard stays in
sync. SSE is the primary channel with a polling fallback for restricted
environments.

Each task carries:

- An MDX record under `.ok/tasks/<id>.json` and `.ok/tasks/<id>/` for richer
  artifacts.
- A clickable **Source** chip when the task was imported from a project doc
  (the path + line is preserved; clicking opens the source file at the given
  line).
- A **Stale** badge and a "Re-derive tags" action when the source file's
  content hash diverges from the import-time snapshot (drift detection).
- Inline comments and a transcript of agent activity for that task.

## The chat sidebar

Open the sidebar with the speech-bubble button in the topbar or `Alt+C`. The
right rail is the Claude Code control plane:

- **Tabs row** — Project / Files / Plugins / Activity. Use Left/Right
  arrows to move focus between tabs (Home/End jump to first/last).
- **Agent picker** — switch between the bundled OpenKan agent, Claude Code,
  and any custom profile you've installed with `ok agent install`.
- **Model picker** — pick the model, effort level, and permission mode from
  the model pill in the composer.
- **Attach menu** — `+` opens New session / Import file / Add to planning.
- **Composer** — auto-resizing input, Enter to send, `Cmd/Ctrl+K` to focus,
  `Esc` to blur. The send button becomes an abort button while a turn is in
  flight.

Drop a task card from the board into the composer (or type `@T-…`) and the
sidebar shows the task title, its column as a colored pill, and the truncated
ID as a monospace badge — both in the mention tray and in the turn banner.
The most recent overhaul (Unreleased) restores the tabs row, clarifies the
kanban task references, fixes the ARIA tablist keyboard pattern, and removes
the duplicate announcement on the empty mention tray.

Press `Alt+C` again, or click the collapse handle on the rail's edge, to
hide the sidebar. The board stays usable in **Task mode** (board central,
resizable chat on the left) or **Chat mode** (conversation central, project
tools on the right).

## The docs tab

A recursive Markdown / MDX browser for the project, with:

- Folder tree navigation.
- Live MDX rendering with the same engine used for task artifacts.
- Edit and preview side-by-side.
- Optional agent-assisted draft generation.

The docs tab reads from the workspace root by default and respects
`.gitignore` so it stays out of dependency directories.

## CLI surface

`ok` is the only entry point. Every command also runs without a global
install via `npx --package @polderlabs/openkan ok <command>`.

| Command | What it does |
| --- | --- |
| `ok init` | Initialise the `.ok/` workspace and canonical board in the current repo. |
| `ok start` | Boot the dashboard on `127.0.0.1:7777` (opens the browser). |
| `ok serve --mode=background` | Long-running server, detached from the terminal. |
| `ok stop` / `ok status` / `ok logs` | Lifecycle and log access. |
| `ok task add\|list\|show\|update\|claim\|heartbeat\|complete\|cancel\|release` | Task lifecycle and agent coordination. |
| `ok plan add\|list\|show\|update` | Multi-task delivery plans with status rollups. |
| `ok prd add\|list\|show\|update` | Product requirements with embedded goals. |
| `ok goal …` | Track and update PRD goal progress. |
| `ok progress` | Workspace progress rollup. |
| `ok board …` | Board-level helpers (init, re-render, validate). |
| `ok agent install` | Install the OpenKan Claude agent into your agent directory. |
| `ok skill install` | Install the OpenKan Claude skill (preserves local edits). |
| `ok doctor` / `ok index` | Validate and re-build the planning lookup index. |
| `ok mcp` | Launch the OpenKan MCP server for Claude Code integration. |
| `ok update` | Update the global `ok` install via npm. |
| `ok import` | Import `- [ ]` items from project `.md` / `.mdx` files. |

Run `ok <command> --help` for flags and one-liners.

## Bizar integration

[Bizar](https://www.npmjs.com/package/@polderlabs/bizar) is the Claude Code
harness for guarded autonomy — model routing, specialist teams, isolated
worktrees, and verification evidence. OpenKan ships the durable planning
workspace (`.ok/`) that Bizar's agents read and write; Bizar ships the
routing, guardrails, and skills that turn that workspace into shipped work.
Install both side-by-side; OpenKan remains a standalone tool if you only
need the board and CLI. See [`BIZAR_INTEGRATION.md`](docs/BIZAR_INTEGRATION.md)
for the integration contract.

## Recent releases

Highlights from the `0.5.x` line. See [`CHANGELOG.md`](CHANGELOG.md) for the
full record.

- **0.5.1** — `ok serve --mode=background` no longer exits after starting
  the HTTP listener. Background processes detach from the controlling
  terminal, survive SIGHUP, and shut down cleanly on `ok stop`.
- **0.5.0** — OK migration M2 drops the legacy `openkan` binary. The `ok`
  CLI is the only entry point. README and `install.sh` updated to match.
- **0.4.x** — Bundled OpenKan Claude agent with explicit `ok agent install`,
  chat agent selection, improved drafts and composer recovery, MDX task
  view with source links, drift detection, and the `npm run check`
  sanity-check script.
- **Unreleased** — Chat sidebar overhaul: restored Project / Files /
  Plugins / Activity tabs row, clarified kanban task references (title +
  column pill + truncated ID badge), ARIA tablist keyboard nav, and
  desktop-app CTA no longer announced as a tab.

## Workspace

OpenKan uses **`.ok/`**, not the legacy `.openkan/` directory. Important paths:

```text
.ok/
├── openkan.json       # Dashboard/runtime settings
├── config.json        # Planning configuration
├── board.json         # Canonical dashboard board
├── board.mdx          # Rendered board document
├── tasks/             # Planning JSON records and board task workspaces
├── prds/              # PRDs, including their goals
├── plans/             # Delivery plans
├── sessions/          # Project chat/session records
├── index.json         # Planning lookup index
└── locks/             # Task claims and leases
```

Additional files appear as you use features. Keep task and planning records
in version control when you want a shared work history. Review
`.gitignore` before committing: sessions and runtime files can contain
prompts, local paths, command output, and other sensitive information.

The dashboard binds to `127.0.0.1:7777` by default and has no login layer.
**Do not expose it to an untrusted network or public reverse proxy.** It can
launch agents and modify project files. Use only trusted projects and
review agent permissions.

## Claude Code integration

Install and authenticate
[Claude Code](https://code.claude.com/docs/en/setup) separately, then
configure the agent, model, effort, and permissions in OpenKan. The board,
docs, and offline planning commands remain usable without Claude Code.

See [`docs/CLAUDE-NATIVE.md`](docs/CLAUDE-NATIVE.md) for the full Claude
integration contract and [`docs/CHAT-SIDEBAR.md`](docs/CHAT-SIDEBAR.md) for
the chat sidebar reference.

## Server and troubleshooting

```sh
ok status
ok logs --tail 100
ok config list
ok start --no-open --project /absolute/path/to/project
ok stop
```

| Problem | Check |
| --- | --- |
| `ok: command not found` | Ensure your npm global executable directory is on `PATH`. Check `npm prefix -g` and reopen your terminal after changing your shell configuration. |
| An old install runs after updating | Check `command -v ok` on macOS/Linux or `where ok` on Windows. An earlier source install may appear before npm's executable on `PATH`. |
| Port 7777 is occupied | Stop the existing OpenKan server, or start with `--port 7788`. Use the same `--port` for server-backed CLI commands. |
| Board commands report a project mismatch | Run `ok project list`, then `ok project use PROJECT_ID` for the repository you are working in. |
| Claude chat does not respond | Confirm Claude Code works in your terminal, check the configured provider/model and permissions, then inspect `ok logs --tail 100`. |
| Planning records fail validation | Run `ok doctor` and inspect its reported files before editing or resetting data. |

## Development

Use **Node.js 22.6 or newer** for source development; source commands use
Node's experimental type-stripping support. Git is required to clone the
repository.

```sh
git clone https://github.com/PolderLabsVOF/openkan.git
cd openkan
npm ci

npm run ok -- init
npm run ok -- start --no-open
```

Run verification in another terminal:

```sh
npm test                 # Unit and integration tests
npm run typecheck        # TypeScript checks
npm run check            # Repository sanity checks
npm run build            # Build the compiled artifact
npm run test:package     # Build, pack, install, and smoke-test the npm artifact
npm run e2e              # Claude Code + MCP integration smoke test
```

## Documentation and contributing

- [Planning guide](docs/OK-PLANNING.md)
- [Chat sidebar reference](docs/CHAT-SIDEBAR.md)
- [Claude integration contract](docs/CLAUDE-NATIVE.md)
- [Bizar integration contract](docs/BIZAR_INTEGRATION.md)
- [Agent skill](skills/openkan/SKILL.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE).

---

<div align="center">
  <a href="https://polderlabs.io/"><img src="docs/assets/sponsored-by-polderlabs.svg" alt="Sponsored by PolderLabs" width="100%" /></a>
</div>
