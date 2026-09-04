# `.ok/` — OpenKan Planning System

Self-contained, JSON-based planning layer for Claude Code agents and humans.
Lives next to your project under `.ok/` (sibling of `.git/`, `.claude/`,
`.openkan/`, `node_modules/`).

This README is the **developer** reference. End users should read
[`docs/OK-PLANNING.md`](../../docs/OK-PLANNING.md). Agents that pick the
`ok-planning` skill get everything they need from the skill itself.

## File layout

```
.ok/
├── config.json          # workspace metadata, schema version
├── index.json           # fast pointer file for listings
├── tasks/<id>.json      # one file per task
├── plans/<id>.json      # one file per plan
├── prds/<id>.json       # one file per long-horizon PRD
├── sessions/<iso>.jsonl # append-only activity log
└── locks/<id>.lock      # optional claim/heartbeat locks
```

## Module layout (this directory)

```
ok/
├── README.md            # this file
├── schemas.ts           # TypeScript types + JSON-schema-style validators
├── storage.ts           # async read/write with atomic semantics
├── lock.ts              # per-task claim/heartbeat/release
├── ids.ts               # nanoid-prefix id helpers
├── index.ts             # rebuild .ok/index.json from filesystem
├── doctor.ts            # validate every JSON against its schema
└── commands/
    ├── init.ts          # `ok init`
    ├── task.ts          # `ok task add|list|show|update|claim|heartbeat|complete|cancel`
    ├── plan.ts          # `ok plan add|list|show|update`
    ├── prd.ts           # `ok prd add|list|show|update`
    ├── index.ts         # `ok index`
    └── doctor.ts        # `ok doctor`
```

## Schema versioning

Every persisted entity carries a `schema` field, e.g. `"ok.task.v1"`. The
pattern is `ok.<entity>.v<MAJOR>`. Backwards-compatible additive changes are
**not** a MAJOR bump — add optional fields freely. Breaking changes
(rename, type narrowing, required → optional is fine, optional → required
is breaking) require:

1. Bump the version (`v1` → `v2`).
2. Add a parser in `ok/storage.ts` that auto-migrates `v1` → `v2` on load.
3. Rewrite on the next save.

The CLI and storage layer never silently drop data. Unknown schemas surface
a hard error from `doctor`.

## Adding a subcommand

1. Create `ok/commands/<name>.ts` exporting a function `run(ctx, args)`
   that returns `{ code: number }` and prints to `process.stdout` /
   `process.stderr`.
2. Register it in `bin/ok.ts` under `subcommands`.
3. Add `tests/ok-<name>.test.mts` exercising the happy path and the most
   common failures (parse errors, lock contention, schema drift).
4. Mention the subcommand in `docs/OK-PLANNING.md` and the skill body.
5. Keep one logical operation per commit; the new subcommand, its tests,
   and its docs land together.

## Concurrency model

- Storage uses atomic writes (`.tmp` + rename) and is safe across
  processes on the same machine.
- Locks are advisory JSON files under `.ok/locks/`. They are not
  `fcntl`-based; a malicious or crashed writer can ignore them. The lock
  protocol is:
  1. `claim <id> --owner X` writes `.ok/locks/<id>.lock` with
     `{owner: "X", leasedUntil: "<ISO>"}`.
  2. `heartbeat <id> --owner X` updates `leasedUntil` in place.
  3. `complete <id>` or `cancel <id>` validates the lock is held by the
     same owner (or is absent / expired) before mutating the task.
  4. The lock is removed on terminal transitions; transient ones are
     left to expire naturally (default 1h lease).

Multiple readers are fine. Multiple writers on the same task are
serialized by the lock; cross-task writes are independent.

## Why `.ok/` (not `.openkan/` or `.claude/`)

- `.git/` is the source of truth for code; planning state is not code.
- `.openkan/` is owned by the OpenKan server (MDX frontmatter, boards);
  mixing planning JSON there would couple two unrelated models.
- `.claude/` is the Claude Code configuration root; agent skills and
  hooks live there.
- `.ok/` is a deliberately short namespace reserved for this system; it
  is the only folder an agent needs to know about to use the planning
  layer.

## Why JSON (not YAML / TOML / SQLite)

- JSON is the universal interchange format every agent, hook, and editor
  already understands.
- One file per entity keeps diffs reviewable in PRs.
- No native dependencies (no SQLite native binding required on Node).
- Human-readable with `cat` and `jq` even without the `ok` CLI.
