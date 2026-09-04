---
description: Discover configured Claude agents, skills, commands, hooks, teams, and workflows; then start or abort a task agent safely.
---

Run `openkan agent context` and inspect `/api/claude/snapshot` before starting
anything. Reuse an existing active session when possible. Use
`openkan agent start <task-id> --agent <id> --model <id>` and verify status.
Use `openkan agent abort <task-id>` only for the specified task.

Request: $ARGUMENTS
