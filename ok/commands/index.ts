// ok/commands/index.ts — `ok index` and `ok doctor`.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  type Task, type Plan, type Prd,
  isTask, isPlan, isPrd,
  validateTask, validatePlan, validatePrd,
} from "../schemas.ts";
import {
  initIfMissing,
  rebuildIndex,
  paths as computePaths,
  listTasks, listPlans, listPrds,
} from "../storage.ts";
import type { OkPaths } from "../storage.ts";

async function paths(): Promise<OkPaths> {
  const p = computePaths(process.cwd());
  return initIfMissing(process.cwd());
}

export async function runIndex(): Promise<number> {
  const p = await paths();
  const idx = await rebuildIndex(p);
  process.stdout.write(
    `tasks: ${idx.tasks.length}, plans: ${idx.plans.length}, prds: ${idx.prds.length}\n`,
  );
  return 0;
}

interface DoctorIssue {
  id?: string;
  file: string;
  reason: string;
}

async function readMaybeJson(p: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    return { __parseError: e.message };
  }
}

export async function runDoctor(): Promise<number> {
  const p = await paths();
  const issues: DoctorIssue[] = [];

  for (const file of await fs.readdir(p.tasksDir).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(p.tasksDir, file);
    const v = await readMaybeJson(full);
    if (v === undefined) continue;
    if (v && typeof v === "object" && "__parseError" in (v as any)) {
      issues.push({ file, reason: `JSON parse error: ${(v as any).__parseError}` });
      continue;
    }
    if (!isTask(v)) {
      const err = validateTask(v) ?? { reason: "schema mismatch" };
      issues.push({ file, ...err });
    }
  }
  for (const file of await fs.readdir(p.plansDir).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(p.plansDir, file);
    const v = await readMaybeJson(full);
    if (v === undefined) continue;
    if (v && typeof v === "object" && "__parseError" in (v as any)) {
      issues.push({ file, reason: `JSON parse error: ${(v as any).__parseError}` });
      continue;
    }
    if (!isPlan(v)) {
      const err = validatePlan(v) ?? { reason: "schema mismatch" };
      issues.push({ file, ...err });
    }
  }
  for (const file of await fs.readdir(p.prdsDir).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(p.prdsDir, file);
    const v = await readMaybeJson(full);
    if (v === undefined) continue;
    if (v && typeof v === "object" && "__parseError" in (v as any)) {
      issues.push({ file, reason: `JSON parse error: ${(v as any).__parseError}` });
      continue;
    }
    if (!isPrd(v)) {
      const err = validatePrd(v) ?? { reason: "schema mismatch" };
      issues.push({ file, ...err });
    }
  }

  if (issues.length === 0) {
    process.stdout.write("ok doctor: 0 issues\n");
    return 0;
  }
  process.stdout.write(`ok doctor: ${issues.length} issue(s)\n`);
  for (const issue of issues) {
    process.stdout.write(`  ${issue.file}${issue.id ? ` (${issue.id})` : ""}: ${issue.reason}\n`);
  }
  return 1;
}
