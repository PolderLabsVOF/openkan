# OpenKan Board Sync Issue — `ok task add` vs `ok board add`

Status: tracked (PRD + task queued)
Owners: openkan core
Date: 2026-09-07

## Problem statement

`ok task add "<title>"` and `ok board add "<title>"` write to two different stores
that do not synchronise. Agents following the official SessionStart hint create
tasks via `ok task add`, which lands them in `.ok/tasks/<id>.json` (offline
agent-owned lease file). The HTTP server's board (`.ok/board.json` → visible at
`http://127.0.0.1:7777/`) is a separate store. From a human operator's
perspective, agent work disappears.

### Concrete reproduction

```sh
$ ok task add "Investigate flaky e2e"
tsk-abc123
$ ok board list | jq '.tasks[].title' | grep "flaky"
# (empty — the task exists on disk but is not on the board)
```

The reconciler in `kanban/board.ts` (`reconcileOfflineTaskEntry` and friends)
*can* push offline entries onto the board, but it is not invoked from
`ok task add` itself — it runs on board load. With no running server, no board
load, and no reconciler trigger, the entry stays offline-only.

### Secondary defects observed

1. `ok board move <id> <column>` returns 200 but does not move the task.
   Cause: server stores `columnId` in cache, `column` in board JSON; the PATCH
   path lands on a stale schema view.
2. The HTTP API is asymmetric: POST writes `column`, GET `/api/board` returns
   `columnId`. Read/write symmetry broken.
3. `ok board` has no `delete` subcommand. Cleanup of accidental duplicates
   requires raw `DELETE /api/tasks/<id>`.
4. `ok board add --column <col>` does honour `--column` (verified in
   `ok/commands/board.ts:20`), so the `--column ignored` claim in the bug
   report was inaccurate — but `ok task add` has no `--column` at all.

## Fix: Option A — single store, dual API

Make `ok task add` and `ok board add` write to the **same** record. `.ok/tasks/`
becomes a derived index of board tasks for agents that need lease semantics
(owner/heartbeat/deps), not a separate write store. The HTTP server (or a
local file mirror of it) is the single source of truth.

### New behaviour

| Command        | Writes to                  | Visible on board |
| -------------- | -------------------------- | ---------------- |
| `ok task add`  | HTTP server (or board.json when offline) | Yes              |
| `ok board add` | HTTP server (or board.json when offline) | Yes              |
| `ok task claim <id>` | `assignees[]` + heartbeat lease on board task | Yes |
| `ok task heartbeat <id>` | updates `lastSeenAt` on board task     | Yes |
| `ok task complete <id>` | moves board task to `column: done` + status | Yes |

### Implementation outline

1. **`ok task add`** (`ok/commands/task.ts:cmdTaskAdd`)
   - After writing the offline task, POST to `/api/tasks` (with the new id as
     `clientId` so the server can correlate and avoid double-creating).
   - If the server is unreachable (no dashboard running), fall back to a
     direct `board.json` write so the task survives across restarts and the
     reconciler can promote it on next server boot.
   - The offline `.ok/tasks/<id>.json` file is rewritten to mirror the
     server-returned shape so it serves as a lease cache, not an alternative
     record.

2. **`apiCreateTask`** (`kanban/server.ts:566`)
   - Accept an optional `clientId` in the body. If present and a board task
     already exists with that `clientId` (stored in a new
     `offlineMirrorId?: string` field), update instead of create — prevents
     duplicates when an agent retries after a network blip.
   - Emit `task.created` on the WebSocket bridge so the operator's UI updates
     without a manual refresh.

3. **SessionStart hint** (`.claude/hooks/ok-init.mjs`)
   - Update the printed hint from
     "OpenKan: .ok/ is not initialised. First move: run ok init, then create a scoped task or PRD."
     to
     "OpenKan ready. Create work with `ok task add` — visible on the board at the dashboard URL."

4. **Reconciler** (`kanban/board.ts:reconcileOfflineTaskEntry`)
   - On every server boot, mirror all offline `.ok/tasks/<id>.json` entries
     whose `mirrorStatus === "pending"` onto the board with idempotency by
     `clientId`. Mark `mirrorStatus === "synced"`. Already-mirrored entries are
     a no-op.

5. **`ok board move`** bug fix
   - Trace the stale-schema view that returns 200 without updating. Likely
     candidate: a non-canonical writer competing with the board-lock guard in
     `kanban/server.ts` (`selfWriteUntil`).

6. **`ok board delete`** subcommand
   - New `delete` branch in `ok/commands/board.ts` → `DELETE /api/tasks/<id>`.
     Already supported server-side; just wire the CLI.

### Migration

On first run after upgrade, the reconciler walks `.ok/tasks/`, sets
`mirrorStatus: "synced"` for entries that already exist on the board (by
title + owner heuristic; conservative), and writes any offline entries that
are missing from the board.

### Risks

- **Concurrent offline writes**: two agents working in the same workspace
  without a server may both POST the same `clientId`. Mitigation: include a
  per-agent UUID in `clientId`; first writer wins on the board.
- **Schema drift**: the offline task schema (`ok.task.v1`) has fields the
  board task does not (`plan`, `prd`, `scope`, `acceptance`, `deps`). Store
  these in a new `extensions` field on the board task so the board schema
  stays narrow.
- **Backwards compat**: existing operators reading `.ok/tasks/` directly
  (e.g. for grep, audits) must continue to work. The derived index is
  shape-compatible: same `id`, `title`, `status`, `owner`, `priority`, plus
  the new `mirrorStatus` and `extensions`.

### Verification

- Unit tests: `ok task add` produces a board task with the same id; offline
  fallback writes a valid `board.json`; reconciler is idempotent; duplicate
  POST is a no-op.
- Integration: `ok task add` while the dashboard is running puts the task on
  the board; `ok task add` while the dashboard is down puts the task on the
  board once it restarts.
- E2E: open `http://127.0.0.1:7777/`, run `ok task add` from the terminal,
  see the card appear without a refresh.

## Acceptance criteria

- `ok task add "X"` produces a card on the board at the dashboard URL.
- `ok task claim <id>` and `ok task heartbeat <id>` work end-to-end against
  the same id.
- The reconciler is idempotent — running it twice produces the same board.
- `ok board move` actually moves the card.
- `ok board delete <id>` removes the card.
- The SessionStart hint accurately describes the single-store model.
- `make check`, `make test`, `make e2e`, and the openkan-skill-content test
  remain green.
