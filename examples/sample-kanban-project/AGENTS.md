# OpenKan workflow for this project

When the user asks for kanban work in this project, prefer the four
existing custom tools plus `kanban_import` (M1):

1. `kanban_import` — scan `.md` / `.mdx` files for `- [ ]` and create one
   Backlog task per hit. Idempotent on unchanged files.
2. `kanban_add` — create a task by hand (use when there's no source file).
3. `kanban_move` — promote a task from Backlog → To Do → In Progress → Review → Done.
4. `kanban_start` — dispatch the OpenCode agent on a task. Sets status to
   `running`. Does not change column — call `kanban_move` separately if you
   want the column to advance.
5. `kanban_view` — read-only listing of the board, filterable by column and
   status.

Conventions:

- Do not silently rewrite docs. Imported tasks are derived state — they
  live in `.openkan/board.json` and `state.json`, not in the source MDX.
- If you change a `- [ ]` to `- [x]` in a doc, the imported task remains in
  state until the user moves it. M3 will add drift detection.
- The board is the source of truth for in-flight work. Committing
  `.openkan/board.json` is fine; do not commit `.openkan/sessions/`.
