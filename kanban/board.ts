import { nanoid } from "nanoid";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomic, ensureDir, cleanupStaleTmp, removeDir } from "./io.ts";
import type { Priority, Effort, Category } from "./tags.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ColumnId = "backlog" | "todo" | "doing" | "review" | "done";
export type TaskState = "idle" | "running" | "waiting-for-input" | "done" | "failed" | "cancelled";
/** Back-compat alias — existing serialized data uses status; prefer TaskState internally. */
export type TaskStatus = TaskState;

export interface Column {
  id: ColumnId;
  title: string;
}

/** Paths to task sub-artifacts, relative to .openkan/. */
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
  agent: string;          // opencode agent name; "" means default
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
}

// ─── Task getter / setter helpers ─────────────────────────────────────────────

/** Return artifact paths for a task, under .openkan/. */
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

// ─── Project root (set by plugins/kanban.ts on init; read by tools like kanban_import) ──

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
  client: any;    // opencode SDK client (already authenticated)
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: any) => Promise<void>;
}

let _board: Board | null = null;
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
  const dir = join(ctx.directory, ".openkan");
  KANBAN_DIR = dir;

  ensureDir(dir);
  cleanupStaleTmp(dir);

  // Write tasks.json from board.tasks if tasks.json doesn't exist (migration helper)
  const tasksIndexPath = join(dir, TASKS_INDEX_FILE);
  if (!existsSync(tasksIndexPath)) {
    // Will be written after board is loaded
  }

  const boardPath = join(dir, BOARD_FILE);
  if (existsSync(boardPath)) {
    const raw = readFileSync(boardPath, "utf-8");
    _board = JSON.parse(raw) as Board;
    // Apply migrations
    await migrateLegacyTaskArtifacts(_board);
    await persist(_board);
  } else {
    _board = {
      version: 1,
      columns: [...DEFAULT_COLUMNS],
      tasks: [],
      sessions: {},
    };
    await persist(_board!);
  }

  return { board: _board!, dir };
}

export async function getBoard(): Promise<Board> {
  if (!_board) throw new Error("Board not initialised — call initBoard first");
  return _board;
}

// ─── Write queue ─────────────────────────────────────────────────────────────

export async function withWrite<T>(fn: (board: Board) => Promise<T> | T): Promise<T> {
  _writeQueue = _writeQueue.then(async () => {
    if (!_board) throw new Error("Board not initialised");
    const result = await fn(_board);
    await persist(_board!);
    return result;
  });
  return _writeQueue;
}

// ─── Persist ─────────────────────────────────────────────────────────────────

export async function persist(board: Board): Promise<void> {
  if (!KANBAN_DIR) return;
  const dest = join(KANBAN_DIR, BOARD_FILE);
  writeFileAtomic(dest, JSON.stringify(board, null, 2));
}
