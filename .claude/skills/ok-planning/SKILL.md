---
name: ok-planning
description: |
  Track tasks, plans, and long-horizon PRDs in this project's .ok/ folder
  via the `ok` CLI. Use this skill whenever the user asks to plan, scope,
  break down, or track work. Also use when starting a session to discover
  existing tasks/PRDs. Trigger phrases: "plan this", "track this task",
  "add to PRD", "what's open in the planning", "ok tasks", "ok prds",
  "ok plans", "claim a task", "show my open work".
---

# ok-planning

`.ok/` is the project's self-contained planning workspace. The `ok` CLI
manages it. OpenKan reads and writes the same store, so anything you
write here shows up in the OpenKan UI automatically.

## Quick reference

```
ok init                                  # create .ok/ if missing
ok task add "Wire X" --owner me          # add a task
ok task list --status pending            # discover open work
ok task claim <id> --owner me            # claim before starting
ok task heartbeat <id> --owner me        # refresh lease
ok task complete <id> --owner me --evidence "..."   # finish
ok prd add "Big goal" --vision "..." --goals "g1|g2"   # define a PRD
ok plan add "Milestone" --prd <prd-id> --tasks t1,t2  # group tasks under a PRD
ok index                                 # rebuild .ok/index.json
ok doctor                                # validate JSON against schemas
```

All commands are also JSON-parseable via `--json` for scripted use.

## Storage layout

```
.ok/
├── config.json          workspace metadata, schema version
├── index.json           fast pointer for listings (rebuild with `ok index`)
├── tasks/<id>.json      one file per task
├── plans/<id>.json      one file per plan
├── prds/<id>.json       one file per PRD
├── sessions/<iso>.jsonl append-only activity log (reserved)
└── locks/<id>.lock      claim/heartbeat locks
```

## Schemas (abridged)

`ok.task.v1`: `{schema, id, title, description?, owner?, status, priority?, plan?, prd?, scopes?, deps?, createdAt, updatedAt, startedAt?, completedAt?, evidence?, acceptance?}`. Status: `pending|in_progress|review|done|cancelled`. Priority: `p0|p1|p2|p3`.

`ok.plan.v1`: `{schema, id, title, summary, prd?, phase?, status, tasks[], acceptance[], createdAt, updatedAt}`. Status: `draft|active|blocked|complete|abandoned`.

`ok.prd.v1`: `{schema, id, title, vision, goals[], nonGoals[], successMetrics[], milestones[], risks[], plans[], owners[], reviewCadence?, status, createdAt, updatedAt, nextReviewAt?}`. Status: `draft|active|shipped|abandoned`.

Full schemas with examples are in `references/schemas.md`.

## Workflows

### Start of session

```sh
ok task list --status pending --json   # what is open?
ok task list --status in_progress --json   # what is someone doing?
ok task claim <id> --owner <self>      # take ownership before starting
```

If you forgot to init: `ok init` is idempotent and safe to run at any time.

### End of session

```sh
ok task complete <id> --owner <self> --evidence "<commit/file/url>"
# or, if you decide not to finish:
ok task cancel <id> --owner <self> --reason "<why>"
ok index                                 # refresh .ok/index.json
```

Evidence must be a concrete reference: a commit sha, a `path:line`, a URL, or
a one-line summary of what shipped.

### Scope a feature (PRD + Plan + Tasks)

```sh
# 1. Define the long-horizon goal
ok prd add "Self-contained planning workspace" \
  --vision "Every project ships with .ok/ for tasks, plans, and PRDs." \
  --goals "ship CLI|ship skill|ship auto-init" \
  --milestones "v0.1 schema|v1.0 launch" \
  --non-goals "Windows support" \
  --owners "karen,todd" \
  --review-cadence weekly
# → prd-AbCdEfGh

# 2. Group tasks under the PRD
ok plan add "v0.1: schemas + storage" --prd prd-AbCdEfGh --tasks tsk-…,tsk-…
# → pln-XyZ12345

# 3. Tasks can reference the plan via --plan pln-XyZ12345 when adding
ok task add "Write storage.ts" --plan pln-XyZ12345 --owner karen
```

### Recover from drift

```sh
ok doctor         # reports malformed JSON / schema mismatches
ok index          # rebuild .ok/index.json from filesystem
```

If a lock is held by a stale owner (`--lease-ms` default is 1h), run
`ok task claim <id> --owner <self>` after the lease expires, or `ok
task release <id> --owner <stale-owner>` if you know the owner.

### Hand off to another agent

```sh
# Releasing agent: write the handoff as evidence
ok task update <id> --evidence "handoff to <new-agent>: <summary>"

# Picking-up agent: claim with the new owner name
ok task claim <id> --owner <new-agent>
```

Every claim writes `.ok/locks/<id>.lock`. If a different agent already
holds it, you'll see `locked by …` and should coordinate rather than
force-take.

### Migrate from a legacy `.openkan/` workspace

```sh
ok migrate-from-openkan        # one-shot, idempotent
```

