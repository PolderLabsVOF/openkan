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
  type Plan,
  type Prd,
  type OkConfig,
  type OkIndex,
  isTask,
  isPlan,
  isPrd,
  isOkConfig,
  isOkIndex,
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
    throw new Error(`invalid shape in ${p} (failed schema check)`);
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

export async function readTask(p: OkPaths, id: string): Promise<Task | undefined> {
  if (!/^tsk-[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid task id: ${id}`);
  return readJsonOptional(path.join(p.tasksDir, `${id}.json`), isTask);
}

export async function writeTask(p: OkPaths, task: Task): Promise<void> {
  await fs.mkdir(p.tasksDir, { recursive: true });
  await writeJson(path.join(p.tasksDir, `${task.id}.json`), task);
}

export async function listTasks(p: OkPaths): Promise<Task[]> {
  const files = await listDir(p.tasksDir, "tsk");
  const out: Task[] = [];
  for (const f of files) {
    const v = await readJsonOptional(path.join(p.tasksDir, f), isTask);
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
