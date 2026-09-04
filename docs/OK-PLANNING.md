# `.ok/` — OpenKan Planning Workspace

![Planning banner](./web/brand/banner-docs.svg)

> **Status:** the new default. The legacy `.openkan/` directory has been
> renamed to `.ok/` on `feat/ok-planning-system`. OpenKan reads and writes
> `.ok/` directly; the planning CLI (`ok`) and the OpenKan UI share the
> same store.

## What is it?

A self-contained, JSON-based planning layer that lives in a project's
`.ok/` folder (sibling of `.git/`, `.claude/`, `node_modules/`). It
covers three layers:

- **Tasks** — atomic units of work, life-of-hours-to-days.
- **Plans** — medium-lived groups of tasks toward one outcome, days-to-weeks.
- **PRDs** — long-horizon Product Requirements Documents, weeks-to-months.

Every project gets one. A single `ok init` creates the folder. A Claude
Code hook creates it automatically on session start. A skill teaches
agents how to use it.

## When to use it

Use `.ok/` whenever you need to plan, track, or recover work — in any
project, in any conversation, with any agent (Bizar, plain Claude Code,
the user).

| You want to… | Use |
|--------------|-----|
| Add a thing to do | `ok task add "..."` |
| See what's open | `ok task list --status pending` |
| Take ownership of work | `ok task claim <id> --owner me` |
| Mark something done | `ok task complete <id> --owner me --evidence "..."` |
| Define a long-horizon goal | `ok prd add "..." --vision "..." --goals "g1\|g2"` |
| Group tasks under a PRD | `ok plan add "..." --prd <id> --tasks t1,t2` |
| Recover from a corrupted file | `ok doctor` then `ok index` |

## Quick start

```sh
# 1. Initialise (idempotent)
ok init

# 2. Add a task
ok task add "Wire .ok/ to the OpenKan engine" --owner alice --priority p1
# → tsk-AbCdEfGh

# 3. Claim it
ok task claim tsk-AbCdEfGh --owner alice

# 4. Do the work, then mark complete with evidence
ok task complete tsk-AbCdEfGh --owner alice --evidence "kanban/board.ts:200-260"

# 5. Look at the index
ok index
# tasks: 1, plans: 0, prds: 0
```

That's the core loop. Everything else builds on it.

## How `.ok/` is laid out

```
.ok/
├── config.json              workspace metadata, schema version
├── index.json               fast pointer for listings
├── tasks/<id>.json          one file per task
├── plans/<id>.json          one file per plan
├── prds/<id>.json           one file per PRD
├── sessions/<iso>.jsonl     append-only activity log (reserved)
└── locks/<id>.lock          claim/heartbeat locks
```

Every persisted entity carries a `schema` field (`ok.task.v1`,
`ok.plan.v1`, `ok.prd.v1`, `ok.config.v1`, `ok.index.v1`). The
discriminator is the only identity you should rely on for parsing.

## Schemas at a glance

```ts
// Task — atomic unit
{ schema: "ok.task.v1", id, title, description?, owner?, status, priority?, plan?, prd?, scopes?, deps?, createdAt, updatedAt, startedAt?, completedAt?, evidence?, acceptance? }

// Plan — group of tasks
{ schema: "ok.plan.v1", id, title, summary, prd?, phase?, status, tasks[], acceptance[], createdAt, updatedAt }

// PRD — long-horizon goal
{ schema: "ok.prd.v1", id, title, vision, goals[], nonGoals[], successMetrics[], milestones[], risks[], plans[], owners[], reviewCadence?, status, createdAt, updatedAt, nextReviewAt? }
```

Full schemas with field-level descriptions and worked examples are in
[`.claude/skills/ok-planning/references/schemas.md`](../.claude/skills/ok-planning/references/schemas.md).

## Status enums

| Entity | Values |
|--------|--------|
| Task | `pending` → `in_progress` → `review` → `done`; `cancelled` from any state |
| Plan | `draft` → `active` → (`complete` \| `abandoned`); `blocked` is a soft halt |
| PRD | `draft` → `active` → (`shipped` \| `abandoned`) |

The status enum is the canonical lifecycle indicator. OpenKan's UI
column placement is a presentation concern that maps onto it on read
(`column=doing ↔ status=in_progress`, etc.).

## Common agent workflows

### Discover what's open

```sh
ok task list --status pending --json | jq 'length'
ok task list --status in_progress --json   # avoid stepping on someone else
ok task list --plan pln-AbCdEfGh --json   # what's in a specific plan?
```

