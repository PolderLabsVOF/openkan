# openkan

MDX-kanban task board plugin for OpenCode. Runs locally, no sync, no auth.

<!-- badge: version -->
v0.1.0 &nbsp;|&nbsp; MIT &nbsp;|&nbsp; [PolderLabs](https://github.com/PolderLabsVOF)

---

OpenKan turns any OpenCode project into a five-column kanban (Backlog, To Do, In Progress, Review, Done). Every task and every agent session is mirrored to disk as MDX under `.openkan/`, giving you a browsable, version-controllable log of all work done.

The plugin starts a small HTTP server on `127.0.0.1` (default port `7777`). There is no auth and no remote access — it is a single-user, single-machine tool.

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

**Tools**
- Four custom OpenCode tools: `kanban_add`, `kanban_move`, `kanban_start`, `kanban_view`
- `kanban_start` dispatches the OpenCode agent on a task, auto-moving it to In Progress
- `kanban_view` is read-only; supports column and status filters

**Persistence**
- Board state stored in `.openkan/board.json` (JSON, atomic temp-file write, `withWrite` lock)
- Per-task MDX artifacts under `.openkan/tasks/`
- Per-session MDX transcripts under `.openkan/sessions/`
- `board.mdx` human-readable mirror of board state

**Security**
- Server binds to `127.0.0.1` only — no auth, no LAN exposure
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
4. Merge `package.json` dependencies into `~/.config/opencode/package.json`
5. Restart OpenCode and open `http://127.0.0.1:7777/`

---

## Usage

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
| `kanban_view` | Read-only list of tasks, optionally filtered | `column` (optional), `status` (optional: `idle`/`running`/`done`/`failed`/`cancelled`) |

Task IDs are generated as `tsk-` followed by 8 nanoid characters (e.g. `tsk-abc12345`); session IDs are `ses-xxxxxxxx` of the same shape. The three mutating tools (`kanban_add`, `kanban_move`, `kanban_start`) broadcast SSE events so the UI updates immediately; `kanban_view` is read-only. `kanban_start` resolves the agent name against the OpenCode agent list; it falls back to the primary agent or `"build"`.

---

## Configuration

All other settings live in the board state itself (per-task agent, model, etc.). The server binds to `127.0.0.1` on TCP port `7777`; this is currently hard-coded in `kanban/server.ts` and not configurable at runtime. (An environment-variable override is a planned future addition.)

---

## Project layout

Plugin source (this repo):

```
openkan/
├── kanban/
│   ├── board.ts      # Board state (board.json read/write, withWrite lock)
│   ├── mdx.ts         # MDX serializer for tasks and sessions
│   └── server.ts      # HTTP + SSE server (Node built-in http, port 7777)
├── plugins/
│   ├── kanban.ts      # Main plugin: starts server, wires session events
│   └── tools.ts       # Custom tools (kanban_add, kanban_move, kanban_start, kanban_view)
├── web/
│   ├── index.html     # Kanban UI
│   ├── style.css
│   └── app.js
├── docs/              # Milestone plan (M0 shipped, M1 next)
│   └── README.mdx
├── install.sh         # Copies into ~/.config/opencode/
├── package.json       # ESM, deps: @opencode-ai/plugin, marked, nanoid, sanitize-html
└── LICENSE             # MIT
```

Per-project runtime tree (created on first run):

```
project/
└── .openkan/
    ├── board.json     # Canonical board state (version: 1)
    ├── board.mdx      # Human-readable mirror of board.json
    ├── tasks/
    │   └── tsk-xxxxxxxx.mdx   # Per-task artifact page
    └── sessions/
        └── ses-xxxxxxxx.mdx   # Per-session transcript (sensitive — gitignore this dir)
```

Add `.openkan/sessions/` to your `.gitignore`. Keep `.openkan/tasks/` in version control — it is the durable record of your work.

---

## Roadmap

The milestone plan lives in `docs/README.mdx`.

| Milestone | Status |
|---|---|
| M0 | Shipped — base plugin |
| M1 | Next — import checkboxes from project docs |
| M2–M6 | Pending — source links, drift detection, idempotent reimport, structured handoff packets, sanity-check script |

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
