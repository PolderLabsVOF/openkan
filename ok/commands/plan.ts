// ok/commands/plan.ts — `ok plan add|list|show|update`.

import {
  type Plan,
  type PlanStatus,
  type IndexEntry,
  touch,
  isPlan,
  byUpdatedDesc,
} from "../schemas.ts";
import {
  initIfMissing,
  readPlan,
  writePlan,
  listPlans,
  readTask,
  writeTask,
  readConfig,
  rebuildIndex,
  paths as computePaths,
} from "../storage.ts";
import { newId, nowIso, parseArgs, flagString, flagCsv, flagBool } from "../ids.ts";
import type { OkPaths } from "../storage.ts";

const STATUSES: PlanStatus[] = ["draft", "active", "blocked", "complete", "abandoned"];

function parseStatus(v: string | undefined): PlanStatus | undefined {
  if (!v) return undefined;
  if (!STATUSES.includes(v as PlanStatus)) {
    throw new Error(`status must be one of ${STATUSES.join("|")}`);
  }
  return v as PlanStatus;
}

async function paths(): Promise<OkPaths> {
  const p = computePaths(process.cwd());
  if (!(await readConfig(p))) {
    return initIfMissing(process.cwd());
  }
  return p;
}

function printTable(rows: IndexEntry[]): void {
  if (rows.length === 0) {
    process.stdout.write("(no plans)\n");
    return;
  }
  const w = Math.max(2, ...rows.map((r) => r.id.length));
  for (const r of rows) {
    process.stdout.write(`${r.id.padEnd(w)}  ${r.status.padEnd(10)}  ${r.updatedAt}  ${r.title}\n`);
  }
}

export async function runPlan(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":    return cmdPlanAdd(rest);
    case "list":   return cmdPlanList(rest);
    case "show":   return cmdPlanShow(rest);
    case "update": return cmdPlanUpdate(rest);
    default:
      process.stderr.write("usage: ok plan <add|list|show|update>\n");
      return 2;
  }
}

async function cmdPlanAdd(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length === 0) {
    process.stderr.write("usage: ok plan add <title> [--summary …] [--prd <id>] [--tasks t1,t2,…]\n");
    return 2;
  }
  const title = positionals.join(" ");
  const summary = flagString(flags, "summary") ?? title;
  const prd = flagString(flags, "prd");
  const tasks = flagCsv(flags, "tasks");
  const acceptance = flagCsv(flags, "acceptance");
  const phase = flagString(flags, "phase");

  const p = await paths();
  const now = nowIso();
  const plan: Plan = {
    schema: "ok.plan.v1",
    id: newId("pln"),
    title,
    summary,
    status: "draft",
    tasks,
    acceptance,
    createdAt: now,
    updatedAt: now,
  };
  if (prd) plan.prd = prd;
  if (phase) plan.phase = phase;

  await writePlan(p, plan);

  // Backlink: set plan on each referenced task if not already set.
  for (const tid of tasks) {
    const t = await readTask(p, tid);
    if (t && !t.plan) {
      await writeTask(p, touch({ ...t, plan: plan.id }));
    }
  }
  await rebuildIndex(p);
  process.stdout.write(`${plan.id}\n`);
  return 0;
}

async function cmdPlanList(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const p = await paths();
  let plans = await listPlans(p);
  const status = parseStatus(flagString(flags, "status"));
  if (status) plans = plans.filter((pl) => pl.status === status);
  const prd = flagString(flags, "prd");
  if (prd) plans = plans.filter((pl) => pl.prd === prd);
  plans = byUpdatedDesc(plans);
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(plans, null, 2) + "\n");
    return 0;
  }
  printTable(plans.map((pl) => ({ id: pl.id, status: pl.status, title: pl.title, updatedAt: pl.updatedAt })));
  return 0;
}

async function cmdPlanShow(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok plan show <id> [--json]\n");
    return 2;
  }
  const p = await paths();
  const plan = await readPlan(p, positionals[0]);
  if (!plan) {
    process.stderr.write(`no such plan: ${positionals[0]}\n`);
    return 1;
  }
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }
  for (const [k, v] of Object.entries(plan)) {
    process.stdout.write(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}\n`);
  }
  return 0;
}

async function cmdPlanUpdate(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok plan update <id> [--status …] [--phase …] [--tasks t1,t2,…] [--append-task t]\n");
    return 2;
  }
  const p = await paths();
  const existing = await readPlan(p, positionals[0]);
  if (!existing) {
    process.stderr.write(`no such plan: ${positionals[0]}\n`);
    return 1;
  }
  let next: Plan = touch(existing);

  const status = parseStatus(flagString(flags, "status"));
  if (status) next.status = status;
  const phase = flagString(flags, "phase");
  if (phase !== undefined) next.phase = phase;
  const tasksCsv = flagString(flags, "tasks");
  if (tasksCsv !== undefined) next.tasks = flagCsv({ tasks: tasksCsv } as any, "tasks");
  const appendTask = flagString(flags, "append-task");
  if (appendTask) next.tasks = [...next.tasks, appendTask];
  const appendTasks = flagCsv(flags, "append-tasks");
  for (const t of appendTasks) next.tasks = [...next.tasks, t];

  await writePlan(p, next);
  await rebuildIndex(p);
  process.stdout.write(`${next.id}\n`);
  return 0;
}
