// ok/storage.ts — async JSON storage for every planning entity.
//
// Storage rules:
// - One file per entity (e.g. `.ok/tasks/tsk-Vn4kRp2x.json`).
// - Writes are atomic via `.tmp` + `rename` (same pattern as kanban/io.ts).
// - Reads tolerate concurrent overwrites but never silently mutate.
// - Unknown files in directories are ignored — agents may add helpers.
//
// Every entity has a JSON envelope `{schema, ...payload}`; the `schema`
// discriminator is the only addressable identity in tests.

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  type Task,
  type TaskV2,
  type Plan,
  type Prd,
  type OkConfig,
  type OkIndex,
  isTask,
  isTaskV2,
  isPlan,
  isPrd,
  isOkConfig,
  isOkIndex,
  convertTaskV1ToV2,
  convertTaskV2ToV1,
  type IndexEntry,
} from "./schemas.ts";
import { nowIso } from "./ids.ts";

export const OK_DIR = ".ok";
export const CONFIG_FILE = "config.json";
export const INDEX_FILE = "index.json";
export const TASKS_DIR = "tasks";
export const PLANS_DIR = "plans";
export const PRDS_DIR = "prds";
export const SESSIONS_DIR = "sessions";
export const LOCKS_DIR = "locks";

export interface OkPaths {
  root: string;            // absolute path to the .ok/ folder
  configFile: string;
  indexFile: string;
  tasksDir: string;
  plansDir: string;
  prdsDir: string;
  sessionsDir: string;
  locksDir: string;
}

/** Resolve all well-known paths under `<root>/.ok/`. */
export function paths(root: string): OkPaths {
  const okRoot = path.join(root, OK_DIR);
  return {
    root: okRoot,
    configFile: path.join(okRoot, CONFIG_FILE),
    indexFile: path.join(okRoot, INDEX_FILE),
    tasksDir: path.join(okRoot, TASKS_DIR),
    plansDir: path.join(okRoot, PLANS_DIR),
    prdsDir: path.join(okRoot, PRDS_DIR),
    sessionsDir: path.join(okRoot, SESSIONS_DIR),
    locksDir: path.join(okRoot, LOCKS_DIR),
  };
}

/** Read the JSON at `p` and narrow it; throws if missing or malformed. */
export async function readJson<T>(p: string, narrow: (v: unknown) => v is T): Promise<T> {
  const raw = await fs.readFile(p, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`invalid JSON in ${p}: ${e.message}`);
  }
  if (!narrow(parsed)) {
    throw new Error(
      `invalid shape in ${p} (failed schema check). ` +
      `If this file was created by a bug or external tool, you can remove it with: rm "${p}"`,
    );
  }
  return parsed;
}

