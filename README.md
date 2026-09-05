<p align="center">
  <img src="https://raw.githubusercontent.com/PolderLabsVOF/openkan/main/web/brand/banner.svg" alt="OpenKan — local-first project management for people and coding agents" width="960">
</p>

<h1 align="center">OpenKan</h1>

<p align="center">
  Tasks, goals, docs, and agent activity. In your repository.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@drb0rk/openkan"><img src="https://img.shields.io/npm/v/%40drb0rk%2Fopenkan?color=6366f1" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node.js 22 or newer"></a>
  <a href="https://github.com/PolderLabsVOF/openkan/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748b" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#workspace">Workspace</a> ·
  <a href="#agent-workflow">Agent workflow</a> ·
  <a href="#development">Development</a> ·
  <a href="https://github.com/PolderLabsVOF/openkan/issues">Report an issue</a>
</p>

OpenKan combines a local kanban dashboard with command-line planning for coding
agents. Manage work in the browser, record goals and completion evidence from the
terminal, and follow Claude Code activity without leaving the project. Project
records live in `.ok/`; the board and planning CLI need no hosted service.

## Quick start

**Requires Node.js 22 or newer and npm.** The npm package includes compiled
JavaScript, so installation needs neither TypeScript nor a build step. Claude Code
is optional and only needed for Claude-powered features.

```sh
npm install -g @drb0rk/openkan

cd /path/to/your/project
openkan init
openkan start
```

Installation adds the OpenKan Claude agent and skill, preserving locally edited
files. Chat selects OpenKan by default; use the agent picker for Claude Code or
another installed profile. To skip automatic installation, set
`OPENKAN_SKIP_AGENT_INSTALL=1`. If npm scripts are disabled, run
`openkan agent install` later. Use `--target DIR` for a custom Claude configuration
directory; `--force` explicitly replaces customized files.

