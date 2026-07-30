---
description: Conservatively organize an OpenKan board using its local HTTP API.
---

Organize the OpenKan board at `http://127.0.0.1:7777/`.

1. Read `/api/board`, `/api/tasks-index`, and relevant task details.
2. Identify miscategorized, related, stale, or underspecified tasks.
3. Preserve tasks in In Progress or Review unless they are clearly abandoned.
4. Build the smallest useful batch of move, tag, priority, effort, area, archive,
   or restore operations.
5. Submit the operations to `POST /api/organize`.
6. Re-read the board and report exactly what changed and what was skipped.

Be conservative. Do not delete tasks. Do not alter active Bizar sessions.