/** Best-effort reader; returns `undefined` instead of throwing on missing files. */
export async function readJsonOptional<T>(p: string, narrow: (v: unknown) => v is T): Promise<T | undefined> {
  try {
    return await readJson(p, narrow);
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

/** Atomic JSON write (tmp + rename). */
export async function writeJson(p: string, body: unknown): Promise<void> {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  const data = JSON.stringify(body, null, 2);
  let fh: import("node:fs").promises.FileHandle | undefined;
  try {
    fh = await fs.open(tmp, "w");
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    if (fh) await fh.close();
  }
  await fs.rename(tmp, p);
}

export async function ensureDirs(p: OkPaths): Promise<void> {
  for (const dir of [p.root, p.tasksDir, p.plansDir, p.prdsDir, p.sessionsDir, p.locksDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// ─── Typed getters/setters ──────────────────────────────────────────────────

export async function readConfig(p: OkPaths): Promise<OkConfig | undefined> {
  return readJsonOptional(p.configFile, isOkConfig);
}

export async function writeConfig(p: OkPaths, cfg: OkConfig): Promise<void> {
  await ensureDirs(p);
  await writeJson(p.configFile, cfg);
}

export async function readIndex(p: OkPaths): Promise<OkIndex | undefined> {
  return readJsonOptional(p.indexFile, isOkIndex);
}

export async function writeIndex(p: OkPaths, idx: OkIndex): Promise<void> {
  await writeJson(p.indexFile, idx);
}

export async function listDir(p: string, prefix: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(p);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".json"))
    .sort();
}

/**
 * Read a task. Phase 2 makes this v2-primary: try the directory form
 * (`.ok/tasks/<id>/task.json`) first, fall back to the legacy flat file
 * (`.ok/tasks/<id>.json`) when v2 is missing. The legacy read is
 * converted to v2 form via `convertTaskV1ToV2` so callers receive a
 * uniform `TaskV2` regardless of which form was on disk.
 */
export async function readTask(p: OkPaths, id: string): Promise<TaskV2 | undefined> {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid task id: ${id}`);
  // Phase 2: v2-primary read.
  const v2 = await readTaskV2(p, id);
  if (v2) return v2;
  // Fall back to legacy v1 flat file. Best-effort: malformed JSON throws.
  const v1 = await readJsonOptional(path.join(p.tasksDir, `${id}.json`), isTask);
  return v1 ? convertTaskV1ToV2(v1) : undefined;
}

/**
 * Write a task as both v1 (flat file) and v2 (directory form). Phase 1
 * dual-write: every mutation produces both shapes so legacy readers
 * continue to find the task while v2-aware callers see the canonical
 * directory form. The v1 form is a projection via `convertTaskV2ToV1`
 * and may be lossy for callers passing a v2 with fields that have no
 * v1 equivalent (column, order, assignees, etc.). Accepts either v1
 * `Task` or v2 `TaskV2`; v1 input is promoted to v2 via
 * `convertTaskV1ToV2` before dual-write.
 */
export async function writeTask(p: OkPaths, task: Task | TaskV2): Promise<void> {
  const v2: TaskV2 = isTaskV2(task) ? task : convertTaskV1ToV2(task);
  const v1: Task = convertTaskV2ToV1(v2);
  // Write the directory form first — this is the Phase 5+ canonical
  // shape. v2 failures propagate.
  await writeTaskV2(p, v2);
  // Then mirror to the legacy flat file. Phase 1 dual-write: best-effort
  // so a transient v1 filesystem error does not roll back the v2 write.
  try {
    await fs.mkdir(p.tasksDir, { recursive: true });
    await writeJson(path.join(p.tasksDir, `${v1.id}.json`), v1);
  } catch {
    // v1 fallback is advisory; v2 directory is canonical.
  }
}

/**
 * List every task in `.ok/tasks/`. Phase 2 merges both the directory
 * form and the legacy flat file, de-duplicating by id (v2 wins on
 * collision since it is the canonical form). All entries are returned
 * as `TaskV2`.
 */
export async function listTasks(p: OkPaths): Promise<TaskV2[]> {
  const byId = new Map<string, TaskV2>();
  // Phase 2: read directory form first.
  for (const v of await listTasksV2(p)) byId.set(v.id, v);
  // Fall back to legacy v1 flat files for any id that has no directory form.
  let names: string[];
  try {
    names = await fs.readdir(p.tasksDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [...byId.values()];
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!/^tsk-[A-Za-z0-9_-]+$/.test(id)) continue;
    if (byId.has(id)) continue;
    const v1 = await readJsonOptional(path.join(p.tasksDir, name), isTask);
    if (v1) byId.set(id, convertTaskV1ToV2(v1));
  }
  return [...byId.values()];
}

/**
 * Compute the v2 storage path for a task id: `<tasksDir>/<id>/task.json`.
 * Used by both `readTaskV2`/`writeTaskV2` and the migration that
 * promotes legacy flat files into per-task directories.
 */
export function taskV2File(p: OkPaths, id: string): string {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid task id: ${id}`);
  return path.join(p.tasksDir, id, "task.json");
}

export async function readTaskV2(p: OkPaths, id: string): Promise<TaskV2 | undefined> {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid task id: ${id}`);
  return readJsonOptional(taskV2File(p, id), isTaskV2);
}

export async function writeTaskV2(p: OkPaths, task: TaskV2): Promise<void> {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(task.id)) throw new Error(`invalid task id: ${task.id}`);
  const dir = path.join(p.tasksDir, task.id);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "task.json"), task);
}

export async function listTasksV2(p: OkPaths): Promise<TaskV2[]> {
  const out: TaskV2[] = [];
  let names: string[];
  try {
    names = await fs.readdir(p.tasksDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return out;
    throw e;
  }
  for (const name of names) {
    if (!/^tsk-[A-Za-z0-9_-]+$/.test(name)) continue;
    const file = path.join(p.tasksDir, name, "task.json");
    const v = await readJsonOptional(file, isTaskV2);
    if (v) out.push(v);
  }
  return out;
}

export async function readPlan(p: OkPaths, id: string): Promise<Plan | undefined> {
  if (!/^pln-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid plan id: ${id}`);
  return readJsonOptional(path.join(p.plansDir, `${id}.json`), isPlan);
}

export async function writePlan(p: OkPaths, plan: Plan): Promise<void> {
  await fs.mkdir(p.plansDir, { recursive: true });
  await writeJson(path.join(p.plansDir, `${plan.id}.json`), plan);
}

export async function listPlans(p: OkPaths): Promise<Plan[]> {
  const files = await listDir(p.plansDir, "pln");
  const out: Plan[] = [];
  for (const f of files) {
    const v = await readJsonOptional(path.join(p.plansDir, f), isPlan);
    if (v) out.push(v);
  }
  return out;
}

export async function readPrd(p: OkPaths, id: string): Promise<Prd | undefined> {
  if (!/^prd-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid prd id: ${id}`);
  return readJsonOptional(path.join(p.prdsDir, `${id}.json`), isPrd);
}

export async function writePrd(p: OkPaths, prd: Prd): Promise<void> {
  await fs.mkdir(p.prdsDir, { recursive: true });
  await writeJson(path.join(p.prdsDir, `${prd.id}.json`), prd);
}

export async function listPrds(p: OkPaths): Promise<Prd[]> {
  const files = await listDir(p.prdsDir, "prd");
  const out: Prd[] = [];
  for (const f of files) {
    const v = await readJsonOptional(path.join(p.prdsDir, f), isPrd);
    if (v) out.push(v);
  }
  return out;
}

// ─── Index builder ──────────────────────────────────────────────────────────

/** Rebuild `.ok/index.json` from the filesystem. */
export async function rebuildIndex(p: OkPaths): Promise<OkIndex> {
  const [tasks, plans, prds] = await Promise.all([listTasks(p), listPlans(p), listPrds(p)]);
  const toEntry = (e: { id: string; status: string; title: string; updatedAt: string }): IndexEntry => ({
    id: e.id,
    status: e.status,
    title: e.title,
    updatedAt: e.updatedAt,
  });
  const idx: OkIndex = {
    schema: "ok.index.v1",
    tasks: tasks
      .map(toEntry)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
    plans: plans
      .map(toEntry)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
    prds: prds
      .map(toEntry)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
    updatedAt: nowIso(),
  };
  await writeIndex(p, idx);
  return idx;
}

/** True when `.ok/config.json` is present at the project root. */
export function hasOkDir(root: string): boolean {
  return fsSync.existsSync(path.join(root, OK_DIR, CONFIG_FILE));
}

/**
 * Initialise `.ok/` in the project root if missing. Idempotent.
 * Returns the resolved paths either way.
 */
export async function initIfMissing(root: string): Promise<OkPaths> {
  const p = paths(root);
  await ensureDirs(p);
  if (!(await readConfig(p))) {
    const now = nowIso();
    const cfg: OkConfig = {
      schema: "ok.config.v1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await writeConfig(p, cfg);
  }
  if (!(await readIndex(p))) {
    await rebuildIndex(p);
  }
  return p;
}
