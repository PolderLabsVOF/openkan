---
name: openkan
description: Use OpenKan as the durable project control plane. Always use this skill when a project contains .ok/, when managing project tasks or agent work, or when the user mentions OpenKan, kanban work, task status, project progress, agent sessions, or collaboration. Keep OpenKan tasks, task workspaces, status, decisions, and verification evidence synchronized throughout non-trivial work.
---

# OpenKan project workflow

Treat OpenKan as the source of truth for project work. Keep it synchronized
while working; do not reconstruct task state only at the end.

## Begin every non-trivial task

1. Find the project root by walking upward for `.ok/`.
2. Run `openkan status`. If OpenKan is stopped, run `openkan start --no-open`.
3. Read the board and current work:

   ```sh
   curl -fsS http://127.0.0.1:7777/api/board
   curl -fsS http://127.0.0.1:7777/api/tasks-index
   ```

4. Reuse the matching active task. Otherwise create a focused task with a
   concrete outcome and acceptance criteria.
5. Move the selected task to `doing` before changing project files.
6. Read its complete workspace with `GET /api/tasks/<id>`.

Do not create OpenKan tasks for greetings, one-line explanations, or other
work that makes no project change.

## Keep work synchronized

- Keep one primary task active per agent unless the user explicitly requests
  parallel work.
- Update the task title, description, column, priority, agent, and assignees
  when reality changes.
- Record plan changes, decisions, blockers, progress, and validation evidence
  in `.ok/tasks/<task-id>/task.mdx`.
- Prefer HTTP API mutations while the server is running. This preserves atomic
  writes and sends live updates to browsers and collaborating agents.
- Re-read the task before major transitions. Another agent may have updated it.
- Use comments for review feedback and durable handoffs. Set authors to
  `agent:<name>` for agent-written comments.
- Use structured input requests only when missing information truly blocks
  progress. Continue safe work while non-blocking questions are pending.
- Never edit `.ok/board.json`, comments indexes, input indexes, Bizar
  databases, or session transcripts directly.

## Task lifecycle

Create:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks \
  -H 'content-type: application/json' \
  -d '{
    "title": "Implement focused outcome",
    "description": "Goal, constraints, and acceptance criteria",
    "column": "todo",
    "priority": "high",
    "assignee": "agent:NAME"
  }'
```

Read and claim:

```sh
curl -fsS http://127.0.0.1:7777/api/tasks/TASK_ID
curl -fsS -X PATCH http://127.0.0.1:7777/api/tasks/TASK_ID \
  -H 'content-type: application/json' \
  -d '{"column":"doing","assignees":["agent:NAME"]}'
```

Move to review only after implementation and targeted validation:

```sh
curl -fsS -X PATCH http://127.0.0.1:7777/api/tasks/TASK_ID \
  -H 'content-type: application/json' \
  -d '{"column":"review"}'
```

Move to done only when the requested outcome is verified and the task
workspace includes concise evidence:

```sh
curl -fsS -X PATCH http://127.0.0.1:7777/api/tasks/TASK_ID \
  -H 'content-type: application/json' \
  -d '{"column":"done","state":"done"}'
```

If work fails or becomes blocked, keep the task out of `done`, record the exact
blocker, and leave a concrete next action.

## Collaboration

Before editing shared areas, inspect tasks in `doing` and `review` to avoid
overlapping ownership. Split independent scopes into subtasks and identify the
owned files in each task description.

Add a handoff or review comment:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/TASK_ID/comments \
  -H 'content-type: application/json' \
  -d '{
    "blockId": "progress",
    "line": 1,
    "text": "Changed X; validation Y passed; remaining risk Z.",
    "author": "agent:NAME"
  }'
```

Ask a blocking choice:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/tasks/TASK_ID/ask \
  -H 'content-type: application/json' \
  -d '{
    "type": "choice",
    "question": "Which deployment target should be used?",
    "options": [
      {"id":"staging","label":"Staging"},
      {"id":"production","label":"Production"}
    ]
  }'
```

For Bizar sessions, agents, messages, and durable coordination, read
`references/api.md` before invoking the control-plane endpoints.

## Finish

1. Run the project’s required validation.
2. Append the commands and outcomes to the task workspace.
3. Re-read the task and board for concurrent changes.
4. Move the task to `review` or `done` based on actual evidence.
5. Leave a concise handoff comment when another agent or user must continue.

Never report completion while OpenKan still shows the work as stale,
unverified, or in progress.
