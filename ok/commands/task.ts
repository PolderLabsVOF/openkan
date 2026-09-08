// ok/commands/task.ts — `ok task add|list|show|update|claim|heartbeat|complete|cancel`.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  type Task,
  type TaskStatus,
  type TaskPriority,
  type IndexEntry,
  touch,
  isTask,
  byUpdatedDesc,
} from "../schemas.ts";
import {
  type OkPaths,
  initIfMissing,
  readTask,
  writeTask,
  listTasks,
  readConfig,
  writeConfig,
  rebuildIndex,
  paths as computePaths,
} from "../storage.ts";
import { type ParsedArgs, newId, nowIso, parseArgs, flagString, flagCsv, flagBool, runMain } from "../ids.ts";
import { claim, heartbeat, release, assertUsable, LockHeldError } from "../lock.ts";
import { pathToFileURL } from "node:url";
import { apiRequest } from "./api.ts";

const STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "done", "cancelled"];
const PRIORITIES: TaskPriority[] = ["p0", "p1", "p2", "p3"];

function parseStatus(v: string | undefined): TaskStatus | undefined {
  if (!v) return undefined;
  if (!STATUSES.includes(v as TaskStatus)) {
    throw new Error(`status must be one of ${STATUSES.join("|")}`);
  }
  return v as TaskStatus;
}

function parsePriority(v: string | undefined): TaskPriority | undefined {
  if (!v) return undefined;
  if (!PRIORITIES.includes(v as TaskPriority)) {
    throw new Error(`priority must be one of ${PRIORITIES.join("|")}`);
  }
  return v as TaskPriority;
}

async function paths(): Promise<OkPaths> {
  const p = computePaths(process.cwd());
  // Auto-init if a session invokes commands but hasn't run `ok init` yet.
  if (!await readConfig(p)) {
    return initIfMissing(process.cwd());
  }
  return p;
}

function printTable(rows: IndexEntry[]): void {
  if (rows.length === 0) {
    process.stdout.write("(no tasks)\n");
    return;
  }
  const w = Math.max(2, ...rows.map((r) => r.id.length));
  const ts = Math.max(10, ...rows.map((r) => r.updatedAt.length));
  for (const r of rows) {
    process.stdout.write(`${r.id.padEnd(w)}  ${r.status.padEnd(11)}  ${r.updatedAt.padEnd(ts)}  ${r.title}\n`);
  }
}

export async function runTask(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":       return cmdTaskAdd(rest);
    case "list":      return cmdTaskList(rest);
    case "show":      return cmdTaskShow(rest);
    case "update":    return cmdTaskUpdate(rest);
    case "claim":     return cmdTaskClaim(rest);
    case "heartbeat": return cmdTaskHeartbeat(rest);
    case "complete":  return cmdTaskComplete(rest);
    case "cancel":    return cmdTaskCancel(rest);
    case "release":   return cmdTaskRelease(rest);
    default:
      process.stderr.write("usage: ok task <add|list|show|update|claim|heartbeat|complete|cancel|release>\n");
      return 2;
  }
}

function titleFromArgs(positionals: string[]): string {
  if (positionals.length === 0) {
    throw new Error("ok task add requires a title positional");
  }
  return positionals.join(" ");
}

