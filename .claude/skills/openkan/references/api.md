# OpenKan agent API

OpenKan serves its local API at `http://127.0.0.1:7777`. Start it with
`openkan start --no-open` and inspect the complete agent view with
`openkan agent context`.

Use `openkan api <path> --method <GET|POST|PATCH|PUT|DELETE> --data '<JSON>'`
for every endpoint below. The bridge accepts loopback hosts only and returns
non-zero for HTTP errors, so it is safe for agent scripts and CI checks.

## Board and tasks

- `GET /api/board`, `GET /api/tasks-index`, `GET /api/tasks/:id`
- `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`
- `POST /api/tasks/bulk`, `POST /api/organize`, `POST /api/import`
- `POST /api/tasks/:id/archive`, `POST /api/tasks/:id/restore`
- `GET|POST /api/tasks/:id/comments`; `POST /api/tasks/:id/ask` and
  `POST /api/tasks/:id/respond`
- `GET /api/tasks/:id/subtasks`, `GET /api/tasks/:id/mdx-rendered`
- `GET|POST /api/tasks/:id/images`, `GET|DELETE /api/tasks/:id/images/:name`
- `POST /api/tasks/:id/recheck-stale`

Use `openkan agent start <task-id> --agent <id> --model <id>` to launch the
configured agent for a task and `openkan agent abort <task-id>` to stop it.

## Planning and goals

Use the `ok` CLI for plans, tasks, PRDs, locking, evidence, and schema checks.
The dashboard goal mirror is `GET /api/goals`; update a goal with:

```sh
openkan api /api/goals/prd-ABC/g1 --method PATCH --data '{"status":"met"}'
```

## Docs, chat, and Claude control plane

- Docs: `GET /api/docs`, `GET|PUT|DELETE /api/docs/:path`,
  `POST /api/docs/generate`
- Chat: `POST /api/chat/send`, `GET /api/chat/sessions`,
  `GET /api/chat/sessions/:id`, `POST /api/chat/sessions/:id/abort`
- Claude discovery: `GET /api/claude/snapshot`, plus `/agents`, `/skills`,
  `/commands`, `/hooks`, `/teams`, `/workflows`, `/model-router`, `/activity`.

For live read-only streams, use `GET /api/events`, `GET /api/claude/events`,
and `GET /api/chat/events` as SSE. Do not use the generic CLI bridge for SSE.

## Projects, discovery, and configuration

- Projects: `GET|POST /api/projects`, `PATCH /api/projects/:id/active`,
  `POST /api/projects/auto-detect`, `DELETE /api/projects/:id`
- Discovery: `/api/search`, `/api/tags`, `/api/changelog`,
  `/api/changelog/summary`, `/api/insights/velocity`, `/api/contributors`
- Configuration: `GET|PATCH /api/settings`, `GET /api/config-sections`, and
  `PATCH /api/config-sections/:sectionId`

Only mutate the active `.ok/` workspace. `.openkan/` is legacy import input.
