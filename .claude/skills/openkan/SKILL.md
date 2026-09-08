---
name: openkan
description: Use the OpenKan CLI (`openkan` or `ok`) for every project task, goal, plan, progress, board, comment, and agent operation in a project that contains .ok/. Do not curl the dashboard, do not edit .ok/ JSON or MDX directly, do not bypass the CLI. Fall back to `openkan api /api/PATH` only when the CLI genuinely lacks the operation.
---

# OpenKan project workflow

## Default behavior — read first

This is a **default-behavior contract**, not a tip. The rules below apply
before any command lookup, before any HTTP request, and before any file
edit.

1. **Default to `openkan` for everything that touches project state** —
   tasks, goals, plans, progress, boards, comments, docs, agents,
   imports. The CLI is the source of truth and writes `.ok/` atomically.

2. **Never send raw `curl` or `wget` to the dashboard.** If you find
   yourself writing `curl http://127.0.0.1:7777/...` or
   `wget http://127.0.0.1:7777/...`, stop — that is a bug. Reach for
   `openkan api /api/PATH` or one of the dedicated subcommands instead.

3. **Never edit `.ok/board.json`, `.ok/tasks/<id>/state.json`, or any
   `.ok/**/*.mdx` directly.** Do not write to `.ok/chat/*.jsonl` by hand.
   Run the CLI; it owns the schema, the indexes, the watchers, and the
   mirror hooks.

4. **If a CLI subcommand appears to be missing, use
   `openkan api /api/PATH`** with `--method`, `--data`, `--data-file`,
   or `--json` — never `curl`. The `openkan api` escape hatch targets
   the dashboard's selected project, not necessarily `cwd`.

5. **Native Claude runtime state is observational.** Read `.claude/`,
   `~/.claude/`, and Claude control-plane endpoints when investigating;
   never mutate them to fake progress or override the planner.

6. **Always keep `.ok/tasks/<your-id>` updated.** Before each durable
   handoff (a commit, a file handoff, a sleep, a context boundary), call
   `openkan task update <id>` with fresh evidence. Never let a task stall
   in `in_progress` while you work on something else.

If any of the rules above conflict with a faster-looking shortcut, the
rules win. The shortcut is almost always wrong: a `curl` POST bypasses
the lock and mirror hooks; a hand edit to `.ok/board.json` desynchronizes
the indexes; a write to `.claude/` lies to the user.

## Decision rules

Pattern-match on what you need, then run the matching CLI. These are the
common shapes — always reach for `openkan <command> --help` first when
the flag set is unclear.

| If you need to… | Run |
| --- | --- |
| Read or list tasks, plans, PRDs, goals, progress | `openkan <noun> list --json` |
| Show one entity | `openkan <noun> show <id> --json` |
| Create | `openkan <noun> add ...` |
| Mutate | `openkan <noun> update <id> ...` |
| Add a board card (visual board, not planning) | `openkan board add ...` (not `task add`) |
| Comment on a board card | `openkan board comment <id> ...` |
| Move a board card between columns | `openkan board move <id> <column>` |
| React to a missing subcommand | `openkan api /api/PATH --method ...` (never `curl`) |
| Run an agent on a board card | `openkan agent start <id> --agent ... --model ...` |
| Inspect capability, model, or schema state | `openkan agent capabilities`, `openkan agent context` |

Below is the full command reference. Reach for `openkan <command> --help`
first; everything below assumes you've already established the default
above.

## Install and discover

```sh
npm install -g @polderlabs/openkan
openkan skill install --agent all
openkan init
openkan task list --json
openkan prd list --json
openkan goal list --json
openkan progress --json
```

Installation is a one-time setup, not a per-task operation. Reuse a matching task
if one exists. Planning commands work offline without a server. The shorter `ok`
command supports the same task/plan/prd/goal/progress operations. Use
`openkan --help` and `ok help` for the command reference.

## Track execution

```sh
openkan task add "Deliver scoped change" --owner codex --priority p1 --acceptance "Regression test passes|Installed CLI works"
openkan task claim tsk-ID --owner codex
openkan task heartbeat tsk-ID --owner codex
openkan task update tsk-ID --evidence "Implemented X; test Y passed; Z remains"
openkan task update tsk-ID --status review
openkan task complete tsk-ID --owner codex --evidence "Test command and outcome; commit or file reference"
```

Claims default to a one-hour lease; refresh during longer work. Do not take
another owner's claim or complete work without validation evidence. Cancel with
`task cancel <id> --owner NAME --reason TEXT`; release a claim with `task release`.
Read and list commands support `--json`; existing mutation commands print the
entity ID (do not assume every mutation returns JSON).

## Agent discipline — non-negotiable lifecycle rules

