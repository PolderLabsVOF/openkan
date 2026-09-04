---
name: openkan
description: Use OpenKan as the durable project control plane. Always use this skill when a project contains .ok/, when managing project tasks or agent work, or when the user mentions OpenKan, kanban work, task status, project progress, agent sessions, or collaboration. Keep OpenKan tasks, task workspaces, status, decisions, and verification evidence synchronized throughout non-trivial work.
---

# OpenKan project workflow

Treat OpenKan as the source of truth for project work. Keep it synchronized
while working; do not reconstruct task state only at the end.

OpenKan is a local-first MDX kanban with two sibling surfaces:

- **The board** (this skill) — five-column kanban, MDX task workspaces,
  comments, structured questions, archives, changelog.
- **The planning system** — durable tasks, plans, and PRDs that share the
  same `.ok/` directory but are managed with the `ok` CLI. PRDs own goals;
  plans and tasks roll up to them.

Use both as appropriate. The board owns visible work and acceptance evidence;
the planning system owns long-horizon scope. They never conflict.

## Begin every non-trivial task

1. Find the project root by walking upward for `.ok/`.
2. Run `openkan status`. If OpenKan is stopped, run `openkan start --no-open`.
3. Confirm the canonical workspace and current work. `.ok/` is the only
   writable workspace. Do **not** create or write `.openkan/`; it is legacy
   import input only.

   ```sh
   ok init
   curl -fsS http://127.0.0.1:7777/api/board
   curl -fsS http://127.0.0.1:7777/api/tasks-index
   ok task list --json
   ok prd list --json
   ```

4. Reuse the matching active task. Otherwise create a focused task with a
   concrete outcome and acceptance criteria.
5. Move the selected task to `doing` before changing project files.

For long-horizon work, create or reuse a PRD and claim a planning task:

```sh
ok prd add "Outcome" --vision "Why this matters" --goals "Goal one|Goal two" --owners "agent"
ok task add "Deliver outcome" --prd prd-... --owner agent --priority p1
ok task claim tsk-... --owner agent
```

Keep the planning task current with `ok task update`, `ok task review`, and
`ok task complete --evidence "validation output"`. Reference its ID in the
board task description when both surfaces are used.

## While you work

- Keep task status honest. Move it to `doing` when you start editing files,
  to `review` when validation passes, and only to `done` once the acceptance
  criteria are actually met.
- Append every meaningful change to the task workspace as comments.
- When you discover follow-up work, add a subtask rather than expanding
  scope on the parent.
- When you need a decision, use a `choice` input so the answer is recorded
  and reviewable, not buried in a chat reply.

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

## Native Claude Code control plane

OpenKan reads your local Claude Code install directly. It exposes agents,
skills, commands, hooks, teams, and workflows as a management surface.

```sh
curl -fsS http://127.0.0.1:7777/api/claude/snapshot
curl -fsS http://127.0.0.1:7777/api/claude/agents
curl -fsS http://127.0.0.1:7777/api/claude/workflows
```

Live updates stream over WebSocket and SSE — no polling required:

```text
ws://127.0.0.1:7777/api/claude/ws     WebSocket
GET  /api/claude/events               SSE
```

When you start or stop a Claude session, the dashboard reflects it within a
second. Use the Claude endpoints to discover what is running before you
start a new agent; it is wasteful to spawn a duplicate when one is already
active on the same task.

## Chat sidebar

The left-side chat rail drives Claude Code directly from the dashboard.
Backend routes (subject to change while the feature is in development):

```text
POST /api/chat/send                    send a turn; spawns `claude -p`
GET  /api/chat/sessions                list sessions + archived
GET  /api/chat/sessions/<sid>          full transcript
POST /api/chat/sessions/<sid>/abort    kill running subprocess
```

Sessions persist as JSONL under `.ok/sessions/` (gitignored). Reopening a
session restores the full transcript plus the model / effort / permissions
that were selected at send time.

Prefer the chat sidebar for one-off orchestration — quick questions, plan
reviews, commit messages. Prefer the planning skill + a board task for
multi-step work that needs an audit trail.

## Goals workspace

The **Goals** dashboard tab is a direct view of the durable PRDs in
`.ok/prds/`; it is not a second task store. It lists each PRD vision and its
goals, and lets users update a goal’s state (`open`, `in_progress`, `met`, or
`dropped`). The UI uses:

```text
GET   /api/goals
PATCH /api/goals/<prd-id>/<goal-id>  {"status":"in_progress"}
```

Use the CLI for creating, editing scope, milestones, and PRD metadata:

```sh
ok prd list --json
ok prd update prd-... --goal g1 --goal-status met
```

Every API update writes the PRD and rebuilds `.ok/index.json`; do not edit
legacy `.openkan/` state. If a repository still contains legacy data, import
it once with `ok migrate-from-openkan`, verify `.ok/`, then remove the legacy
folder only when the migration is confirmed.

## M1 checkbox import

Scanning a directory or file for Markdown checkboxes and converting them
into tracked board tasks is a first-class operation. Use it when the user
has existing TODO lists they want tracked.

```sh
openkan import --path notes.md
openkan import --include "**/*.md"
```

Or over HTTP:

```sh
curl -fsS -X POST http://127.0.0.1:7777/api/import \
  -H 'content-type: application/json' \
  -d '{"path":"notes.md","include":"**/*.md"}'
```

Imported tasks keep a `source.path` and `source.line` reference so the
dashboard can deep-link back to the original file.

## Insights

The Insights tab shows a 30-day stacked-bar chart of column flow sourced
from `.ok/changelog.jsonl`. Useful for spotting velocity trends and
bottleneck columns before committing to a sprint plan.

```sh
curl -fsS "http://127.0.0.1:7777/api/insights/velocity?days=30"
```

Returns zero-filled arrays when the changelog is empty; do not treat that
as an error.

## Collaboration

Before editing shared areas, inspect tasks in `doing` and `review` to avoid
overlapping ownership. Split independent scopes into subtasks and identify
the owned files in each task description.

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

For Claude control-plane endpoints (snapshot, agents, workflows, sessions,
chat, insights), see `references/api.md` before invoking them.

## Finish

1. Run the project's required validation.
2. Append the commands and outcomes to the task workspace.
3. Re-read the task and board for concurrent changes.
4. Move the task to `review` or `done` based on actual evidence.
5. Leave a concise handoff comment when another agent or user must continue.

Never report completion while OpenKan still shows the work as stale,
unverified, or in progress.
