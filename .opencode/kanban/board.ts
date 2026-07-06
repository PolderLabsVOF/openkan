import { nanoid } from "nanoid";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ColumnId = "backlog" | "todo" | "doing" | "review" | "done";
export type TaskStatus = "idle" | "running" | "done" | "failed" | "cancelled";

export interface Column {
  id: ColumnId;
  title: string;
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
  status: TaskStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  artifact: string;       // repo-relative path to task MDX
  sessionArtifact: string | null;
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

export let KANBAN_DIR = "";      // set by initBoard
export const BOARD_FILE = "board.json";
export const BOARD_MDX  = "board.mdx";

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
  return [...tasks]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((t, i) => ({ ...t, order: i }));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initBoard(ctx: BoardContext): Promise<{ board: Board; dir: string }> {
  const dir = join(ctx.directory, ".openkan");
  KANBAN_DIR = dir;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const boardPath = join(dir, BOARD_FILE);
  if (existsSync(boardPath)) {
    const raw = readFileSync(boardPath, "utf-8");
    _board = JSON.parse(raw) as Board;
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
  const tmp = join(KANBAN_DIR, `${BOARD_FILE}.tmp`);
  const dest = join(KANBAN_DIR, BOARD_FILE);
  writeFileSync(tmp, JSON.stringify(board, null, 2), "utf-8");
  // Bun / Node 22+: try sync() for durability
  try { (require("fs") as any).sync?.(tmp); } catch (_) {}
  renameSync(tmp, dest);
}
