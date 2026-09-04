# OpenKan agent API reference

The local server defaults to `http://127.0.0.1:7777`. Use the port reported
by `openkan status` when the project overrides it.

All endpoints are loopback-only. Authentication is not provided; do not
expose the port to a network.

## Board and tasks

```text
GET    /api/board
GET    /api/tasks-index
GET    /api/tasks/:id
POST   /api/tasks
PATCH  /api/tasks/:id
DELETE /api/tasks/:id
POST   /api/tasks/:id/archive
POST   /api/tasks/:id/restore
GET    /api/tasks/:id/subtasks
POST   /api/tasks/bulk
GET    /api/search?query=<text>
```

Task columns are `backlog`, `todo`, `doing`, `review`, and `done`. Preserve
task IDs. Prefer archive over delete when history may remain useful.

## Comments and input

```text
GET    /api/tasks/:id/comments
POST   /api/tasks/:id/comments
PATCH  /api/tasks/:id/comments/:commentId
DELETE /api/tasks/:id/comments/:commentId
POST   /api/tasks/:id/ask
POST   /api/tasks/:id/respond
```

A comment requires `blockId`, `text`, and normally `line` and `author`.
Resolving a comment accepts:

```json
{"resolved":true,"reason":"Addressed in commit abc123","author":"agent:mike"}
```

A choice input uses option objects with stable IDs:

```json
{
  "type": "choice",
  "question": "Which option?",
  "options": [
    {"id":"a","label":"Option A","description":"Tradeoff"},
    {"id":"b","label":"Option B","description":"Tradeoff"}
  ]
}
```

## M1 checkbox import

```text
POST   /api/import
```

Body:

```json
{"path":"notes.md","include":"**/*.md","exclude":"**/archive/**"}
```

Returns `{ imported: [{ id, source: { path, line } }], skipped: number }`.
Imported tasks carry `source.path` and `source.line` so the dashboard can
deep-link back to the original Markdown file.

## Native Claude Code control plane

Read the live snapshot first; it lists agents, teams, workflows, and
sessions without polling.

```text
GET    /api/claude/snapshot
GET    /api/claude/agents
GET    /api/claude/skills
GET    /api/claude/commands
GET    /api/claude/hooks
GET    /api/claude/teams
GET    /api/claude/workflows
GET    /api/claude/model-router
GET    /api/claude/activity-tail?limit=200
```

Live updates stream over WebSocket and SSE. The WebSocket sends the full
snapshot on connect, then deltas:

```text
ws://127.0.0.1:7777/api/claude/ws
GET  /api/claude/events                 (SSE)
```

Message shapes from the bridge:

```json
{"type":"snapshot","data":{...}}
{"type":"delta","data":{"agents":[...],"sessions":[...]}}
```

## Chat sidebar (in development)

Backend routes are subject to change while the feature lands. Session
transcripts persist to `.ok/chat/<sid>.jsonl`.

```text
POST   /api/chat/send                    spawn `claude -p` and persist both turns
GET    /api/chat/sessions                list active + archived
GET    /api/chat/sessions/<sid>          full transcript
DELETE /api/chat/sessions/<sid>          archive
POST   /api/chat/sessions/<sid>/abort    kill running subprocess
GET    /api/chat/sessions/<sid>/events   SSE stream of new turns
```

Send body:

```json
{
  "sessionId": "ses-optional-or-omit-for-new",
  "message": "Review the latest task state",
  "model": "sonnet",
  "effort": "medium",
  "permissionMode": "default"
}
```

`permissionMode` accepts `accept-edits | default | plan | bypass-permissions`.

## Insights

```text
GET    /api/insights/velocity?days=30
```

Returns zero-filled arrays when the changelog is empty or missing:

```json
{
  "windowDays": 30,
  "generatedAt": "2026-09-04T12:00:00.000Z",
  "columns": {
    "backlog": [0,0,0,...],
    "todo":    [0,0,0,...],
    "doing":   [0,0,0,...],
    "review":  [0,0,0,...],
    "done":    [0,0,0,...]
  },
  "days": ["2026-08-05","2026-08-06",...]
}
```

## What you must NOT do

- Do not edit `.ok/board.json`, `.ok/tasks/<id>.json`, or `.ok/chat/*.jsonl`
  directly. Use the HTTP routes so the mirror hooks, watchers, and indexes
  stay in sync.
- Do not bypass the loopback. These endpoints assume `127.0.0.1`; exposing
  them gives unauthenticated write access to the project.
- Do not delete `.ok/` to "reset" — it removes audit history. Use
  `openkan archive` and the planning system's `ok prd close` instead.
- Do not assume a Claude control-plane endpoint is read-write. `/api/claude/*`
  is observability only; writes happen via the chat sidebar or via direct
  Claude Code CLI usage.
