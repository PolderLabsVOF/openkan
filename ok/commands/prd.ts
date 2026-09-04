// ok/commands/prd.ts — `ok prd add|list|show|update`.

import {
  type Prd,
  type PrdStatus,
  type PrdGoal,
  type PrdMilestone,
  type IndexEntry,
  touch,
  byUpdatedDesc,
} from "../schemas.ts";
import {
  initIfMissing,
  readPrd,
  writePrd,
  listPrds,
  readConfig,
  rebuildIndex,
  paths as computePaths,
} from "../storage.ts";
import { newId, nowIso, parseArgs, flagString, flagCsv, flagBool } from "../ids.ts";
import type { OkPaths } from "../storage.ts";

const STATUSES: PrdStatus[] = ["draft", "active", "shipped", "abandoned"];
const GOAL_STATUSES: PrdGoal["status"][] = ["open", "in_progress", "met", "dropped"];
const MILESTONE_STATUSES: PrdMilestone["status"][] = ["open", "hit", "missed", "dropped"];

function parsePrdStatus(v: string | undefined): PrdStatus | undefined {
  if (!v) return undefined;
  if (!STATUSES.includes(v as PrdStatus)) throw new Error(`status must be one of ${STATUSES.join("|")}`);
  return v as PrdStatus;
}

function parseGoalStatus(v: string | undefined): PrdGoal["status"] {
  if (!v) throw new Error("goal status required");
  if (!GOAL_STATUSES.includes(v as PrdGoal["status"])) {
    throw new Error(`goal status must be one of ${GOAL_STATUSES.join("|")}`);
  }
  return v as PrdGoal["status"];
}

function parseMilestoneStatus(v: string | undefined): PrdMilestone["status"] {
  if (!v) throw new Error("milestone status required");
  if (!MILESTONE_STATUSES.includes(v as PrdMilestone["status"])) {
    throw new Error(`milestone status must be one of ${MILESTONE_STATUSES.join("|")}`);
  }
  return v as PrdMilestone["status"];
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
    process.stdout.write("(no PRDs)\n");
    return;
  }
  const w = Math.max(2, ...rows.map((r) => r.id.length));
  for (const r of rows) {
    process.stdout.write(`${r.id.padEnd(w)}  ${r.status.padEnd(10)}  ${r.updatedAt}  ${r.title}\n`);
  }
}

export async function runPrd(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":    return cmdPrdAdd(rest);
    case "list":   return cmdPrdList(rest);
    case "show":   return cmdPrdShow(rest);
    case "update": return cmdPrdUpdate(rest);
    default:
      process.stderr.write("usage: ok prd <add|list|show|update>\n");
      return 2;
  }
}

async function cmdPrdAdd(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length === 0) {
    process.stderr.write("usage: ok prd add <title> [--vision …] [--goals g1|g2|g3] [--non-goals …] [--milestones m1|m2]\n");
    return 2;
  }
  const title = positionals.join(" ");
  const vision = flagString(flags, "vision") ?? "";
  if (!vision) {
    process.stderr.write("--vision is required (one paragraph)\n");
    return 2;
  }
  const goalTexts = flagCsv(flags, "goals");
  const nonGoals = flagCsv(flags, "non-goals");
  const metricSpecs = flagCsv(flags, "metrics");
  const milestoneTexts = flagCsv(flags, "milestones");
  const owners = flagCsv(flags, "owners");
  const cadence = flagString(flags, "review-cadence");

  const p = await paths();
  const now = nowIso();
  const prd: Prd = {
    schema: "ok.prd.v1",
    id: newId("prd"),
    title,
    vision,
    goals: goalTexts.map((text, i) => ({
      id: `g${i + 1}`,
      text,
      status: "open",
    })),
    nonGoals,
    successMetrics: metricSpecs.map((spec) => {
      const [name, target, current] = spec.split("|");
      return {
        name: name ?? spec,
        target: target ?? "",
        current: current || undefined,
      };
    }),
    milestones: milestoneTexts.map((text, i) => ({
      id: `m${i + 1}`,
      title: text,
      status: "open",
    })),
    risks: [],
    plans: [],
    owners: owners.length ? owners : flagString(flags, "owner") ? [flagString(flags, "owner") as string] : [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  if (cadence) prd.reviewCadence = cadence;

  await writePrd(p, prd);
  await rebuildIndex(p);
  process.stdout.write(`${prd.id}\n`);
  return 0;
}

async function cmdPrdList(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const p = await paths();
  let prds = await listPrds(p);
  const status = parsePrdStatus(flagString(flags, "status"));
  if (status) prds = prds.filter((pr) => pr.status === status);
  prds = byUpdatedDesc(prds);
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(prds, null, 2) + "\n");
    return 0;
  }
  printTable(prds.map((pr) => ({ id: pr.id, status: pr.status, title: pr.title, updatedAt: pr.updatedAt })));
  return 0;
}

async function cmdPrdShow(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok prd show <id> [--json]\n");
    return 2;
  }
  const p = await paths();
  const prd = await readPrd(p, positionals[0]);
  if (!prd) {
    process.stderr.write(`no such PRD: ${positionals[0]}\n`);
    return 1;
  }
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(prd, null, 2) + "\n");
    return 0;
  }
  for (const [k, v] of Object.entries(prd)) {
    process.stdout.write(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}\n`);
  }
  return 0;
}

async function cmdPrdUpdate(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok prd update <id> [--status …] [--goal g1 --goal-status met] [--milestone m1 --milestone-status hit] [--append-plan pln-…] [--review-cadence weekly]\n");
    return 2;
  }
  const p = await paths();
  const existing = await readPrd(p, positionals[0]);
  if (!existing) {
    process.stderr.write(`no such PRD: ${positionals[0]}\n`);
    return 1;
  }
  let next: Prd = touch(existing);
  const status = parsePrdStatus(flagString(flags, "status"));
  if (status) next.status = status;

  const goalId = flagString(flags, "goal");
  const goalStatusRaw = flagString(flags, "goal-status");
  if (goalId) {
    const goalStatus = parseGoalStatus(goalStatusRaw);
    next = {
      ...next,
      goals: next.goals.map((g) => (g.id === goalId ? { ...g, status: goalStatus } : g)),
    };
  }
  const milestoneId = flagString(flags, "milestone");
  const milestoneStatusRaw = flagString(flags, "milestone-status");
  if (milestoneId) {
    const milestoneStatus = parseMilestoneStatus(milestoneStatusRaw);
    next = {
      ...next,
      milestones: next.milestones.map((m) => (m.id === milestoneId ? { ...m, status: milestoneStatus } : m)),
    };
  }
  const appendPlan = flagString(flags, "append-plan");
  if (appendPlan && !next.plans.includes(appendPlan)) {
    next.plans = [...next.plans, appendPlan];
  }
  const cadence = flagString(flags, "review-cadence");
  if (cadence !== undefined) next.reviewCadence = cadence;
  const nextReview = flagString(flags, "next-review");
  if (nextReview !== undefined) next.nextReviewAt = nextReview;

  await writePrd(p, next);
  await rebuildIndex(p);
  process.stdout.write(`${next.id}\n`);
  return 0;
}
