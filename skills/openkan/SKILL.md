---
name: openkan
description: Manage project tasks, goals, plans, progress and agent work through the OpenKan CLI. Use when a project contains .ok/ or the user asks to track project work with OpenKan.
---

# OpenKan project workflow

Use `openkan` commands, not handwritten HTTP requests or direct JSON edits.
`.ok/` is the durable workspace; `.openkan/` is legacy import input only.
Run from the project root or a child directory of an existing `.ok/` workspace.

## Install and discover

```sh
npm install -g @drb0rk/openkan
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
