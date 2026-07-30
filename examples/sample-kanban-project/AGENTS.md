# Agent guidance

Use the OpenKan HTTP API at `http://127.0.0.1:7777` for task mutations.

1. Read `GET /api/board` before changing task state.
2. Keep source links when importing checkboxes from `docs/roadmap.mdx`.
3. Use `POST /api/tasks` for new work and `PATCH /api/tasks/:id` for updates.
4. Use `POST /api/tasks/:id/start` to dispatch a named Bizar agent.
5. Record progress and evidence in `.openkan/tasks/<id>/task.mdx`.