async function cmdTaskAdd(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  const title = titleFromArgs(positionals);
  if (!title || title.trim().length === 0) {
    throw new Error("ok task add: title must be a non-empty, non-whitespace string");
  }
  if (title.length > 200) throw new Error("title must be <= 200 chars");

  const status = parseStatus(flagString(flags, "status")) ?? "pending";
  const columnArg = flagString(flags, "column");
  const column = columnArg ?? "todo";
  if (column && !["backlog", "todo", "doing", "review", "done"].includes(column)) {
    throw new Error("column must be backlog|todo|doing|review|done");
  }

  const p = await paths();
  const cfg = (await readConfig(p))!;
  const now = nowIso();
  const localId = newId("tsk");
  const task: Task = {
    schema: "ok.task.v1",
    id: localId,
    title,
    status,
    createdAt: now,
    updatedAt: now,
    mirrorStatus: "pending",
  };
  const owner = flagString(flags, "owner");
  if (owner) task.owner = owner;
  else if (cfg.defaultOwner) task.owner = cfg.defaultOwner;

  const priority = parsePriority(flagString(flags, "priority"));
  if (priority) task.priority = priority;
  const plan = flagString(flags, "plan");
  if (plan) task.plan = plan;
  const prd = flagString(flags, "prd");
  if (prd) task.prd = prd;

  const scopes = flagCsv(flags, "scope");
  if (scopes.length) task.scopes = scopes;
  const deps = flagCsv(flags, "deps");
  if (deps.length) task.deps = deps;

  const desc = flagString(flags, "description");
  if (desc) task.description = desc;
  const acceptance = flagCsv(flags, "acceptance");
  if (acceptance.length) task.acceptance = acceptance;

  await writeTask(p, task);
  await refreshIndex(p);

  // Attempt to mirror onto the dashboard. If a server is reachable the
  // task becomes visible on the board immediately; if not, the offline
  // file stays `mirrorStatus: "pending"` for the reconciler to pick up
  // on the next server boot. `clientId` lets the server dedupe retries
  // (network blip after the task was actually created server-side).
  const payload: Record<string, unknown> = {
    title,
    column,
    clientId: localId,
  };
  if (task.owner) payload.assignee = task.owner;
  if (desc) payload.description = desc;

  const response = await apiRequest({
    path: "/api/tasks",
    method: "POST",
    payload,
    timeoutMs: 4000,
  });

  if (response.offline) {
    process.stderr.write(`ok task add: dashboard unreachable (${response.error ?? "no server"}); kept offline, will reconcile on next server boot\n`);
  } else if (response.ok) {
    const serverTask = response.body as { id?: string; offlineMirrorId?: string } | null;
    const serverId = serverTask?.id;
    if (serverId && serverId !== localId) {
      // Server minted a new id (e.g. duplicate detected and existing
      // returned with a different id). Move the offline cache to mirror
      // it and record the link so claim/heartbeat/complete route back.
      await fs.rename(path.join(p.tasksDir, `${localId}.json`), path.join(p.tasksDir, `${serverId}.json`));
      task.id = serverId;
      task.mirrorStatus = "synced";
      task.mirrorId = serverId;
      await writeTask(p, task);
      await refreshIndex(p);
    } else {
      task.mirrorStatus = "synced";
      task.mirrorId = serverId ?? localId;
      await writeTask(p, task);
      await refreshIndex(p);
    }
  } else {
    // Server replied with a non-2xx (e.g. 422 validation). The offline
    // cache is the local source of truth; the next retry can re-issue.
    const errMsg = (response.body as { error?: string })?.error ?? `HTTP ${response.status}`;
    process.stderr.write(`ok task add: dashboard rejected (${errMsg}); kept offline\n`);
  }

  process.stdout.write(`${task.id}\n`);
  return 0;
}

async function cmdTaskList(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const p = await paths();
  let tasks = await listTasks(p);
  const wantJson = flagBool(flags, "json");

  const filterStatus = parseStatus(flagString(flags, "status"));
  if (filterStatus) tasks = tasks.filter((t) => t.status === filterStatus);

  const owner = flagString(flags, "owner");
  if (owner) tasks = tasks.filter((t) => t.owner === owner);

  const plan = flagString(flags, "plan");
  if (plan) tasks = tasks.filter((t) => t.plan === plan);

  const prd = flagString(flags, "prd");
  if (prd) tasks = tasks.filter((t) => t.prd === prd);

  tasks = byUpdatedDesc(tasks);

  if (wantJson) {
    process.stdout.write(JSON.stringify(tasks, null, 2) + "\n");
  } else {
    const rows: IndexEntry[] = tasks.map((t) => ({
      id: t.id, status: t.status, title: t.title, updatedAt: t.updatedAt,
    }));
    printTable(rows);
  }
  return 0;
}

