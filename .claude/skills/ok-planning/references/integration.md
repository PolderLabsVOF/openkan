# Integration — how the pieces fit

```
┌─────────────────────────────────────────────────────────────────┐
│                       Claude Code                                │
│                                                                  │
│  ┌─────────────┐  SessionStart   ┌──────────────┐                │
│  │  ok-init.mjs │ ───────────────▶│  bin/ok.ts   │                │
│  │   (hook)     │                 │  (CLI entry) │                │
│  └─────────────┘                 └──────┬───────┘                │
│                                         │                         │
│                                         ▼                         │
│                              ┌─────────────────────┐              │
│                              │  ok/commands/*.ts    │              │
│                              │  task / plan / prd   │              │
│                              │  index / doctor      │              │
│                              └──────────┬──────────┘              │
│                                         │                         │
│                                         ▼                         │
│                              ┌─────────────────────┐              │
│                              │  ok/storage.ts       │              │
│                              │  ok/lock.ts          │              │
│                              │  ok/schemas.ts       │              │
│                              └──────────┬──────────┘              │
└─────────────────────────────────────────┼────────────────────────┘
                                          │
                                          ▼
                                  ┌─────────────────┐
                                  │     .ok/        │
                                  │ config.json     │
                                  │ index.json      │
                                  │ tasks/<id>.json │
                                  │ plans/<id>.json │
                                  │ prds/<id>.json  │
                                  │ locks/<id>.lock │
                                  └────────┬────────┘
                                           │
                                  dual-write (every board persist)
                                           │
                                           ▼
                                  ┌─────────────────┐
                                  │  kanban/board.ts │
                                  │  OpenKan engine  │
                                  └─────────────────┘
```

## Pieces

### 1. `bin/ok.ts` (CLI entry)

Dispatches to subcommands. Run via `node --experimental-strip-types
bin/ok.ts …` or through `bin/ok.mjs` which is a small Node launcher.

### 2. `ok/commands/*.ts` (subcommands)

Each file exports a `runX(args)` function and optionally runs as a
subprocess via the bottom-of-file `if (import.meta.url === …)` block.

- `task.ts` — `ok task add|list|show|update|claim|heartbeat|complete|cancel|release`
- `plan.ts` — `ok plan add|list|show|update`
- `prd.ts` — `ok prd add|list|show|update`
- `index.ts` — `ok index` and `ok doctor`
- `init.ts` — `ok init`

### 3. `ok/storage.ts` (storage layer)

Async JSON I/O with atomic writes. Path helpers (`paths(root)`) resolve
every well-known file/dir under `.ok/`. The core operations are
typed: `readTask`, `writeTask`, `listTasks`, etc.

### 4. `ok/lock.ts` (claim/heartbeat/release)

Advisory JSON locks under `.ok/locks/`. Rejects concurrent writes from
different owners; leases expire after `--lease-ms` (default 1h).

### 5. `ok/schemas.ts` (validation)

TypeScript types and runtime validation. `ok doctor` runs every file
through the corresponding validator.

### 6. `ok/migrate.ts` (legacy import)

One-shot import of `.openkan/tasks.json` and `.openkan/board.json` into
`.ok/tasks/<id>.json`. Idempotent; second run is a no-op.

### 7. `.claude/hooks/ok-init.mjs` (SessionStart hook)

Reads `process.env.CLAUDE_PROJECT_DIR` and runs `ok init` if `.ok/`
doesn't exist. Always exits 0 (hooks never block Claude).

### 8. `kanban/board.ts` (OpenKan engine)

Persists the OpenKan board to `.ok/board.json` AND mirrors each task
into `.ok/tasks/<id>.json` (via `mirrorToOkStore`). This is the
integration point: every board write becomes a planning-system write.

### 9. `.claude/skills/ok-planning/` (this skill)

The agent-facing surface. Self-contained: a Claude Code agent that loads
the skill gets everything needed to plan, track, and recover work.

## Adding a new subcommand

1. Create `ok/commands/<name>.ts` exporting `run<X>(args)` that
   returns `{ code: number }`.
2. Register it in `bin/ok.ts` under the main switch.
3. Add a test in `tests/ok-<name>.test.mts` exercising the happy path
   and the most common failures (parse errors, lock contention, schema
   drift).
4. Mention the subcommand in the skill body and in `docs/OK-PLANNING.md`.

Keep one logical operation per commit: the subcommand, its tests, and
its docs land together.

## Why dual-write?

The OpenKan engine's existing API surface (`withWrite`, `persist`) is
unchanged. The mirror write in `mirrorToOkStore` adds a side-effect
that materialises the planning-system JSON files. Two paths write the
same data:

- `ok task add` → writes `.ok/tasks/<id>.json` directly.
- OpenKan UI → `kanban/board.ts:persist()` → mirror writes each task.

Both paths produce identical `.ok/tasks/<id>.json` content. The mirror
write is idempotent and safe to call repeatedly.

## What if the mirror write fails?

The board persist still succeeds; the mirror write is wrapped in
try/catch and never aborts the engine. If the mirror fails (disk full,
permission error), the next `ok index` will notice the missing file
and surface it via `ok doctor`.

## Why no SQLite / no central DB?

- JSON files are diffable in PRs.
- One file per entity scales to thousands of tasks per project.
- No native bindings → runs anywhere Node runs.
- The `ok doctor` + `ok index` pair gives you DB-equivalent consistency
  checks without the runtime.

## Limits

The `.ok/` layout assumes:

- A single project per directory (the workspace is project-scoped).
- Trust between writers (advisory locks, not fcntl).
- File-system atomic rename (every supported platform).
- Node ≥ 22 (for `--experimental-strip-types`).

If any of these assumptions breaks in your environment, the planning
system is the wrong tool — use a database.
