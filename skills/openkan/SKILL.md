---
name: openkan
description: Manage OpenKan tasks, projects, documents, comments, Bizar agents, sessions, and messages through the local OpenKan API and durable project files.
---

# OpenKan

OpenKan is a local-first kanban and Bizar control plane. The server normally
runs at `http://127.0.0.1:7777` and stores project data under `.openkan/`.

## Start and inspect

```sh
openkan status
openkan start
curl -fsS http://127.0.0.1:7777/api/board
```

Prefer the HTTP API while the server is running so writes remain atomic and
live browser clients receive updates.

## Task workflow

Create a task:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Implement feature","description":"Goal and acceptance criteria","column":"todo"}'
```

Read and update:

```sh
curl -fsS http://127.0.0.1:7777/api/tasks/tsk-example
curl -fsS -X PATCH http://127.0.0.1:7777/api/tasks/tsk-example \
  -H 'content-type: application/json' \
  -d '{"column":"doing","priority":"high"}'
```

Start a Bizar agent for a board task:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/tsk-example/start \
  -H 'content-type: application/json' \
  -d '{"agent":"mike"}'
```

Stop its active session:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/tsk-example/abort
```

Archive, restore, or delete:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/tsk-example/archive
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/tsk-example/restore
curl -fsS -X DELETE http://127.0.0.1:7777/api/tasks/tsk-example
```

## Search and bulk changes

```sh
curl -fsS 'http://127.0.0.1:7777/api/search?query=authentication'
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/bulk \
  -H 'content-type: application/json' \
  -d '{"kind":"move","taskIds":["tsk-one","tsk-two"],"column":"review"}'
```

For a board-wide cleanup, send a conservative operation list to
`POST /api/organize`. Do not change active tasks unless the user explicitly
requested it.

## MDX workspace

Every task has a durable workspace:

```text
.openkan/tasks/<task-id>/task.mdx
```

Use it for goals, context, acceptance criteria, decisions, progress, and
evidence. Comments and structured inputs live beside it in `comments.json` and
`inputs.json`.

Read comments:

```sh
curl -fsS http://127.0.0.1:7777/api/tasks/tsk-example/comments
```

Ask for structured input:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/tsk-example/ask \
  -H 'content-type: application/json' \
  -d '{"type":"choice","question":"Which option?","options":["A","B"]}'
```

## Bizar control plane

Snapshot all Bizar resources:

```sh
curl -fsS http://127.0.0.1:7777/api/bizar/snapshot
```

Start an independent session:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/bizar/sessions \
  -H 'content-type: application/json' \
  -d '{"agent":"mike","prompt":"Coordinate this project","name":"OpenKan project"}'
```

Send a session message:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/bizar/sessions/SESSION_ID/messages \
  -H 'content-type: application/json' \
  -d '{"text":"Review the latest task state","from":"openkan"}'
```

Use the Bizar workspace in the browser for agent discovery, durable task
leases, session management, message history, feature status, and live updates.

## Safety

- Keep the server on loopback.
- Treat `.openkan/sessions/` as sensitive.
- Do not edit Bizar databases or Claude session transcripts directly.
- Prefer API mutations over hand-editing JSON indexes.
- Preserve task IDs and state transitions.