1. **Claim or create a task before doing implementation work.** If `.ok/` has a task that matches your scope, claim it with `openkan task claim <id> --owner AGENT_NAME`. If no task fits, create one with `openkan task add "..." --owner AGENT_NAME --prd prd-ID --plan pln-ID --description "..."`. Work without a claim is unauditable and pollutes the board.

2. **Heartbeat during long-running work.** Refresh the lease every 30 minutes with `openkan task heartbeat <id> --owner AGENT_NAME --lease-ms 3600000`. Do not let a lease expire without renewal or cancellation.

3. **Update status at every durable handoff.** When you finish a phase (test written, fix landed, evidence produced), call `openkan task update <id> --evidence "..."`. Never leave the task in `in_progress` overnight.

4. **Always complete or cancel.** At session end, every `in_progress` task owned by you must end as `done` (with evidence) or `cancelled` (with `--reason "why"`). Unfinished work is `cancelled`, not abandoned.

5. **Never create fixture-shaped tasks in the user's `.ok/`.** Fixtures look like:
   - `owner: null` (no `--owner` passed)
   - trivial title matching `move a card`, `server-visible task`, `integration in_progress`, `integration reconcile smoke`, `dedupe this POST`, or `smoke reconcile ...`
   - `description: "auto-generated: ..."`
   If a sub-agent or test creates one, cancel with `openkan task cancel <id> --owner AGENT_NAME --reason "fixture leak"`.

6. **Tests must never write to the user's `.ok/`.** Integration tests that spawn `ok serve` MUST (a) avoid `--project=<tmpdir>` (rely on `cwd`), (b) set `XDG_CONFIG_HOME=<tmpdir>` so the registry cannot pollute the user's `~/.config/openkan/projects.json`, (c) clean up tmps in `t.after`. Any leaked fixture is a regression — file a bug.

7. **Sub-agents inherit the parent's discipline.** When you dispatch a sub-agent to do implementation, the sub-agent MUST claim, update, and complete-or-cancel its own tasks. Wire the task ID through the sub-agent's prompt and verify on completion.

## Goals and progression

Goals belong to a PRD, not a separate store. Save IDs from creation commands
and substitute them below; do not use the example placeholders literally.

```sh
openkan prd add "Release outcome" --vision "Why it matters" --goals "Ship CLI|Verify install"
openkan prd update prd-ID --status active
openkan plan add "Release phase" --prd prd-ID --summary "Implementation and validation"
openkan task add "Verify clean install" --prd prd-ID --plan pln-ID --owner codex
openkan goal add prd-ID "Publish package" --json
openkan goal update prd-ID g1 --status in_progress
openkan goal update prd-ID g1 --status met
openkan plan update pln-ID --phase validation --status active
openkan progress --prd prd-ID --json
```

`progress` reports status counts, completion percentages and dependency-ready
tasks. Cancelled/dropped/abandoned items are excluded from completion denominators;
empty denominators report 0%. It does not mark goals or plans complete for you.
Use `goal show <prd> <goal>` for detail and `goal update ... --text TEXT` to edit.

## Dashboard tasks and collaboration

The visual board and planning records are related but distinct surfaces. Do not
assume a planning-only task is already a board card. Use board commands for cards
and include the planning ID in their description when tracking both.

```sh
openkan start --no-open
openkan project list
openkan project use PROJECT_ID
openkan board list
openkan board add "Visible work item" --description "Planning task: tsk-ID" --column doing
openkan board show BOARD_TASK_ID
openkan board comment BOARD_TASK_ID "Changed X; validation Y passed" --author agent:codex
openkan board move BOARD_TASK_ID review
openkan board move BOARD_TASK_ID done
```

Board commands require the local server and reject a mismatched dashboard
project. Their output is JSON. Select the intended project explicitly. Pass
`--port N` if the server is not using its configured default port.

## Agent and advanced features

```sh
openkan agent capabilities
openkan agent context
openkan agent start BOARD_TASK_ID --agent AGENT_ID --model MODEL_ID
openkan agent abort BOARD_TASK_ID
openkan import --path notes.md
```

For less common features (docs, chat, structured inputs, bulk changes), consult
[the API reference](references/api.md) and use `openkan api /api/PATH` or
`openkan agent call`. These commands handle transport; do not use `curl`.
`openkan api` targets the dashboard's selected project, not necessarily cwd.
Use `--method`, `--data` or `--data-file`, and `--json` for structured requests.
Native Claude state is observational: never mutate Claude runtime files.

## Finish

Run validation, append evidence, re-read current task state, then complete the
task and update associated goals/plan only when their criteria are met.
Run `openkan doctor` and leave unresolved work visible rather than marking it done.
