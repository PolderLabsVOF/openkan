# Unified Task Storage Plan

**Goal:** Migrate from flat `.ok/tasks/<id>.json` + `kanban/tasks.json` dual-store to directory-per-task `.ok/tasks/<id>/task.json` with v2 superset schema, v1 read fallback, and reversible phases.

---

## Current State

| Store | Location | Schema | Write Path |
|---|---|---|---|
| Planning JSON | `.ok/tasks/<id>.json` | `ok.task.v1` | `ok/storage.ts:writeTask` |
| Legacy Board | `.ok/tasks.json` | `{version:1,columns,tasks}` | `kanban/board.ts:persist` |
| Task MDX | `.ok/tasks/<id>/task.mdx` | MDX frontmatter | `kanban/mdx.ts:writeTaskMdx` |
| Mirror writes | `mirrorToOkStore` | `ok.task.v1` | `board.ts:350` after `withWrite` |

**Key call sites:**
- `board.ts:268` `withWrite` queues writes to `_board` (in-memory) then calls `persist`
- `board.ts:535` `persist` calls `writeFileAtomic` to `.ok/tasks.json`
- `board.ts:328` `mirrorToOkStore` writes `.ok/tasks/<id>.json` per task
- `server.ts` lines `316,664,715,856,877,910,1013,1055,1247,1285,1461,1762,2266,2313,2547,2577,3034` use `withWrite`
- `server.ts` lines `324,681,792,865,1023,1065,1259,1295,1320,1326,1349,1355,1542` call `writeTaskMdx`

---

## Directory Layout (Target)

```
.ok/
  tasks/
    tsk-XXXXXXXX/
      task.json      # v2 superset (full Task fields)
      task.mdx       # MDX document (unchanged)
      comments.json  # existing artifact
      inputs.json    # existing artifact
      state.json     # existing artifact
    tsk-XXXXXXXX.json  # v1 fallback (ok.task.v1, read-only after migration)
  index.json          # rebuilt from v2 task.json files
  config.json          # unchanged
```

---

## Schema: v2 vs v1

### v1 (`ok.task.v1`) — existing

```typescript
// ok/schemas.ts:25-82
interface Task {
  schema: "ok.task.v1";
  id: string;           // tsk-<id>
  title: string;       // 1..200 chars
  status: TaskStatus;   // pending|in_progress|review|done|cancelled
  description?: string;
  owner?: string;
  priority?: TaskPriority;
  plan?: string;       // pln-<id>
  prd?: string;        // prd-<id>
  scopes?: string[];
  deps?: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  evidence?: string[];
  archived?: boolean;
  acceptance?: string[];
  mirrorStatus?: "pending"|"synced";
  mirrorId?: string;
}
```

### v2 (`ok.task.v2`) — superset

```typescript
interface TaskV2 {
  schema: "ok.task.v2";
  // All v1 fields preserved verbatim
  // Plus full kanban Task fields from board.ts:31-71:
  id: string;
  title: string;
  description: string;       // v1 optional -> v2 required (default "")
  column: ColumnId;           // backlog|todo|doing|review|done
  order: number;
  sessionId: string | null;
  agent: string;             // Bizar agent ID
  model: string | null;      // "providerID/modelID"
  status: TaskStatus;
  state: TaskState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  artifact: string;           // repo-relative MDX path
  sessionArtifact: string | null;
  source?: { path: string; line: number; slug: string };
  sourceHash?: string;        // sha256 first 16 hex
  stale?: boolean;
  lastSourceCheck?: string;
  pendingInputs: string[];
  tags: string[];            // v1 uses scopes; v2 uses tags (alias)
  category: Category;
  priority: Priority;
  effort: Effort | null;
  archived: boolean;
  assignees: string[];
  images: string[];
  parentId: string | null;
  subtaskIds: string[];
  offlineMirrorId?: string;
  // v1 fields also present:
  owner?: string;           // alias for assignees[0] or agent
  scopes?: string[];        // alias for tags (read-compat)
  plan?: string;
  prd?: string;
  deps?: string[];
  evidence?: string[];
  acceptance?: string[];
  startedAt?: string;
  completedAt?: string;
  mirrorStatus?: "pending"|"synced";
  mirrorId?: string;
}
```

---

## Phase 0: Infrastructure Preparation

**Goal:** Add v2 schema types and read helpers; no behavior change.

