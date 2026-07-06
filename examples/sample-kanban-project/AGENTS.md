# OpenKan workflow for this project

When the user asks for kanban work in this project, prefer the existing
custom tools:

1. `kanban_import` — scan `.md` / `.mdx` files for `- [ ]` and create one
   Backlog task per hit. Idempotent on unchanged files.
2. `kanban_add` — create a task by hand (use when there's no source file).
3. `kanban_move` — promote a task from Backlog → To Do → In Progress → Review → Done.
4. `kanban_start` — dispatch the OpenCode agent on a task. Sets status to
   `running`. Does not change column — call `kanban_move` separately if you
   want the column to advance.
5. `kanban_view` — read-only listing of the board, filterable by column and
   status (including `waiting-for-input`).
6. `kanban_ask` — ask the user a structured question; sets state to
   `waiting-for-input` and writes an inline `<Ask>` / `<Choice>` / `<Input>`
   / `<Confirm>` block into the task MDX.
7. `kanban_comments` — read the comments for a task with block context
   (line number and excerpt from the source MDX).
8. `kanban_preview` — dry-run a TSX snippet; returns the compiled JS or an
   error so you can validate before embedding `<Preview>` in the MDX.

Conventions:

- Do not silently rewrite docs. Imported tasks are derived state — they
  live in `.openkan/tasks.json` and `tasks/<id>/`, not in the source MDX.
- If you change a `- [ ]` to `- [x]` in a doc, the imported task remains in
  state until the user moves it. M3 will add drift detection.
- The board is the source of truth for in-flight work. Committing
  `.openkan/tasks.json` and `tasks/<id>/task.mdx` is fine; do not commit
  `.openkan/sessions/` or `tasks/<id>/inputs.json` if it contains private
  answers.
- When writing `<Preview>` components, keep the TSX under 32KB and
  self-contained: the sandbox has no imports, no network, no storage.