async function cmdTaskShow(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task show <id> [--json]\n");
    return 2;
  }
  const p = await paths();
  const task = await readTask(p, positionals[0]);
  if (!task) {
    process.stderr.write(`no such task: ${positionals[0]}\n`);
    return 1;
  }
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(task, null, 2) + "\n");
  } else {
    for (const [k, v] of Object.entries(task)) {
      process.stdout.write(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}\n`);
    }
  }
  return 0;
}

async function cmdTaskUpdate(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task update <id> [--status …] [--owner …] [--priority …] [--evidence text] [--acceptance a,b,c]\n");
    return 2;
  }
  const p = await paths();
  const existing = await readTask(p, positionals[0]);
  if (!existing) {
    process.stderr.write(`no such task: ${positionals[0]}\n`);
    return 1;
  }

  let next: Task = touch(existing);

  const status = parseStatus(flagString(flags, "status"));
  if (status) {
    if (status !== existing.status) {
      next.status = status;
      if (status === "in_progress" && !next.startedAt) next.startedAt = nowIso();
      if ((status === "done" || status === "cancelled") && !next.completedAt) next.completedAt = nowIso();
      if (status !== "done" && status !== "cancelled") {
        next.completedAt = undefined;
      }
    }
  }
  const owner = flagString(flags, "owner");
  if (owner !== undefined) next.owner = owner;
  const priority = parsePriority(flagString(flags, "priority"));
  if (priority) next.priority = priority;
  const evidence = flagString(flags, "evidence");
  if (evidence !== undefined) {
    next.evidence = [...(existing.evidence ?? []), evidence];
  }
  const acceptance = flagCsv(flags, "acceptance");
  if (acceptance.length) {
    next.acceptance = [...(existing.acceptance ?? []), ...acceptance];
  }
  const desc = flagString(flags, "description");
  if (desc !== undefined) next.description = desc;

  await writeTask(p, next);
  await refreshIndex(p);
  process.stdout.write(`${next.id}\n`);
  return 0;
}

async function cmdTaskClaim(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task claim <id> --owner X [--lease-ms N]\n");
    return 2;
  }
  const owner = flagString(flags, "owner");
  if (!owner) {
    process.stderr.write("--owner is required\n");
    return 2;
  }
  const leaseMsRaw = flagString(flags, "lease-ms");
  const leaseMs = leaseMsRaw ? Number(leaseMsRaw) : undefined;
  if (leaseMs !== undefined && (!Number.isFinite(leaseMs) || leaseMs <= 0)) {
    process.stderr.write("--lease-ms must be a positive integer\n");
    return 2;
  }
  const p = await paths();
  try {
    await claim(p, positionals[0], owner, { leaseMs });
  } catch (e: any) {
    if (e instanceof LockHeldError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const task = await readTask(p, positionals[0]);
  if (task && task.status === "pending") {
    const next: Task = touch({ ...task, status: "in_progress", startedAt: task.startedAt ?? nowIso(), owner });
    await writeTask(p, next);
    await refreshIndex(p);
  } else if (task) {
    const next: Task = touch({ ...task, owner });
    await writeTask(p, next);
    await refreshIndex(p);
  }
  process.stdout.write(`${positionals[0]}\n`);
  return 0;
}

async function cmdTaskHeartbeat(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task heartbeat <id> --owner X [--lease-ms N]\n");
    return 2;
  }
  const owner = flagString(flags, "owner");
  if (!owner) {
    process.stderr.write("--owner is required\n");
    return 2;
  }
  const leaseMsRaw = flagString(flags, "lease-ms");
  const leaseMs = leaseMsRaw ? Number(leaseMsRaw) : undefined;
  const p = await paths();
  await heartbeat(p, positionals[0], owner, { leaseMs });
  process.stdout.write(`${positionals[0]}\n`);
  return 0;
}

async function cmdTaskComplete(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task complete <id> --owner X --evidence \"<text>\"\n");
    return 2;
  }
  const owner = flagString(flags, "owner");
  if (!owner) {
    process.stderr.write("--owner is required\n");
    return 2;
  }
  const evidence = flagString(flags, "evidence");
  if (!evidence) {
    process.stderr.write("--evidence is required (commit shas, file:line, URLs, etc.)\n");
    return 2;
  }
  const p = await paths();
  await assertUsable(p, positionals[0], owner);

  const task = await readTask(p, positionals[0]);
  if (!task) {
    process.stderr.write(`no such task: ${positionals[0]}\n`);
    return 1;
  }
  const now = nowIso();
  const next: Task = touch({
    ...task,
    status: "done",
    owner,
    completedAt: task.completedAt ?? now,
    evidence: [...(task.evidence ?? []), evidence],
  });
  await writeTask(p, next);
  await release(p, positionals[0], owner);
  await refreshIndex(p);
  process.stdout.write(`${next.id}\n`);
  return 0;
}

async function cmdTaskCancel(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task cancel <id> --owner X --reason \"<text>\"\n");
    return 2;
  }
  const owner = flagString(flags, "owner");
  if (!owner) {
    process.stderr.write("--owner is required\n");
    return 2;
  }
  const reason = flagString(flags, "reason");
  if (!reason) {
    process.stderr.write("--reason is required\n");
    return 2;
  }
  const p = await paths();
  await assertUsable(p, positionals[0], owner);
  const task = await readTask(p, positionals[0]);
  if (!task) {
    process.stderr.write(`no such task: ${positionals[0]}\n`);
    return 1;
  }
  const next: Task = touch({
    ...task,
    status: "cancelled",
    owner,
    completedAt: task.completedAt ?? nowIso(),
    evidence: [...(task.evidence ?? []), `cancelled: ${reason}`],
  });
  await writeTask(p, next);
  await release(p, positionals[0], owner);
  await refreshIndex(p);
  process.stdout.write(`${next.id}\n`);
  return 0;
}

async function cmdTaskRelease(args: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args);
  if (positionals.length !== 1) {
    process.stderr.write("usage: ok task release <id> --owner X\n");
    return 2;
  }
  const owner = flagString(flags, "owner");
  if (!owner) {
    process.stderr.write("--owner is required\n");
    return 2;
  }
  const p = await paths();
  const removed = await release(p, positionals[0], owner);
  process.stdout.write(removed ? `${positionals[0]}\n` : `no lock for ${positionals[0]}\n`);
  return removed ? 0 : 1;
}

async function refreshIndex(p: OkPaths): Promise<void> {
  try {
    await rebuildIndex(p);
  } catch (e: any) {
    process.stderr.write(`warning: index rebuild failed: ${e.message}\n`);
  }
}

// `node --experimental-strip-types ok/commands/task.ts [args]` invocation
// (used by bin/ok.ts shell wrapper for per-subprocess isolation).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runMain(async () => runTask(process.argv.slice(2)));
}
