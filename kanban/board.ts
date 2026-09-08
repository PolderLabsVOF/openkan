import { nanoid } from "nanoid";
import { existsSync, readFileSync } from "fs";
import { promises as fsPromises } from "node:fs";
import { join } from "path";
import { writeFileAtomic, ensureDir, cleanupStaleTmp, removeDir } from "./io.ts";
import type { Priority, Effort, Category } from "./tags.ts";
import { writeTask, readTask as readOkTask, writeTaskV2, readConfig, writeConfig, paths as okPaths, rebuildIndex, listTasksV2 } from "../ok/storage.ts";
import { nowIso as okNowIso } from "../ok/ids.ts";
import type { TaskV2 } from "../ok/schemas.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ColumnId = "backlog" | "todo" | "doing" | "review" | "done";
export type TaskState = "idle" | "running" | "waiting-for-input" | "done" | "failed" | "cancelled";
/** Back-compat alias — existing serialized data uses status; prefer TaskState internally. */
export type TaskStatus = TaskState;

export interface Column {
  id: ColumnId;
  title: string;
}

/** Paths to task sub-artifacts, relative to .ok/. */
export interface TaskArtifacts {
  mdxPath: string;         // e.g. "tasks/tsk-xxx/task.mdx"
  commentsPath: string;    // e.g. "tasks/tsk-xxx/comments.json"
  inputsPath: string;      // e.g. "tasks/tsk-xxx/inputs.json"
  statePath: string;       // e.g. "tasks/tsk-xxx/state.json"
}

export interface Task {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
  order: number;
  sessionId: string | null;
  agent: string;          // Bizar agent ID; "" means resolve the project default
  model: string | null;   // "providerID/modelID" or null for default
  /** @deprecated Use state instead. Getter maintains back-compat. */
  status: TaskStatus;
  state: TaskState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  artifact: string;       // repo-relative path to task MDX (legacy compat)
  sessionArtifact: string | null;
  source?: { path: string; line: number; slug: string };
  sourceHash?: string;         // sha256 of source file at last import (first 16 hex chars)
  stale?: boolean;              // true when source file changed since import
  lastSourceCheck?: string;     // ISO timestamp of last hash check
  pendingInputs: string[]; // input IDs pending a response
  artifacts: TaskArtifacts;
  tags: string[];
  category: Category;
  priority: Priority;
  effort: Effort | null;
  archived: boolean;      // default false; archived tasks are hidden from the board
  assignees: string[];    // git user names assigned; defaults to currentUser on create
  images: string[];       // image file names; mirrors files on disk
  parentId: string | null;   // null for top-level tasks; task.id of the parent for subtasks
  subtaskIds: string[];      // derived; ids of immediate children. Maintained by the api.
  /**
   * Stable identity supplied by an offline client (e.g. `ok task add`'s
   * locally-minted tsk-id). When the server creates a task via POST with
   * `clientId`, it stores the same value here so retried writes from the
   * same offline client converge on the same row instead of duplicating.
   * The HTTP-side `id` is the canonical engine identifier.
   */
  offlineMirrorId?: string;
}

// ─── Task getter / setter helpers ─────────────────────────────────────────────

/** Return artifact paths for a task, under .ok/. */
export function taskArtifacts(taskId: string): TaskArtifacts {
  return {
    mdxPath: `tasks/${taskId}/task.mdx`,
    commentsPath: `tasks/${taskId}/comments.json`,
    inputsPath: `tasks/${taskId}/inputs.json`,
    statePath: `tasks/${taskId}/state.json`,
  };
}