### Take ownership before starting work

```sh
ok task claim <id> --owner <self>           # default 1h lease
ok task claim <id> --owner <self> --lease-ms 7200000   # 2h lease
```

If a different agent already holds the lock, you'll see `locked by …`
and should coordinate.

### Mark done with concrete evidence

```sh
ok task complete <id> --owner <self> --evidence "<commit-sha-or-path-or-summary>"
```

Evidence lets the next agent (or the user) verify the work.

### Scope a feature

```sh
# PRD
ok prd add "Self-contained planning workspace" \
  --vision "Every project ships with .ok/ for tasks, plans, and PRDs." \
  --goals "ship CLI|ship skill|ship auto-init" \
  --milestones "v0.1 schema|v1.0 launch" \
  --owners "karen,todd"
# → prd-AbCdEfGh

# Plan under the PRD
ok plan add "v0.1: schemas + storage" \
  --prd prd-AbCdEfGh \
  --summary "Ship the .ok/ storage layer end-to-end." \
  --acceptance "all schemas validate" "tests green"
# → pln-XyZ12345

# Tasks (back-link to plan via --plan)
ok task add "Write storage.ts" --plan pln-XyZ12345 --owner alice
```

### Recover from drift

```sh
ok doctor    # reports malformed JSON / schema mismatches
ok index     # rebuilds .ok/index.json from the filesystem
```

Common drift scenarios:

- **Stale lock** — wait for the lease to expire (1h default) or release
  with `ok task release <id> --owner <known-owner>`.
- **Index out of sync** — `ok index` rebuilds it.
- **Schema version mismatch** — bump the schema field and add a
  migration; never silently drop fields.

### Migrate from a legacy `.openkan/` workspace

```sh
ok migrate-from-openkan
```

Idempotent. Maps `state=done → done`, `column=review → review`, etc.

## Integration with OpenKan

OpenKan's task engine reads `.ok/board.json` and mirrors each task into
`.ok/tasks/<id>.json` on every persist. The planning CLI and the
OpenKan UI see the same state:

- Adding a task with `ok task add` makes it appear in the OpenKan board
  on the next index refresh (the engine picks it up automatically via
  the mirror write).
- Editing a task in the OpenKan UI updates `.ok/tasks/<id>.json`.
- The `.ok/index.json` is the canonical listing for skill agents and
  indexers; OpenKan's UI uses `.ok/board.json` for ordering.

The `.ok/` directory is the single source of truth for both tools.

## Auto-init via Claude Code hook

Every Claude Code session in a project with `.claude/hooks/ok-init.mjs`
will trigger `ok init` on `SessionStart`. The hook is a no-op when
`.ok/config.json` already exists, so the cost on every session is a
single `existsSync` check.

## Skill for agents

The `ok-planning` skill (`.claude/skills/ok-planning/SKILL.md`) is the
primary agent interface. It contains:

- Quick reference (5-line CLI primer).
- Schema summaries.
- Six end-to-end workflows.
- Five worked examples.
- Edge-case handling (concurrent claims, schema drift, lost sessions).

Install it at user level with `npm run ok-install` so it follows the
operator across projects.

## Why `.ok/` (and not `.openkan/`)

The brief was to rename `.openkan/` → `.ok/` so the directory is short,
easy to type, and unowned by any single tool. The directory lives next
to the project; it is JSON-parseable by any agent; it is the same
folder OpenKan reads for its board.

If you have an existing `.openkan/` folder elsewhere, run
`ok migrate-from-openkan` from its project root to bring it under the
new name.

## Edge cases

- **Concurrent claims** — the lock protocol rejects a second claim from
  a different owner. The first writer wins until the lease expires
  (default 1h) or they release.
- **Schema drift** — `ok doctor` validates every file against its
  schema. Unknown fields are tolerated; missing required fields are
  flagged.
- **Partial writes** — `ok/storage.ts` writes to `<path>.tmp-<pid>-<ts>`
  then renames. A crashed mid-write leaves a `.tmp-*` file; safe to
  delete.
- **Lost sessions** — locks expire after 1h by default. A claim from a
  different agent becomes possible after that.

## Reference

- Skill: `.claude/skills/ok-planning/SKILL.md`
- Schemas: `.claude/skills/ok-planning/references/schemas.md`
- Workflows: `.claude/skills/ok-planning/references/workflows.md`
- Integration: `.claude/skills/ok-planning/references/integration.md`
- Source: `ok/README.md`
- Tests: `tests/ok-*.test.mts`
