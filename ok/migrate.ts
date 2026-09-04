// ok/migrate.ts — one-shot import from a legacy `.ok/` workspace into the
// new `.ok/` schema. Idempotent: rerunning reports what was newly imported
// (i.e. what wasn't already in `.ok/`).
//
// Mapping:
//   .ok/tasks.json  -> .ok/tasks/<id>.json   (Task)
//   .ok/tasks/<id>/task.mdx  -> .ok/tasks/<id>.json  (description/body)
//   .ok/tasks/<id>/comments.json -> .ok/tasks/<id>.json#comments (inlined evidence)
//   .ok/board.json  -> index entries only (column/order state is folded
//                            into Task.status / acceptance).
//
// Status mapping:
//   board.json.state = "done"      -> ok Task.status = "done"
//   board.json.state = "running"   -> ok Task.status = "in_progress"
//   board.json.state = "waiting-for-input" -> ok Task.status = "in_progress"
//   board.json.state = "cancelled" -> ok Task.status = "cancelled"
//   board.json.state = "failed"    -> ok Task.status = "cancelled"
//   otherwise                     -> ok Task.status = "pending"   (and column != backlog/todo)

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type Task, type TaskStatus } from "./schemas.ts";
import { newId, nowIso } from "./ids.ts";
import {
  initIfMissing,
  readTask,
  writeTask,
} from "./storage.ts";
import type { OkPaths } from "./storage.ts";

interface LegacyTask {
  id: string;
  title?: string;
  column?: string;
  order?: number;
  state?: string;
  mdxPath?: string;
  agent?: string;
  model?: string | null;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  category?: string;
  priority?: string;
  effort?: string | null;
  archived?: boolean;
}

interface LegacyBoard {
  version?: number;
  columns?: unknown[];
  tasks?: LegacyTask[];
  sessions?: unknown[];
}

function mapStatus(t: LegacyTask): TaskStatus {
  const s = (t.state ?? "").toLowerCase();
  if (s === "done") return "done";
  if (s === "running" || s === "waiting-for-input") return "in_progress";
  if (s === "cancelled" || s === "failed") return "cancelled";
  // Use column to infer: review -> review; doing -> in_progress; everything
  // else (backlog, todo) stays pending.
  const col = (t.column ?? "").toLowerCase();
  if (col === "review") return "review";
  if (col === "doing") return "in_progress";
  return "pending";
}

function mapPriority(p: string | undefined): Task["priority"] | undefined {
  if (!p) return undefined;
  if (p === "urgent" || p === "high") return "p0";
  if (p === "normal") return "p2";
  if (p === "low") return "p3";
  return undefined;
}

function deriveNewId(legacy: LegacyTask): string {
  const original = (legacy.id ?? "").trim();
  // Old IDs are 8-char base-N strings (e.g. "bug3kx7p"). Reuse when well-formed
  // to keep URLs / log references stable.
  if (/^[A-Za-z0-9_-]{6,16}$/.test(original) && !original.startsWith("tsk-")) {
    return `tsk-${original}`;
  }
  if (/^tsk-[A-Za-z0-9_-]+$/.test(original)) return original;
  return newId("tsk");
}

async function importTaskFromJson(p: OkPaths, legacy: LegacyTask, openkanDir: string): Promise<{ id: string; created: boolean }> {
  const id = deriveNewId(legacy);
  const existing = await readTask(p, id);
  if (existing) return { id, created: false };
  const task: Task = {
    schema: "ok.task.v1",
    id,
    title: (legacy.title ?? "untitled").slice(0, 200),
    status: mapStatus(legacy),
    createdAt: legacy.createdAt ?? nowIso(),
    updatedAt: legacy.updatedAt ?? nowIso(),
  };
  if (legacy.agent) task.owner = legacy.agent;
  // Legacy Task type does not have `description`; pull from the .mdx body
  // if available so migrated tasks aren't blank. Resolve relative to the
  // openkanDir (not process.cwd) so the migration is portable.
  if (legacy.mdxPath) {
    const mdxAbs = path.isAbsolute(legacy.mdxPath)
      ? legacy.mdxPath
      : path.join(openkanDir, legacy.mdxPath);
    try {
      const raw = await fs.readFile(mdxAbs, "utf-8");
      const fmStripped = raw.replace(/^---[\s\S]*?---\n?/, "");
      if (fmStripped.trim().length > 0) task.description = fmStripped.trim();
    } catch { /* optional */ }
  }
  const p2 = mapPriority(legacy.priority);
  if (p2) task.priority = p2;
  if (Array.isArray(legacy.tags) && legacy.tags.length) task.scopes = legacy.tags;
  await writeTask(p, task);
  return { id, created: true };
}

export interface MigrateResult {
  fromOpenkan: string;
  imported: number;
  skipped: number;
  tasks: string[];
}

/**
 * Run the migration in `root`. Returns counts and the list of imported
 * task ids. If `.ok/` does not exist, returns zero-import result.
 */
export async function migrateFromOpenkan(root: string): Promise<MigrateResult> {
  const okPaths = await initIfMissing(root);
  // Source: the legacy `.openkan/` directory. Even after the project itself
  // migrated, this entry point is still useful for users that keep `.openkan/`
  // data alongside an old `.ok/` installation (e.g. on shared filesystems).
  const openkanDir = path.join(root, ".openkan");
  let tasksJsonRaw: string | undefined;
  try {
    tasksJsonRaw = await fs.readFile(path.join(openkanDir, "tasks.json"), "utf-8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  let boardJsonRaw: string | undefined;
  try {
    boardJsonRaw = await fs.readFile(path.join(openkanDir, "board.json"), "utf-8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }

  const imported: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const fromOpenkan = openkanDir;

  if (tasksJsonRaw) {
    const parsed = JSON.parse(tasksJsonRaw) as { tasks?: LegacyTask[] };
    for (const legacy of parsed.tasks ?? []) {
      const id = deriveNewId(legacy);
      if (seen.has(id)) continue;
      seen.add(id);
      const res = await importTaskFromJson(okPaths, legacy, openkanDir);
      if (res.created) imported.push(res.id); else skipped.push(res.id);
    }
  }
  if (boardJsonRaw) {
    const parsed = JSON.parse(boardJsonRaw) as LegacyBoard;
    for (const legacy of parsed.tasks ?? []) {
      if (legacy.archived) continue;
      const id = deriveNewId(legacy);
      if (seen.has(id)) continue;
      seen.add(id);
      const res = await importTaskFromJson(okPaths, legacy, openkanDir);
      if (res.created) imported.push(res.id); else skipped.push(res.id);
    }
  }

  return { fromOpenkan, imported: imported.length, skipped: skipped.length, tasks: imported };
}

/** Thin CLI wrapper used by `bin/ok.ts migrate-from-openkan`. */
export async function cmdMigrateFromOpenkan(argv: string[]): Promise<number> {
  const root = argv[0] ?? process.cwd();
  const res = await migrateFromOpenkan(root);
  process.stdout.write(`migrated ${res.imported} tasks from ${res.fromOpenkan} (skipped ${res.skipped} already in .ok/)\n`);
  if (argv.includes("--list")) {
    for (const id of res.tasks) process.stdout.write(`  ${id}\n`);
  }
  return 0;
}
