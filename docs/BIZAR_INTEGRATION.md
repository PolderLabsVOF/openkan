# Bizar Integration

## Goal

OpenKan is the local control plane for Bizar projects. A user can inspect and
manage Bizar agents, durable tasks, Claude Code sessions, and agent messages
without reintroducing Bizar's retired dashboard or memory subsystem.

## Research findings

### Bizar

- Bizar's durable task graph is a SQLite ledger in Git's common directory.
  It already supports dependency-aware task creation, atomic claims, expiring
  leases, path ownership, completion, and a serialized integration queue.
- Bizar's agent definitions are Markdown files installed under
  `.claude/agents/`.
- Bizar's Claude Code wrappers can start named agents and background sessions,
  but the existing commands are optimized for humans rather than a UI adapter.
- Session summaries under `.bizar/sessions/` are historical handoffs, not a
  live transport.

### Claude Code

- The CLI supports `claude agents --json` for scriptable background-session
  discovery.
- A named agent can be selected with `--agent`; a session can start in the
  background with `--background`; and a saved session can be resumed by ID.
- `SessionStart` and `UserPromptSubmit` hooks can add context to a conversation.
- `SendMessage` is an in-session agent-team/subagent tool. Claude Code does not
  document a standalone socket that an unrelated local process can use to
  mutate an already-running conversation.

Consequently, OpenKan must not write Claude transcripts or attach to private
process internals. Messages are written to an atomic Bizar inbox and delivered
at a supported hook boundary. When a session ID is known, OpenKan can request a
background resume so the hook boundary occurs promptly.

Primary references:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code agent view](https://code.claude.com/docs/en/agent-view)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)

## Architecture

```text
Browser
  │ REST commands + WebSocket snapshots/events
  ▼
OpenKan local server
  │ JSON subprocess contract
  ▼
bizar control
  ├── .claude/agents/*.md          agent catalogue
  ├── Git-common tasks.sqlite      durable task graph
  ├── claude agents --json         live/background sessions
  ├── claude --background          start/resume
  └── .bizar/control/messages/     atomic message inbox
           │
           ▼
    Claude Code hooks inject messages
```

### Ownership boundaries

- **Bizar owns semantics and persistence.** OpenKan never imports Bizar source
  files, opens Bizar's SQLite database, edits Claude transcripts, or duplicates
  task-claim rules.
- **OpenKan owns presentation and transport.** It validates HTTP/WebSocket
  requests, runs the configured Bizar CLI in the configured project root, and
  broadcasts refreshed snapshots.
- **Claude Code owns sessions.** Bizar calls only documented CLI operations and
  hooks. Stop is offered only for locally spawned background sessions whose PID
  is reported by Claude Code.

## Configuration

OpenKan stores integration settings in `.ok/config.json`:

```json
{
  "bizar": {
    "enabled": true,
    "projectRoot": "/absolute/path/to/project",
    "command": "bizar"
  }
}
```

Environment variables override file settings for automation:

- `OPENKAN_BIZAR_PROJECT_ROOT`
- `OPENKAN_BIZAR_COMMAND`

The server is bound to loopback by default. The Bizar endpoints must remain
unavailable when the integration is disabled or the configured project root
cannot be resolved.

## Control operations

### Read

- `GET /api/bizar/snapshot`
- `GET /api/bizar/agents`
- `GET /api/bizar/tasks`
- `GET /api/bizar/sessions`
- `GET /api/bizar/messages`

### Mutate

- `POST /api/bizar/tasks`
- `POST /api/bizar/tasks/:id/claim`
- `POST /api/bizar/tasks/:id/heartbeat`
- `POST /api/bizar/tasks/:id/complete`
- `POST /api/bizar/tasks/:id/cancel`
- `POST /api/bizar/sessions`
- `POST /api/bizar/sessions/:id/messages`
- `POST /api/bizar/sessions/:id/stop`
- `POST /api/bizar/messages`

### WebSocket

`/api/bizar/ws` sends:

- `snapshot` after connect and after every successful mutation;
- `changed` when watched Bizar control/task files change;
- `error` when the configured bridge is unavailable.

Clients may send `{ "type": "refresh" }` or
`{ "type": "command", "requestId": "...", "command": "...", "payload": {} }`.
The server responds with a correlated `result` or `error`.

## Message lifecycle

1. A sender writes a complete JSON document to a temporary file.
2. An atomic rename publishes it under `messages/queued/`.
3. A `SessionStart` or `UserPromptSubmit` hook claims matching messages with an
   atomic rename into `messages/processing/`.
4. The hook emits the message text as `additionalContext`.
5. The message is moved to `messages/delivered/` with delivery metadata.
6. If injection fails, the file is moved back to `queued/` or to `failed/`
   after bounded retries.

This file-per-message protocol prevents two agents from consuming the same
message and avoids a shared JSONL rewrite race.

## Security and interference controls

- Accept only loopback HTTP/WebSocket connections by default.
- Treat configured command and project paths as settings, never request-body
  shell fragments.
- Use `spawn`/`spawnSync` with argument arrays and `shell: false`.
- Validate task IDs, agent IDs, UUID session IDs, message size, and string
  lengths before crossing the CLI boundary.
- Continue to rely on Bizar's task leases and path scopes for edit isolation.
- Do not expose Claude credentials, raw transcript contents, or arbitrary file
  browsing through the Bizar bridge.

## Verification

1. Bizar unit tests cover control JSON, fake-Claude lifecycle calls, message
   claiming, duplicate-consumer prevention, and task mutations.
2. OpenKan unit tests cover configuration, CLI argument construction, failure
   mapping, API validation, and WebSocket snapshot refresh.
3. Browser smoke verifies all four workspaces render and commands update the
   view.
4. Full OpenKan `npm test` and `npm run check`.
5. Full Bizar `make check`, `make test`, `make e2e`, `make check-arch`, and
   `make clean-check`.
