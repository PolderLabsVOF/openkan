# OpenKan

Local-first project management for people and coding agents.

OpenKan provides a five-column kanban board, rich MDX task workspaces, project
documentation browsing, changelogs, contributor attribution, and a Bizar
control plane. It runs on `127.0.0.1`, stores project state under `.openkan/`,
and does not require a hosted service.

## Highlights

- Five-column board: Backlog, To Do, In Progress, Review, Done
- Drag-and-drop ordering, bulk actions, search, filters, subtasks, and archives
- MDX task workspaces with comments, structured questions, and TSX previews
- Multi-project switching and a project documentation browser
- Live filesystem, browser-tab, SSE, and WebSocket updates
- Bizar agents, durable tasks, sessions, messages, features, and progress in
  one management workspace
- Local-only server with no remote sync

## Requirements

- Node.js 22 or newer
- npm
- A POSIX shell for the installer

## Install or update

Install directly from the hosted script:

```sh
curl -fsSL https://raw.githubusercontent.com/PolderLabsVOF/openkan/main/install.sh | bash
```

The script downloads the complete source archive and then performs the normal
atomic installation. Running the same command again updates OpenKan.

To install from a source checkout or extracted release instead:

```sh
./install.sh
```

The default application location is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/openkan
```

On macOS it defaults to:

```text
~/Library/Application Support/OpenKan
```

The installer:

1. Builds a complete installation in a staging directory.
2. Installs production dependencies inside that staging directory.
3. Atomically replaces the previous OpenKan installation.
4. Links `openkan` into `~/.local/bin`.
5. Installs the OpenKan workflow skill for Codex, Claude Code, and agents that
   discover shared skills under `~/.agents/skills`.

Obsolete application files are removed on update. Project data is unaffected
because it remains inside each project's `.openkan/` directory.

### Custom locations

```sh
OPENKAN_HOME=/opt/openkan ./install.sh
OPENKAN_BIN_DIR="$HOME/bin" ./install.sh
./install.sh /opt/openkan
```

The same overrides work with the remote installer:

```sh
curl -fsSL https://raw.githubusercontent.com/PolderLabsVOF/openkan/main/install.sh \
  | OPENKAN_HOME=/opt/openkan OPENKAN_BIN_DIR="$HOME/bin" bash
```

Set `OPENKAN_SKIP_AGENT_SKILLS=1` only when you do not want the installer to
manage the global OpenKan agent skill.

If `~/.local/bin` is not already on `PATH`, add it to your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Start a project

```sh
cd /path/to/project
openkan init
openkan start
openkan open
```

The dashboard is available at:

```text
http://127.0.0.1:7777/
```

Useful commands:

```sh
openkan status
openkan logs --follow
openkan config list
openkan config set port 7788
openkan stop
```

Use `openkan --help` for the full CLI.

## Bizar integration

OpenKan can manage Bizar agents, durable tasks, sessions, and messages. Add a
`bizar` section to the managed project's `.openkan/config.json`:

```json
{
  "bizar": {
    "enabled": true,
    "projectRoot": "/absolute/path/to/BizarHarness",
    "command": "/absolute/path/to/BizarHarness/cli/bin.mjs"
  }
}
```

Environment variables can override those values:

```sh
export OPENKAN_BIZAR_PROJECT_ROOT=/path/to/BizarHarness
export OPENKAN_BIZAR_COMMAND=/path/to/BizarHarness/cli/bin.mjs
```

The integration uses Bizar's JSON CLI contract for mutations and a loopback
WebSocket for live dashboard snapshots. OpenKan does not open Bizar databases
or edit session transcripts directly. See
[`docs/BIZAR_INTEGRATION.md`](./docs/BIZAR_INTEGRATION.md).

## Project data

OpenKan creates this structure inside each managed project:

```text
.openkan/
├── board.json
├── board.mdx
├── tasks.json
├── config.json
├── changelog.jsonl
├── tasks/
│   └── <task-id>/
│       ├── task.mdx
│       ├── comments.json
│       ├── inputs.json
│       └── state.json
└── sessions/
    └── <session-id>.mdx
```

Keep `.openkan/tasks/` in version control when you want a durable work record.
Treat `.openkan/sessions/` as sensitive and normally gitignore it.

## Security

- The server binds to `127.0.0.1` by default.
- There is no authentication; do not expose the port to a network.
- Session files can contain paths, prompts, and command output.
- TSX previews run in a sandboxed iframe without same-origin access.
- The Bizar WebSocket endpoint is loopback-only.

## Development

```sh
git clone https://github.com/PolderLabsVOF/openkan.git
cd openkan
npm install
npm test
npm run typecheck
npm run check
npm run e2e
```

Run directly from the checkout:

```sh
npm run openkan -- init
npm run openkan -- start
```

Repository layout:

```text
bin/                 CLI entrypoints
commands/            Agent command prompts
kanban/              Board, persistence, server, and API modules
skills/openkan/      Portable agent guidance and templates
web/                 Browser application
tests/               Unit, integration, installer, and contract tests
install.sh           Atomic dedicated-location installer
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE).