Imports tasks from `.openkan/tasks.json` and `.openkan/board.json` into
`.ok/tasks/<id>.json`. Status mapping: `state=done → done`,
`state=running|waiting-for-input → in_progress`,
`column=review → review`, everything else → `pending`. Archived tasks
become `cancelled`.

## Integration with OpenKan

OpenKan's task engine reads from `.ok/board.json` and mirrors every task
into `.ok/tasks/<id>.json` on every write. The planning `ok` CLI and the
OpenKan UI therefore see the same state:

- Adding a task with `ok task add` makes it appear in the OpenKan board
  on the next index refresh (the engine picks it up automatically).
- Editing a task in the OpenKan UI updates `.ok/tasks/<id>.json` (the
  mirror write is automatic on `persist()`).
- The `.ok/index.json` is the canonical listing for skill agents and
  indexers; OpenKan's UI uses `.ok/board.json` for ordering.

The `.ok/` directory is the single source of truth for both tools.

## Why `.ok/` (not `.openkan/` or `.claude/`)

- `.git/` is the source of truth for code.
- `.openkan/` was the original location; it has been renamed to `.ok/`
  in this branch (`feat/ok-planning-system`) so the directory name is
  short, easy to type, and unowned by any single tool.
- `.claude/` holds Claude Code configuration (skills, hooks, settings).
- `.ok/` is the planning layer that both OpenKan and the Claude Code
  planning skill read and write.

## Edge cases

- **Concurrent claims** — the lock protocol rejects a second claim from
  a different owner. The first writer wins until the lease expires or
  they release. See `ok/lock.ts`.
- **Schema drift** — `ok doctor` validates every file against its
  schema. Unknown fields are tolerated; missing required fields are
  flagged.
- **Partial writes** — `ok/storage.ts` writes to `<path>.tmp-<pid>-<ts>`
  then renames. A crashed mid-write leaves a `.tmp-*` file that the next
  `ok init` can clean up.
- **Lost sessions** — locks expire after 1h by default. A claim from a
  different agent becomes possible after that.
- **Plan ↔ task back-link** — `--tasks t1,t2` on a plan back-links the
  tasks (sets `task.plan`). The inverse (`task.prd`) is set only when
  the task is created with `--prd`; plan-then-prd linkage requires a
  separate `ok task update <id> --prd <prd-id>`.

## Examples

### Example 1: add, claim, complete

```sh
$ ok init
.ok/ initialised at /home/me/project/.ok
  config.json
  index.json
  tasks/
  plans/
  prds/
  sessions/
  locks/

$ ok task add "Implement claim helper" --owner alice --priority p1
tsk-9brjCkWa

$ ok task claim tsk-9brjCkWa --owner alice
tsk-9brjCkWa

$ ok task complete tsk-9brjCkWa --owner alice --evidence "ok/lock.ts lines 60–105, all claim tests green"
tsk-9brjCkWa
```

### Example 2: PRD with goals

```sh
$ ok prd add "Self-contained planning workspace" \
    --vision "Every project ships with .ok/ for tasks, plans, PRDs." \
    --goals "ship CLI|ship skill|ship auto-init" \
    --milestones "v0.1 schema|v1.0 launch"
prd-T6g9Pz_X

$ ok prd update prd-T6g9Pz_X --goal g1 --goal-status met
prd-T6g9Pz_X

$ ok prd show prd-T6g9Pz_X --json | jq '.goals'
[
  { "id": "g1", "text": "ship CLI", "status": "met" },
  { "id": "g2", "text": "ship skill", "status": "open" },
  { "id": "g3", "text": "ship auto-init", "status": "open" }
]
```

### Example 3: scope a plan under a PRD

```sh
$ ok plan add "v0.1: schemas + storage" \
    --prd prd-T6g9Pz_X \
    --summary "ship the .ok/ storage layer end-to-end" \
    --acceptance "all schemas validate" "tests green" \
    --tasks tsk-…,tsk-…
pln-7Hg2Vu3W

$ ok task list --plan pln-7Hg2Vu3W --json | jq 'length'
4
```

### Example 4: concurrent claim resolution

```sh
# alice claims
$ ok task claim tsk-aaaaaa --owner alice
tsk-aaaaaa

# bob tries
$ ok task claim tsk-aaaaaa --owner bob
locked by alice until 2026-09-04T11:30:00.000Z
$ echo $?
1
```

### Example 5: drift recovery

```sh
$ ok doctor
ok doctor: 1 issue(s)
  tasks/tsk-corrupt.json: JSON parse error: Unexpected token n in JSON at position 3

$ rm .ok/tasks/tsk-corrupt.json
$ ok index
tasks: 12, plans: 3, prds: 1
$ ok doctor
ok doctor: 0 issues
```

## References

- `references/schemas.md` — full schema definitions with worked examples.
- `references/workflows.md` — six end-to-end agent flows.
- `references/integration.md` — how the skill, hook, CLI, and OpenKan
  engine fit together; how to extend with a new subcommand.

## Why this skill is self-contained

A Claude Code agent that loads this skill gets everything needed to plan,
track, and recover work without reading any other file. The optional
`references/` directory adds depth for agents that want it, but the body
above is sufficient for first-pass work.
