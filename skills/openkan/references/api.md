# OpenKan agent API reference

The local server defaults to `http://127.0.0.1:7777`. Use the port reported by
`openkan status` when the project overrides it.

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

Task columns are `backlog`, `todo`, `doing`, `review`, and `done`. Preserve task
IDs. Prefer archive over delete when history may remain useful.

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

## Bizar control plane

Inspect the live snapshot before mutations:

```sh
curl -fsS http://127.0.0.1:7777/api/bizar/snapshot
```

Start a session:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/bizar/sessions \
  -H 'content-type: application/json' \
  -d '{"agent":"mike","prompt":"Coordinate this project","name":"Project work"}'
```

Send a message:

```sh
curl -fsS -X POST \
  http://127.0.0.1:7777/api/bizar/sessions/SESSION_ID/messages \
  -H 'content-type: application/json' \
  -d '{"text":"Review the latest task state","from":"openkan"}'
```

Start or stop the Bizar agent assigned to an OpenKan task:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/TASK_ID/start \
  -H 'content-type: application/json' \
  -d '{"agent":"mike"}'

curl -fsS -X POST http://127.0.0.1:7777/api/tasks/TASK_ID/abort
```

Do not bypass these endpoints to edit Bizar state or session files.