export interface SessionRecord {
  taskId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface Board {
  version: 1;
  columns: Column[];
  tasks: Task[];
  sessions: Record<string, SessionRecord>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_COLUMNS: Column[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo",    title: "To Do" },
  { id: "doing",   title: "In Progress" },
  { id: "review",  title: "Review" },
  { id: "done",    title: "Done" },
];

export let KANBAN_DIR = "";      // set by initBoard or setKanbanDir
export const BOARD_FILE = "board.json";
export const BOARD_MDX  = "board.mdx";
export const TASKS_INDEX_FILE = "tasks.json";

// ─── Project root (set by the CLI/server before project operations) ─────────

let _projectRoot: string | null = null;
export function setProjectRoot(dir: string): void { _projectRoot = dir; }
export function getProjectRoot(): string {
  if (!_projectRoot) throw new Error("Project root not initialised — call setProjectRoot first");
  return _projectRoot;
}

/** Allow server.ts to override KANBAN_DIR when the active project changes at runtime. */
export function setKanbanDir(dir: string): void {
  KANBAN_DIR = dir;
}

// ─── Context & state ─────────────────────────────────────────────────────────

export interface BoardContext {
  directory: string;
  client: any;    // optional event/session adapter retained for compatible callers
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: any) => Promise<void>;
}

let _board: Board | null = null;
// `KANBAN_DIR` names the persistence directory, but a running server also
// needs to know which root populated its in-memory board. Keeping this
// separately prevents a project switch from merely changing output paths
// while continuing to serve the previous project's cached tasks.
let _loadedProjectRoot = "";
let _writeQueue: Promise<void> = Promise.resolve();

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function newId(prefix: string): string {
  return `${prefix}-${nanoid(8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function renormalizeOrder(tasks: Task[]): Task[] {
  // Active tasks get renumbered; archived tasks retain their last order so they
  // reappear in the right position when restored.
  const active = tasks.filter(t => !t.archived);
  const archived = tasks.filter(t => t.archived);
  const sortedActive = [...active]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((t, i) => ({ ...t, order: i }));
  return [...sortedActive, ...archived];
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/** One-time idempotent migration: flat tasks/<id>.mdx → tasks/<id>/task.mdx */
async function migrateLegacyTaskArtifacts(board: Board): Promise<void> {
  for (const task of board.tasks) {
    const flatMdxPath = join(KANBAN_DIR, "tasks", `${task.id}.mdx`);
    if (existsSync(flatMdxPath)) {
      const taskDir = join(KANBAN_DIR, "tasks", task.id);
      ensureDir(taskDir);
      const newMdxPath = join(taskDir, "task.mdx");
      // Read legacy file, write to new location
      const content = readFileSync(flatMdxPath, "utf-8");
      writeFileAtomic(newMdxPath, content);
      // Update task.artifact to new layout
      task.artifact = `tasks/${task.id}/task.mdx`;
      task.artifacts = taskArtifacts(task.id);
      try {
        // Remove old flat file
        const { unlinkSync } = await import("node:fs");
        unlinkSync(flatMdxPath);
      } catch {
        // ignore
      }
    } else if (!task.artifacts) {
      // Back-compat: ensure artifacts field exists for old tasks loaded from board.json
      task.artifacts = taskArtifacts(task.id);
    }
    // Ensure state field exists for old tasks
    if (!task.state) {
      task.state = (task as any).status ?? "idle";
    }
    if (!task.pendingInputs) {
      task.pendingInputs = [];
    }
    // New fields: apply defaults for legacy tasks
    if (!task.tags) task.tags = [];
    if (!task.category) task.category = "task";
    if (!task.priority) task.priority = "normal";
    if (task.effort === undefined) task.effort = null;
    if (task.archived === undefined) task.archived = false;
    if (!task.assignees) task.assignees = [];
    if (!task.images) task.images = [];
    if (task.parentId === undefined) task.parentId = null;
    if (!task.subtaskIds) task.subtaskIds = [];
  }
}

export async function initBoard(ctx: BoardContext): Promise<{ board: Board; dir: string }> {
  // Finish writes against the current board before replacing its cache. This
  // makes project activation an atomic boundary for callers sharing a server.
  await _writeQueue.catch(() => undefined);
  const dir = join(ctx.directory, ".ok");
  KANBAN_DIR = dir;

  ensureDir(dir);
  cleanupStaleTmp(dir);

  // Phase 7: board.json is metadata-only post-migration. If a legacy
  // board.json with an embedded `tasks` array is present (pre-Phase-6
  // projects), promote each entry to the v2 directory form, run the
  // legacy MDX migration, then drop the array so subsequent boots take
  // the metadata-only path. This keeps `initBoard` the single upgrade
  // boundary so projects don't need a separate `migrate-board-to-v2`
  // invocation before first boot.
  const boardPath = join(dir, BOARD_FILE);
  let metadata: { version: number; columns: Column[]; sessions: Record<string, SessionRecord> };
  const legacyBoard: Board | null = existsSync(boardPath)
    ? JSON.parse(readFileSync(boardPath, "utf-8")) as Board
    : null;
  const hasLegacyTasks = !!legacyBoard && Array.isArray(legacyBoard.tasks) && legacyBoard.tasks.length > 0;
  if (legacyBoard) {
    metadata = {
      version: legacyBoard.version ?? 1,
      columns: legacyBoard.columns ?? [...DEFAULT_COLUMNS],
      sessions: legacyBoard.sessions ?? {},
    };
  } else {
    metadata = {
      version: 1,
      columns: [...DEFAULT_COLUMNS],
      sessions: {},
    };
  }

  const okRoot = join(dir, "..");
  const okP = okPaths(okRoot);

  if (hasLegacyTasks) {
    // One-shot Phase 6 promotion: write each legacy task to v2 form
    // (idempotent — already-migrated ids are skipped via writeTaskV2
    // overwrite). Run MDX migration in-place so the in-memory task list
    // tracks the new artifact paths.
    await migrateLegacyTaskArtifacts(legacyBoard!);
    for (const task of legacyBoard!.tasks) {
      try {
        await writeTaskV2(okP, toTaskV2(task));
      } catch {
        // best-effort: a corrupt legacy entry shouldn't block the rest
      }
    }
  }

  // Phase 7: load tasks from .ok/tasks/<id>/task.json (v2 directory
  // form). This replaces the previous tasks.json-array read.
  const v2Tasks = await listTasksV2(okP);
  const tasks: Task[] = [];
  for (const v2 of v2Tasks) {
    const t = fromPlanningTask(v2);
    if (t) tasks.push(t);
  }

  _board = {
    version: metadata.version as 1,
    columns: metadata.columns,
    tasks,
    sessions: metadata.sessions,
  };
  // Mirror in-memory state to disk so the metadata-only board.json is
  // written even on a cold boot (and the v2 directory form is kept
  // current by mirrorToOkStore inside persist).
  await persist(_board);

  _loadedProjectRoot = ctx.directory;
  return { board: _board!, dir };
}

/**
 * Load the board for `ctx.directory` when the active project changed.
 * Unlike `setKanbanDir`, this refreshes the in-memory board as well as its
 * destination path, which is required for a long-lived multi-project server.
 */
export async function ensureBoardForProject(ctx: BoardContext): Promise<{ board: Board; dir: string }> {
  if (_board && _loadedProjectRoot === ctx.directory) {
    return { board: _board, dir: KANBAN_DIR };
  }
  return initBoard(ctx);
}

export async function getBoard(): Promise<Board> {
  if (!_board) throw new Error("Board not initialised — call initBoard first");
  return _board;
}

// ─── Write queue ─────────────────────────────────────────────────────────────

export async function withWrite<T>(fn: (board: Board) => Promise<T> | T): Promise<T> {
  const operation = _writeQueue.catch(() => undefined).then(async () => {
    if (!_board) throw new Error("Board not initialised");
    const result = await fn(_board);
    await persist(_board!);
    return result;
  });
  _writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

// ─── Persist ─────────────────────────────────────────────────────────────────

/**
 * Map an OpenKan engine `Task` onto the planning-system `ok.task.v2`
 * shape. Phase 5 of the unified-task-storage plan: the mirror writes
 * the v2 directory form directly so the planning-system store is
 * structurally aligned with the engine board (column, order, state,
 * agent, assignees, etc. all preserved without round-tripping through
 * the lossy v1 projection).
 */
export function toTaskV2(task: Task): TaskV2 {
  const status = mapColumnToStatus(task.column, task.state, task.archived);
  const now = okNowIso();
  return {
    schema: "ok.task.v2",
    id: task.id.startsWith("tsk-") ? task.id : `tsk-${task.id}`,
    title: task.title || "untitled",
    description: task.description ?? "",
    column: task.column,
    order: task.order ?? 0,
    sessionId: task.sessionId ?? null,
    agent: task.agent ?? "",
    model: task.model ?? null,
    status,
    state: task.state,
    lastError: task.lastError ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    artifact: task.artifact ?? "",
    sessionArtifact: task.sessionArtifact ?? null,
    artifacts: task.artifacts ?? { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" },
    source: task.source,
    sourceHash: task.sourceHash,
    stale: task.stale,
    lastSourceCheck: task.lastSourceCheck,
    pendingInputs: task.pendingInputs ?? [],
    tags: task.tags ?? [],
    category: task.category ?? "task",
    priority: task.priority ?? "normal",
    effort: task.effort ?? null,
    archived: task.archived ?? false,
    assignees: task.assignees ?? (task.agent ? [task.agent] : []),
    images: task.images ?? [],
    parentId: task.parentId ?? null,
    subtaskIds: task.subtaskIds ?? [],
    offlineMirrorId: task.offlineMirrorId,
    // v1 fields preserved for read-compat callers:
    owner: task.agent ?? undefined,
    scopes: task.tags && task.tags.length > 0 ? task.tags : undefined,
    plan: undefined,
    prd: undefined,
    deps: undefined,
    evidence: undefined,
    acceptance: undefined,
    startedAt: undefined,
    completedAt: undefined,
    mirrorStatus: undefined,
    mirrorId: undefined,
  };
}

function mapColumnToStatus(
  column: Task["column"],
  state: Task["state"],
  archived: boolean,
): TaskV2["status"] {
  if (archived) return "cancelled";
  if (state === "done") return "done";
  if (state === "cancelled" || state === "failed") return "cancelled";
  if (state === "running" || state === "waiting-for-input") return "in_progress";
  if (column === "review") return "review";
  if (column === "doing") return "in_progress";
  if (column === "done") return "done";
  return "pending";
}

let _okMirrorWritesDisabled = false;
/** Disable the side-effect per-task mirror writes (used by tests). */
export function setOkMirrorWritesDisabled(v: boolean): void { _okMirrorWritesDisabled = v; }

/**
 * Mirror the engine board into the planning-system store. Idempotent:
 * existing per-task JSONs are overwritten with the latest engine view.
 * `config.json` is created on first call so the planning system sees the
 * project as initialised.
 */
async function mirrorToOkStore(board: Board): Promise<void> {
  if (_okMirrorWritesDisabled) return;
  if (!KANBAN_DIR) return;
  // KANBAN_DIR = <root>/.ok/. The planning layout is exactly that.
  // We resolve the project root as the parent of KANBAN_DIR.
  const projectRoot = join(KANBAN_DIR, "..");
  const p = okPaths(projectRoot);
  ensureDir(p.tasksDir);
  ensureDir(p.plansDir);
  ensureDir(p.prdsDir);
  ensureDir(p.sessionsDir);
  ensureDir(p.locksDir);
  // Ensure config.json exists
  if (!existsSync(p.configFile)) {
    const now = okNowIso();
    await writeConfig(p, { schema: "ok.config.v1", version: 1, createdAt: now, updatedAt: now });
  }
  // Write one v2 task per card, plus idempotent tasks.json index. Phase 5:
  // the mirror writes the v2 directory form directly. The legacy v1 flat
  // file is no longer maintained from this path; legacy readers continue
  // to work via readTask's v2-primary → v1-fallback chain.
  const seen = new Set<string>();
  const indexEntries: { id: string; status: string; title: string; updatedAt: string }[] = [];
  for (const t of board.tasks) {
    const v2 = toTaskV2(t);
    await writeTaskV2(p, v2);
    seen.add(v2.id);
    indexEntries.push({ id: v2.id, status: v2.status, title: v2.title, updatedAt: v2.updatedAt });
  }
  // Best-effort index rebuild (non-fatal if it fails).
  try { await rebuildIndex(p); } catch { /* swallow */ }
}

/**
 * Map a planning-system `ok.task.v2` entry onto the engine Task schema.
 * Phase 5: the planning-system store is the v2 directory form now, so
 * the projection reads v2 fields directly (column, order, state,
 * agent, assignees, tags, priority, archived, artifact, etc.). Most
 * v2 fields map 1:1 onto the engine Task — the only synthesised
 * defaults are the ones a v2 record might leave null when the
 * offline write arrived without a full kanban view.
 */
export function fromPlanningTask(ok: TaskV2): Task | null {
  if (!ok.id || !/^tsk-[A-Za-z0-9_-]+$/.test(ok.id)) return null;
  const arts = ok.artifacts ?? taskArtifacts(ok.id);
  return {
    id: ok.id,
    title: ok.title || "untitled",
    description: ok.description ?? "",
    column: ok.column,
    order: ok.order ?? 0,
    sessionId: ok.sessionId ?? null,
    agent: ok.agent ?? ok.owner ?? "",
    model: ok.model ?? null,
    status: ok.state,
    state: ok.state,
    lastError: ok.lastError ?? null,
    createdAt: ok.createdAt,
    updatedAt: ok.updatedAt,
    artifact: ok.artifact || arts.mdxPath,
    sessionArtifact: ok.sessionArtifact ?? null,
    artifacts: arts,
    source: ok.source,
    sourceHash: ok.sourceHash,
    stale: ok.stale,
    lastSourceCheck: ok.lastSourceCheck,
    pendingInputs: ok.pendingInputs ?? [],
    tags: ok.tags ?? ok.scopes ?? [],
    category: ok.category ?? "task",
    priority: ok.priority ?? "normal",
    effort: ok.effort ?? null,
    archived: ok.archived === true || ok.state === "cancelled" || ok.state === "failed",
    assignees: ok.assignees ?? (ok.agent ? [ok.agent] : ok.owner ? [ok.owner] : []),
    images: ok.images ?? [],
    parentId: ok.parentId ?? null,
    subtaskIds: ok.subtaskIds ?? [],
    // The planning-system task id is the offline mirror; setting it on
    // the planning→board path closes a race where the file watcher
    // creates the board row before the HTTP POST lands, so a later
    // dedupe-by-clientId finds a row without offlineMirrorId and returns
    // it without the marker. With this, both creation paths produce
    // equivalent rows and `ok task add`'s post-write contract (id
    // visible on the board, mirror marked synced) holds in either order.
    offlineMirrorId: ok.offlineMirrorId ?? ok.id,
  };
}

/**
 * Reconcile a single `.ok/tasks/<id>.json` entry into the engine board.
 * Called by the SSE watcher when an agent (e.g. via `ok task add`) writes
 * a planning task while a dashboard server is running. No-op when the
 * board already has the task (subsequent edits flow through the existing
 * HTTP PATCH path); returns the inserted task for broadcasting.
 *
 * The function intentionally mirrors the `apiCreateTask` shape so the
 * dashboard's broadcast and write-quote semantics stay consistent.
 *
 * Idempotency: when the offline file carries `mirrorStatus: "synced"`,
 * the entry is treated as already-on-board and skipped (returns null).
 * When a board task already exists with `offlineMirrorId === ok.id`,
 * the entry is considered the same row — the offline file is flipped
 * to `"synced"` so subsequent sweeps stay no-op.
 */
export async function reconcileOkTask(taskId: string, kanbanDir: string = KANBAN_DIR): Promise<Task | null> {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(taskId)) return null;
  if (!kanbanDir) return null;
  const projectRoot = join(kanbanDir, "..");
  const p = okPaths(projectRoot);
  const ok = await readOkTask(p, taskId);
  if (!ok) return null;
  // Already-synced entries are no-ops so the boot sweep doesn't
  // re-insert every task on every server start.
  if (ok.mirrorStatus === "synced") return null;
  // Match-by-offlineMirrorId: a board row that already carries our id
  // is the canonical home for this offline task. Flip the marker so
  // subsequent sweeps stay no-op, and return the row for the broadcast.
  if (_board) {
    const byMirror = _board.tasks.find(t => t.offlineMirrorId === ok.id);
    if (byMirror) {
      await markOkMirrorSynced(p, ok.id, byMirror.id);
      return byMirror;
    }
  }
  // Skip if the board already has the same id — the HTTP path owns updates.
  if (_board && _board.tasks.some(t => t.id === ok.id)) {
    await markOkMirrorSynced(p, ok.id, ok.id);
    return null;
  }
  const task = fromPlanningTask(ok);
  if (!task) return null;
  let inserted: Task | undefined;
  await withWrite(async (board) => {
    // Re-check after queueing; another reconcile could have won.
    const byMirror = board.tasks.find(t => t.offlineMirrorId === task.id);
    if (byMirror) {
      inserted = byMirror;
      return;
    }
    if (board.tasks.some(t => t.id === task.id)) {
      inserted = board.tasks.find(t => t.id === task.id);
      return;
    }
    const colTasks = board.tasks.filter(t => t.column === task.column);
    task.order = colTasks.length;
    board.tasks.push(task);
    inserted = task;
  });
  if (inserted) {
    await markOkMirrorSynced(p, ok.id, inserted.id);
  }
  return inserted ?? null;
}

/**
 * Sweep every `.ok/tasks/<id>.json` entry on the filesystem and
 * reconcile pending ones. Idempotent: already-synced entries are
 * skipped, and the per-task reconcileOkTask is itself a no-op once a
 * board row with matching offlineMirrorId exists. Intended for the
 * boot path so entries written while the server was down still land
 * on the board when the server comes back up.
 */
export async function reconcileAllOkTasks(kanbanDir: string = KANBAN_DIR): Promise<number> {
  if (!kanbanDir) return 0;
  const projectRoot = join(kanbanDir, "..");
  const p = okPaths(projectRoot);
  let count = 0;
  try {
    const files = await fsPromises.readdir(p.tasksDir);
    // Phase 8+: Check both v1 flat files (<id>.json) and v2 directories (<id>/task.json)
    for (const file of files) {
      // Check v2 directory first (<id>/task.json)
      const v2Dir = join(p.tasksDir, file, "task.json");
      try {
        const stat = await fsPromises.stat(v2Dir);
        if (stat.isFile()) {
          const id = file; // directory name is the task id
          const inserted = await reconcileOkTask(id, kanbanDir);
          if (inserted) count += 1;
          continue;
        }
      } catch { /* no v2 directory, check v1 flat file */ }

      // Fallback to v1 flat file (<id>.json) for legacy tasks
      const m = file.match(/^(tsk-[A-Za-z0-9_-]+)\.json$/);
      if (!m) continue;
      const inserted = await reconcileOkTask(m[1], kanbanDir);
      if (inserted) count += 1;
    }
  } catch { /* tasksDir missing is fine — no pending entries */ }
  return count;
}

/**
 * Flip an ok-store task file from `mirrorStatus: "pending"` to
 * `"synced"`, recording the server-side id under `mirrorId`. Quietly
 * swallows write errors — losing the marker only means the next sweep
 * re-tries, which is safe under the idempotency contract above.
 * Phase 8+: reads and writes v2 directory form first, falls back to v1.
 */
async function markOkMirrorSynced(p: ReturnType<typeof okPaths>, okId: string, serverId: string): Promise<void> {
  // Phase 8+: Try v2 directory first, then fall back to v1 flat file
  const v2File = join(p.tasksDir, okId, "task.json");
  let raw: string;
  let isV2 = false;

  // Try v2 first
  try {
    raw = await fsPromises.readFile(v2File, "utf-8");
    isV2 = true;
  } catch {
    // Fall back to v1 flat file
    const file = join(p.tasksDir, `${okId}.json`);
    try {
      raw = await fsPromises.readFile(file, "utf-8");
    } catch { return; }
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || typeof parsed !== "object") return;
  const rec = parsed as Record<string, unknown>;
  if (rec.mirrorStatus === "synced" && rec.mirrorId === serverId) return;
  rec.mirrorStatus = "synced";
  rec.mirrorId = serverId;
  rec.updatedAt = okNowIso();

  // Write back to the same location we read from
  const targetFile = isV2 ? v2File : join(p.tasksDir, `${okId}.json`);
  try {
    const tmp = `${targetFile}.tmp-${process.pid}-${Date.now()}`;
    await fsPromises.writeFile(tmp, JSON.stringify(rec, null, 2));
    await fsPromises.rename(tmp, targetFile);
  } catch { /* swallow — best effort */ }
}

export async function persist(board: Board): Promise<void> {
  if (!KANBAN_DIR) return;
  const dest = join(KANBAN_DIR, BOARD_FILE);
  // Phase 7: the persisted board.json is metadata-only. Tasks are
  // reconstructed from the v2 directory form on boot (initBoard reads
  // them via listTasksV2), so writing the in-memory tasks array here
  // would re-introduce the dual-store staleness the refactor is
  // designed to eliminate. Columns, sessions, and version are still
  // authoritative in board.json.
  const metadataOnly = {
    version: board.version,
    columns: board.columns,
    sessions: board.sessions,
  };
  writeFileAtomic(dest, JSON.stringify(metadataOnly, null, 2));
  // Mirror into the planning-system store. Side effect only; failure does
  // not abort the engine write. Phase 5 already routes this to v2
  // (writeTaskV2), so the directory form stays current.
  try { await mirrorToOkStore(board); } catch { /* swallow */ }
}
