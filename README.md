# openkan

OpenKan is a local-only MDX-kanban task board that runs as an OpenCode plugin. It turns OpenCode's project directory into a five-column board (Backlog, To Do, In Progress, Review, Done), lets you create tasks, drag them between columns, and click **Start** to dispatch the OpenCode agent on a task. Every task and every session is mirrored to disk as MDX under `.openkan/`, so the board is also a browsable, version-controllable log of what the agent did.

The plugin runs a small HTTP server bound to `127.0.0.1` (default port `7777`, override with `KANBAN_PORT`) and serves the kanban UI straight from disk. There is no auth and no remote access — it is a single-user, single-machine tool.

## What you get

- A kanban UI at `http://127.0.0.1:7777/`
- Live updates over Server-Sent Events (polling fallback every 5 s)
- Drag-and-drop between columns, optimistic UI, revert on error
- Per-task actions: **Start** (dispatches the agent), **Abort** (cancels a running session), **Delete**, **View Artifact** (opens the per-task MDX page)
- Four custom OpenCode tools the agent can call: `kanban_add`, `kanban_move`, `kanban_start`, `kanban_view`
- MDX artifacts under `.openkan/` that double as the board's persistent state

## File layout

The plugin lives inside OpenCode's plugin directory:

```
.opencode/
├── kanban/
│   ├── board.ts      # board state (board.json read/write, withWrite lock)
│   ├── mdx.ts        # MDX serializer for tasks and sessions
│   └── server.ts     # HTTP + SSE server (port 7777 by default)
├── plugins/
│   ├── kanban.ts     # main plugin: starts server, wires session events
│   └── tools.ts      # custom tools (kanban_add, kanban_move, …)
├── package.json      # deps installed by `bun install` at startup
└── node_modules/     # populated automatically
web/
├── index.html        # kanban UI
├── style.css
└── app.js
```

In the user's project the plugin creates:

```
.openkan/
├── board.json        # canonical board state
├── board.mdx         # human-readable mirror of board.json
├── tasks/
│   └── tsk_xxx.mdx   # one MDX per task (the task's "artifact" page)
└── sessions/
    └── ses_xxx.mdx   # one MDX per session (transcript mirror)
```

> Add `.openkan/sessions/` to your `.gitignore`. The other `.openkan/` directories are useful to keep in version control — they are the durable record of your tasks.

## Install

### Manual install (this repo is the plugin source)

```sh
# from the repo root
cp -r .opencode/ <your-project>/.opencode/
cp -r web/      <your-project>/.opencode/../web   # or wherever your opencode config expects static files
```

OpenCode runs `bun install` against `.opencode/package.json` at startup, so you do not need to install dependencies by hand. The first run creates `.openkan/` and writes an empty `board.json`.

### Add to an existing OpenCode project

If you already have a `.opencode/` in your project:

1. Copy this repository's `.opencode/kanban/` directory into yours.
2. Copy this repository's `.opencode/plugins/kanban.ts` and `.opencode/plugins/tools.ts` into your `.opencode/plugins/`.
3. Copy this repository's `.opencode/package.json` over yours (or merge the `dependencies` block).
4. Make sure the static UI (`web/index.html`, `web/style.css`, `web/app.js`) is reachable at the path your `kanban.ts` server expects (the bundled server serves the kanban UI from `web/` by default — adjust if your project layout differs).
5. Restart OpenCode. Open `http://127.0.0.1:7777/`.

## Configuration

| Env var       | Default      | Meaning                                                       |
| ------------- | ------------ | ------------------------------------------------------------- |
| `KANBAN_PORT` | `7777`       | TCP port for the local UI / API / SSE                         |

Everything else lives in the board itself (per-task `agent`, `model`, etc.).

## Custom tools

Once the plugin is loaded, the agent can call these four tools:

- **`kanban_add`** — create a new task (`title`, `description`, `column`, `agent`).
- **`kanban_move`** — move a task to a different column and/or reorder it.
- **`kanban_start`** — create an OpenCode session, link it to the task, and send the task's description as the initial prompt. Optionally override `agent` and `model`.
- **`kanban_view`** — read-only list of tasks, optionally filtered by `column` and/or `status`.

A typical agent loop looks like:

1. `kanban_view` to see what is on the board.
2. `kanban_add` for any new work the user just mentioned.
3. `kanban_start` on the task you are about to work on (this auto-moves the task to **In Progress** in the UI).
4. Do the work.
5. The plugin watches session events and writes a per-session MDX under `.openkan/sessions/`, plus updates the task's status (`running` → `done` / `failed` / `cancelled`).

## Security

- The server binds to `127.0.0.1` only. There is **no auth**.
- Do **not** expose the port to your LAN or the public internet — anyone with reach to the port can read the board, create tasks, and dispatch the agent.
- Treat `.openkan/sessions/` as sensitive: it contains a full transcript of what the agent saw and did, including any file paths and command output.
- Add `.openkan/sessions/` to `.gitignore`.

## Development

The plugin is plain TypeScript, no build step. To iterate:

- `web/index.html` / `web/style.css` / `web/app.js` — refresh the browser; SSE reconnects automatically.
- `.opencode/kanban/*.ts` and `.opencode/plugins/*.ts` — restart OpenCode.

## License

MIT.