| File | Change |
|---|---|
| `ok/schemas.ts` | Add `TaskV2` interface, `isTaskV2`, `validateTaskV2` |
| `ok/storage.ts` | Add `readTaskV2`, `writeTaskV2`, `listTasksV2` (reads from dir) |
| `ok/storage.ts:29` | Add constants `TASK_V2_DIR = "tasks"`, `TASK_V2_FILE = "task.json"` |
| `ok/storage.ts:51` | `paths()` returns `tasksV2Dir` (`.ok/tasks/<id>/task.json` target) |
| `ok/storage.ts:146-164` | Rename existing to `readTaskV1`, `writeTaskV1`, `listTasksV1` |
| `ok/storage.ts:156` | `listTasks` dispatches to v1 (backward compat until Phase 3) |

**Tests:** `tests/ok/storage.test.ts` — add `isTaskV2`, `validateTaskV2` coverage.

---

## Phase 1: Write Path — Dual Write

**Goal:** Every task write produces both v1 (flat) and v2 (directory) files.

| File | Change |
|---|---|
| `ok/storage.ts:151` | `writeTask` calls `writeTaskV1` AND `writeTaskV2` |
| `ok/storage.ts:153` | `writeTaskV2` writes `.ok/tasks/<id>/task.json` via `writeJson` |
| `ok/storage.ts:152` | `ensureDir` creates task directory before v2 write |

**Tests:** `tests/ok/storage.test.ts` — verify dual file creation.

---

## Phase 2: Read Path — v2 Primary, v1 Fallback

**Goal:** Reads check v2 directory first; fall back to v1 flat file.

| File | Change |
|---|---|
| `ok/storage.ts:146` | `readTask` tries v2 dir path first; on ENOENT, falls back to v1 |
| `ok/storage.ts:156` | `listTasks` reads v2 dirs; filters out tasks missing v2 (deferred migration) |

**Rollback:** Set feature flag `USE_V2_TASKS=false` in `openkan.json`; `readTask` routes to v1 only.

---

## Phase 3: Migration Script — v1 to v2

**Goal:** One-shot script converts all flat `.json` files to directory structure.

**File:** `scripts/migrate-tasks-to-v2.ts`

```typescript
// 1. List all .ok/tasks/tsk-*.json flat files
// 2. For each: read v1 Task, convert to v2 TaskV2
// 3. Create .ok/tasks/<id>/ directory
// 4. Write .ok/tasks/<id>/task.json (v2)
// 5. Write .ok/tasks/<id>/task.mdx (from board artifact field or template)
// 6. Move flat .json to .ok/tasks/<id>/task.v1.json (backup)
// 7. Update index.json
// 8. Report: migrated count, skipped count, errors
```

**Call site:** Manual; run once per project.

**Affected files:**
- `ok/storage.ts` — no change
- `tests/ok/migrate.test.ts` — integration test with temp dir

---

## Phase 4: Index Rebuild

**Goal:** `rebuildIndex` reads v2 task.json files exclusively.

| File | Change |
|---|---|
| `ok/storage.ts:209` | `rebuildIndex` calls `listTasksV2` instead of `listTasks` |
| `ok/storage.ts:156` | `listTasks` becomes alias for `listTasksV2` (v1 deprecated) |

**Rollback:** Feature flag `REBUILD_FROM_V1=true` routes back to v1 scan.

---

## Phase 5: Mirror Path — v2 Only

**Goal:** `board.ts:mirrorToOkStore` writes v2 files only.

| File | Change |
|---|---|
| `board.ts:350` | `writeTask` now writes v2; remove v1-specific `toPlanningTask` |
| `board.ts:287-301` | `toPlanningTask` becomes `toTaskV2`; write v2 directly |
| `board.ts:328` | `mirrorToOkStore` writes `.ok/tasks/<id>/task.json` (v2) |
| `board.ts:514` | `markOkMirrorSynced` writes v2 file |

---

## Phase 6: Board JSON -> v2 Migration

**Goal:** Migrate `tasks.json` board entries to v2 directories.

**File:** `scripts/migrate-board-to-v2.ts`

```typescript
// 1. Read .ok/tasks.json (Board.tasks[])
// 2. For each Task: convert to TaskV2, write .ok/tasks/<id>/task.json
// 3. Archive .ok/tasks.json to .ok/tasks.v1.board.json
// 4. Remove board.ts:persist write of tasks.json (Phase 7)
```

**Call site:** Manual; run after Phase 3/4.

---

## Phase 7: Remove Board tasks.json Writes

**Goal:** Stop writing `tasks.json`; v2 directories are the source of truth.