Open [localhost:7777](http://127.0.0.1:7777/) if your browser does not open
automatically. Keep the server process running while using the dashboard.
`openkan init` is safe to run again in an existing workspace.

<details>
<summary><strong>Run without a global install</strong></summary>

Run these commands from your project directory:

```sh
npx --package @drb0rk/openkan openkan init
npx --package @drb0rk/openkan openkan start
```

</details>

<details>
<summary><strong>Update an existing installation</strong></summary>

```sh
openkan stop
npm install -g @drb0rk/openkan@latest
openkan start
```

If you installed the agent skill, refresh it separately:

```sh
openkan skill install --agent all --force
```

The package name is **`@drb0rk/openkan`**. Its executables are **`openkan`** and
**`ok`**; use the scoped name when installing or updating.

</details>

## Workspace

| Area | What you can do |
| --- | --- |
| **Home** | See registered projects, activity, and workspace statistics. |
| **Tasks** | Organize cards across Backlog, To Do, In Progress, Review, and Done. Search, filter, drag, archive, and manage subtasks. |
| **Chat** | Stream agent responses, mention tasks by dropping cards into the composer, and inspect expandable activity details. Sessions are scoped to their project. |
| **Docs** | Browse a folder tree, edit Markdown/MDX, preview documents, and generate drafts with the configured agent. |
| **Goals** | Track PRD goals alongside plans, tasks, and progress. |
| **Agents** | Explore a connected canvas of sessions, agents, subagents, and tasks, including discoverable Claude sessions started outside OpenKan for the current project. |

**Task mode** keeps the board central with a resizable chat panel on the left.
**Chat mode** gives the conversation the main workspace, with project tools on the
right. The navbar stays available in both modes. Changelog, contributors, and
insights are available through the workspace menu.

### Claude Code integration

Install and authenticate [Claude Code](https://code.claude.com/docs/en/setup)
separately, then configure the agent, model, effort, and permissions in OpenKan.
The board, docs, and offline planning commands remain usable without Claude Code.

OpenKan reads local Claude configuration and session activity and launches Claude
Code for chat turns and agent work. The chat activity view presents available file
operations, commands, tool calls, and subagent events. Visibility depends on the
events and local session data Claude exposes; OpenKan cannot display activity it
does not receive.

> **Local storage does not mean offline AI.** Agent requests use the configured
> provider and may send project content to that provider. Review permission settings
> before allowing an agent to run commands or change files.

## Agent workflow

Install the bundled skill so your coding agent can discover and use OpenKan's
commands instead of constructing HTTP requests:

```sh
openkan skill install --agent all
```

Use `--agent claude` or `--agent codex` to install for one tool, or `--target DIR`
for a custom skill directory. npm installation does not change agent configuration;
skill installation is explicit.

### Track tasks without a server

Planning commands work directly with `.ok/`. From a project subdirectory, they find
the nearest existing `.ok/` workspace. `ok` is the shorter planning-only command:
`ok task list --json` and `openkan task list --json` use the same records.

```sh
openkan task add "Add a regression test" --owner codex --priority p1
openkan task list --json

# Replace TASK_ID with the ID printed by task add.
openkan task claim TASK_ID --owner codex
openkan task update TASK_ID --status review
openkan task complete TASK_ID --owner codex --evidence "npm test passed"

openkan progress --json
openkan doctor
```

Claims default to a one-hour lease. Use `openkan task heartbeat TASK_ID --owner
codex` during longer work. Complete tasks only after verification, with evidence
of what passed.

### Connect goals, plans, and tasks

Goals belong to a **PRD**: a product requirements document describing the intended
outcome. Plans organize delivery; tasks record individual work items.

```sh
openkan prd add "First release" --vision "A tested, installable CLI" --goals "Ship package|Verify install"

# Replace PRD_ID and PLAN_ID with the IDs printed by the preceding commands.
openkan prd update PRD_ID --status active
openkan plan add "Release preparation" --prd PRD_ID --summary "Package and verify"
openkan task add "Test a clean installation" --prd PRD_ID --plan PLAN_ID --owner codex

openkan goal list --prd PRD_ID --json
openkan goal update PRD_ID g1 --status in_progress
openkan progress --prd PRD_ID --json
```

Mark a goal `met` when its outcome is verified. Progress reports counts and
completion percentages; it does not automatically finish goals or plans.

### Work with dashboard cards

**Planning tasks and dashboard cards are related but distinct.** Creating a task
with `openkan task add` does not automatically create a visible board card. Use
`openkan board` for dashboard work, with the server running:

```sh
openkan project list
openkan project use PROJECT_ID
openkan board add "Test a clean installation" --column todo
openkan board list
openkan board move BOARD_TASK_ID doing
openkan board comment BOARD_TASK_ID "Clean installation verified" --author agent:codex
openkan board move BOARD_TASK_ID done
```

Replace the example IDs with actual project and card IDs. Board commands check
that the selected dashboard project matches your current repository. If you track
both surfaces, include the planning task ID in the card description.

### Command reference

| Command | Purpose | Server needed |
| --- | --- | --- |
| `openkan task`, `plan`, `prd`, `goal` | Create and maintain planning records | No |
| `openkan progress --json` | Report planning status and ready tasks | No |
| `openkan doctor` | Validate the planning store | No |
| `openkan board` | Manage dashboard cards and comments | Yes |
| `openkan project list`, `project use ID` | Inspect or switch the dashboard project | Yes |
| `openkan agent capabilities` | Discover the agent command surface | No |
| `openkan agent context` | Read the active workspace context | Yes |
| `openkan agent start ID`, `agent abort ID` | Start or stop agent work for a card | Yes |

Use `openkan --help` and `ok help` for command syntax. Planning list/show commands
support `--json`; do not assume all mutation commands return JSON. For advanced
features, use `openkan api` or `openkan agent call`, as documented in the
[agent API reference](https://github.com/PolderLabsVOF/openkan/blob/main/skills/openkan/references/api.md).
These target the dashboard's selected project, which may differ from your shell's
current directory.

## Project data and privacy

OpenKan uses **`.ok/`**, not the legacy `.openkan/` directory. Important paths are:

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

Additional files appear as you use features. Keep task and planning records in
version control when you want a shared work history. Review `.gitignore` before
committing: sessions and runtime files can contain prompts, local paths, command
output, and other sensitive information.

The dashboard binds to `127.0.0.1:7777` by default and has no login layer. **Do not
expose it to an untrusted network or public reverse proxy.** It can launch agents
and modify project files. Use only trusted projects and review agent permissions.

## Server and troubleshooting

```sh
openkan status
openkan logs --tail 100
openkan config list
openkan start --no-open --project /absolute/path/to/project
openkan stop
```

| Problem | Check |
| --- | --- |
| `openkan: command not found` | Ensure your npm global executable directory is on `PATH`. Check `npm prefix -g` and reopen your terminal after changing your shell configuration. |
| An old install runs after updating | Check `command -v openkan` on macOS/Linux or `where openkan` on Windows. An earlier source install may appear before npm's executable on `PATH`. |
| Port 7777 is occupied | Stop the existing OpenKan server, or start with `--port 7788`. Use the same `--port` for server-backed CLI commands. |
| Board commands report a project mismatch | Run `openkan project list`, then `openkan project use PROJECT_ID` for the repository you are working in. |
| Claude chat does not respond | Confirm Claude Code works in your terminal, check the configured provider/model and permissions, then inspect `openkan logs --tail 100`. |
| Planning records fail validation | Run `openkan doctor` and inspect its reported files before editing or resetting data. |

## Development

Use **Node.js 22.6 or newer** for source development; source commands use Node's
experimental type-stripping support. Git is required to clone the repository.

```sh
git clone https://github.com/PolderLabsVOF/openkan.git
cd openkan
npm ci

npm run openkan -- init
npm run openkan -- start --no-open
```

Run verification in another terminal:

```sh
npm test                 # Unit and integration tests
npm run typecheck        # TypeScript checks
npm run check            # Repository sanity checks
npm run test:package     # Build, pack, install, and smoke-test the npm artifact
```

`npm run build` generates `dist/`. The npm launchers use that compiled output when
present; use `npm run openkan -- ...` to run directly from edited source rather
than an older build.

<details>
<summary><strong>Alternative source installer (macOS/Linux)</strong></summary>

For a dedicated source installation rather than the published npm package, run
this from a reviewed checkout. It requires Bash, Node.js 22.6+, and npm:

```sh
bash install.sh
```

The installer defaults to `~/.local/share/openkan` on Linux (respecting
`XDG_DATA_HOME`) and `~/Library/Application Support/OpenKan` on macOS. It links
`openkan` in `~/.local/bin`, which must be on `PATH`.

Override locations with `OPENKAN_HOME` and `OPENKAN_BIN_DIR`. This installer additionally installs skills for Codex and shared agents; set `OPENKAN_SKIP_AGENT_SKILLS=1` to
skip that step. Use the same installation method for subsequent updates to avoid
competing command paths.

</details>

## Documentation and contributing

- [Planning guide](https://github.com/PolderLabsVOF/openkan/blob/main/docs/OK-PLANNING.md)
- [Agent skill and workflow](https://github.com/PolderLabsVOF/openkan/blob/main/skills/openkan/SKILL.md)
- [Agent API reference](https://github.com/PolderLabsVOF/openkan/blob/main/skills/openkan/references/api.md)
- [Claude integration](https://github.com/PolderLabsVOF/openkan/blob/main/docs/CLAUDE-NATIVE.md)
- [Contributing](https://github.com/PolderLabsVOF/openkan/blob/main/CONTRIBUTING.md)
- [Changelog](https://github.com/PolderLabsVOF/openkan/blob/main/CHANGELOG.md)

OpenKan is [MIT licensed](https://github.com/PolderLabsVOF/openkan/blob/main/LICENSE).
