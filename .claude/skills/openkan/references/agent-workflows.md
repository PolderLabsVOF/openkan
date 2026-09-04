# OpenKan agent workflows

## First minute

```sh
ok init
openkan start --no-open
openkan agent context > /tmp/openkan-context.json
ok task list --json
ok prd list --json
```

Inspect active agents, workflows, and locks before claiming work. Claim a task
before editing; heartbeat on long work; include test/validation evidence before
completion.

## Feature matrix

| Need | Preferred surface |
| --- | --- |
| Durable work, ownership, PRDs | `ok task`, `ok plan`, `ok prd` |
| Board move/tag/archive/bulk changes | `openkan api` |
| Agent discovery and task execution | `openkan agent context`, `openkan agent start` |
| A focused Claude turn | `/api/chat/send` through `openkan api` |
| Docs editing/generation | `/api/docs/*` through `openkan api` |
| Goal state | `ok prd update` or `/api/goals/*` |
| Project registration/switching | `/api/projects/*` through `openkan api` |
| Insights and changelog analysis | `/api/insights/*`, `/api/changelog*` |

## Mutations

Read first. Use `--data` with valid JSON and verify by reading the relevant
endpoint after a write. Never use `openkan reset --hard` unless the user
explicitly requests destructive cleanup.