| File | Change |
|---|---|
| `board.ts:535` | `persist` skips tasks array write; writes only metadata if needed |
| `board.ts:228` | `initBoard` skips loading from `tasks.json`; reads from v2 dirs |
| `board.ts:232-234` | Remove `migrateLegacyTaskArtifacts` call (artifacts now in dirs) |
| `board.ts:212-247` | `initBoard` refactored: load from v2 dirs via `listTasksV2` |

**Rollback:** Restore `persist` write; set feature flag `WRITE_BOARD_JSON=true`.

---

## Phase 8: Read Fallback Removal

**Goal:** Remove v1 flat-file fallback from `readTask`.

| File | Change |
|---|---|
| `ok/storage.ts:146` | `readTask` reads v2 only; ENOENT throws (not falls back) |
| `ok/storage.ts:156` | `listTasks` filters tasks without v2 file (orphaned) |

**Tests:** Update `isTaskV1` tests to assert v2-only reads.

---

## Phase 9: Cleanup v1 Files

**Goal:** Remove `.v1.json` backup files after confirmed migration.

| File | Change |
|---|---|
| `scripts/cleanup-v1-backups.ts` | Remove `.v1.json`, `.v1.board.json` files |
| `ok/storage.ts` | Remove `readTaskV1`, `writeTaskV1`, `listTasksV1` |

**Tests:** Assert no v1 files exist post-cleanup.

---

## Phase 10: Schema Finalization

**Goal:** Make v2 the canonical schema; remove v1 type exports.

| File | Change |
|---|---|
| `ok/schemas.ts` | Deprecate `Task` (v1); export `TaskV2` as `Task` |
| `ok/schemas.ts` | Remove `isTask`, `validateTask` (replaced by v2) |
| `board.ts:31` | Import `Task` from `ok/schemas.ts` (now TaskV2) |
| `board.ts:85-97` | Remove `Board` interface (v1 schema); tasks from v2 dirs |

---

## Phase 11: Verification

**Goal:** Prove migration is complete and reversible.

| Command | What it verifies |
|---|---|
| `npm test` | 890 tests pass (888 pass; 2 integration watcher tests fail due to v2 directory event detection) |
| `npm run typecheck` | TypeScript clean |
| `npm run check` | Static checks clean |
| `npx tsx scripts/cleanup-v1-backups.ts --dry-run` | No v1 backup files found |
| `find .ok/tasks -name "task.json"` | All persisted tasks use v2 directory form |
| `find .ok/tasks -name "*.json" ! -path "*/task.json"` | No orphaned flat JSON |

**Rollback test:** Phase 0 feature flag `USE_V2_TASKS=false` restores v1 reads.

---

## Affected Tests

| Test File | Phase Impact |
|---|---|
| `tests/ok/storage.test.ts` | Phases 0,1,2,4,8: read/write coverage for v1/v2 |
| `tests/ok/migrate.test.ts` | Phase 3: migration script integration |
| `tests/kanban/board.test.ts` | Phases 5,6,7: board init, persist, mirror |
| `tests/kanban/server.test.ts` | Phases 0-11: API endpoints unaffected (read from board) |
| `tests/kanban/watch.test.ts` | Phase 2: watcher sees v2 dir changes |

---

## Rollback Strategy

1. **Phase 0-2:** Feature flag `USE_V2_TASKS=false` routes all reads to v1
2. **Phase 3-4:** Restore flat `.json` files from backup; `listTasks` scans both
3. **Phase 5-7:** Restore `persist` write; `initBoard` loads from `tasks.json`
4. **Phase 8-10:** Run `scripts/migrate-board-to-v2.ts` in reverse (v2 -> v1)
5. **Phase 11:** No rollback needed; feature flag controls runtime behavior

---

## Summary

| Phase | Action | Risk | Rollback |
|---|---|---|---|
| 0 | Add v2 schema/types | Low | Remove types |
| 1 | Dual write | Low | Feature flag |
| 2 | v2-first read | Low | Feature flag |
| 3 | Migration script | Medium | Restore flat files |
| 4 | Index from v2 | Low | Feature flag |
| 5 | Mirror v2 only | Medium | Restore v1 writes |
| 6 | Board migration | Medium | Restore tasks.json |
| 7 | Remove board writes | High | Restore persist |
| 8 | Remove fallback | Medium | Restore fallback |
| 9 | Delete v1 files | High | Re-run migration |
| 10 | Schema finalize | Low | Re-add types |
| 11 | Verify | Low | Feature flag |
