---
description: Organize the openkan kanban board — re-categorize, clean up, and group related tasks. Read .openkan/board.json and .openkan/tasks.json, then use kanban_organize to apply a batch of changes atomically.
---

You are organizing the openkan kanban board for the current project.

The dashboard is running at http://127.0.0.1:7777/.

Use the kanban tools to:
1. Read the current board with `kanban_view` (no filter).
2. For each task, run `kanban_view` again with the task id or fetch `/api/tasks/<id>` via your tooling to see its full content.
3. Re-derive `category`, `priority`, and `effort` from the title and description.
4. Identify:
   - Miscategorized tasks (the derived category disagrees with the current column)
   - Related tasks (share an `area:` tag or appear to be about the same feature)
   - Stale tasks (empty description, last activity >30 days, status `cancelled` or `failed`)
   - Vague tasks (need a description; mark with the `needs-detail` tag)

5. Build a batch of `kanban_organize` operations to apply. Suggested rules:
   - Move tasks in `Backlog` with a `backend` category and a `P1`/`high` priority to `To Do`.
   - Move tasks that have been `failed` for >30 days to archived (use the `archive` operation).
   - Add `area:<name>` to tasks that share a clear theme (3+ tasks in the same Backlog area).
   - Add `needs-detail` to tasks with empty descriptions that have been in Backlog for >7 days.
   - Re-derive tags for tasks whose content has drifted from their original tag set.

6. Call `kanban_organize` with the batch. The tool will return a diff of what changed and what was skipped.

7. Report a short summary:
   - How many tasks moved, retagged, archived
   - Which areas/themes you grouped
   - What you did NOT change and why (be conservative)

Do not ask the user for confirmation for moves within reason. The user can always undo. Do not touch tasks in `In Progress` or `Review` unless they have been stale for >14 days.
