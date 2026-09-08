// ok/commands/task.ts — `ok task add|list|show|update|claim|heartbeat|complete|cancel`.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  type Task,
  type TaskV1,
  type TaskV2,
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
import { detectFixtureSmells, type SmellDetection } from "../fixture-detector.mts";
import { resolve as resolvePath } from "node:path";
import { activeProject } from "../../kanban/projects.ts";

/**
 * Returns true if the current cwd is the same as the active project root in
 * the OpenKan registry (or if no active project is registered — i.e., no
 * server is expected to be running for the registry's project).
 *
 * Guards `ok task add|claim|heartbeat|complete` against accidentally posting
 * to a server that serves a different repository. The CLI mirrors its
 * mutations to the active dashboard by default (line 269 `apiRequest` etc.),
 * but a `ok task add` invoked from a *different* project (e.g. a test
 * fixture running in `mkdtempSync(...)`) would otherwise leak its task onto
 * the user's active dashboard and pollute the running board.
 *
 * Test-only opt-out: `OPENKAN_FORCE_MIRROR=1` ignores the cwd check so
 * tests that intentionally want to verify the mirror path can still
 * exercise it.
 */
async function shouldMirrorToActiveServer(): Promise<boolean> {
  if (process.env.OPENKAN_FORCE_MIRROR === "1") return true;
  try {
    const active = activeProject();
    if (!active || !active.root) return true;
    return resolvePath(active.root) === resolvePath(process.cwd());
  } catch {
    return true;
  }
}

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
    case "cleanup-fixtures": return cmdCleanupFixtures(rest);
    default:
      process.stderr.write("usage: ok task <add|list|show|update|claim|heartbeat|complete|cancel|release|cleanup-fixtures>\n");
      return 2;
  }
}

function titleFromArgs(positionals: string[]): string {
  if (positionals.length === 0) {
    throw new Error("ok task add requires a title positional");
  }
  return positionals.join(" ");
}

interface OfflineBoardTask {
  id: string;
  title: string;
  description: string;
  column: "backlog" | "todo" | "doing" | "review" | "done";
  order: number;
  sessionId: null;
  agent: string;
  model: null;
  status: "idle" | "running" | "done" | "cancelled";
  state: "idle" | "running" | "done" | "cancelled";
  lastError: null;
  createdAt: string;
  updatedAt: string;
  artifact: string;
  sessionArtifact: null;
  pendingInputs: string[];
  artifacts: { mdxPath: string; commentsPath: string; inputsPath: string; statePath: string };
  tags: string[];
  category: "task";
  priority: "normal";
  effort: null;
  archived: boolean;
  assignees: string[];
  images: string[];
  parentId: null;
  subtaskIds: string[];
  offlineMirrorId: string;
}

interface OfflineBoard {
  version: 1;
  columns: Array<{ id: string; title: string }>;
  tasks: OfflineBoardTask[];
  sessions: Record<string, unknown>;
}

function offlineBoardTask(task: TaskV1, column: OfflineBoardTask["column"]): OfflineBoardTask {
  const state = task.status === "in_progress" ? "running" : task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : "idle";
  const artifacts = {
    mdxPath: `tasks/${task.id}/task.mdx`,
    commentsPath: `tasks/${task.id}/comments.json`,
    inputsPath: `tasks/${task.id}/inputs.json`,
    statePath: `tasks/${task.id}/state.json`,
  };
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    column,
    order: 0,
    sessionId: null,
    agent: task.owner ?? "",
    model: null,
    status: state,
    state,
    lastError: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    artifact: artifacts.mdxPath,
    sessionArtifact: null,
    pendingInputs: [],
    artifacts,
    tags: task.scopes ?? [],
    category: "task",
    priority: "normal",
    effort: null,
    archived: task.status === "cancelled",
    assignees: task.owner ? [task.owner] : [],
    images: [],
    parentId: null,
    subtaskIds: [],
    offlineMirrorId: task.id,
  };
}

async function writeOfflineBoardTask(p: OkPaths, task: TaskV1, column: OfflineBoardTask["column"]): Promise<void> {
  const file = path.join(p.root, "board.json");
  let board: OfflineBoard = {
    version: 1,
    columns: [
      { id: "backlog", title: "Backlog" },
      { id: "todo", title: "To Do" },
      { id: "doing", title: "In Progress" },
      { id: "review", title: "Review" },
      { id: "done", title: "Done" },
    ],
    tasks: [],
    sessions: {},
  };
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Partial<OfflineBoard>;
    if (Array.isArray(parsed.tasks) && Array.isArray(parsed.columns) && parsed.sessions) {
      board = { version: 1, columns: parsed.columns, tasks: parsed.tasks, sessions: parsed.sessions };
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (board.tasks.some((existing) => existing.id === task.id || existing.offlineMirrorId === task.id)) return;
  const next = offlineBoardTask(task, column);
  next.order = board.tasks.filter((existing) => existing.column === column).length;
  board.tasks.push(next);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(board, null, 2), "utf-8");
  await fs.rename(tmp, file);
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
  const task: TaskV1 = {
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
  //
  // Guard: only attempt the mirror when `cwd` matches the registry's
  // active project root. Without this guard, a `ok task add` invoked from
  // a *different* project (e.g. a test fixture under `mkdtempSync`) leaks
  // its task onto whichever server happens to be reachable — polluting
  // the running dashboard with smoke-test fixtures. `shouldMirrorToActiveServer`
  // returns true only when the cwd is the active project; otherwise we
  // skip the mirror and write the local offline board file (the same
  // path the `response.offline` branch takes).
  const payload: Record<string, unknown> = {
    title,
    column,
    clientId: localId,
  };
  if (task.owner) payload.assignee = task.owner;
  if (desc) payload.description = desc;

  let response: { ok: boolean; status: number; body: unknown; offline: boolean; error?: string } | undefined;
  if (await shouldMirrorToActiveServer()) {
    response = await apiRequest({
      path: "/api/tasks",
      method: "POST",
      payload,
      timeoutMs: 4000,
    });
  }

  if (!response || response.offline) {
    await writeOfflineBoardTask(p, task, column as OfflineBoardTask["column"]);
    const reason = !response ? "skipped: cwd is not the active project" : `dashboard unreachable (${response.error ?? "no server"})`;
    process.stderr.write(`ok task add: ${reason}; wrote board.json fallback and will reconcile on next server boot\n`);
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

  let next: TaskV2 = touch(existing);

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
  if (priority) {
    // Phase 1: v1 TaskPriority ("p0"|"p1"|"p2"|"p3") on the CLI surface,
    // v2 Priority ("urgent"|"high"|"normal"|"low") in storage. Map at the
    // boundary so the CLI stays on the v1 enum until Phase 10 finalisation.
    const v2Priority: TaskV2["priority"] =
      priority === "p0" ? "urgent" :
      priority === "p1" ? "high" :
      priority === "p2" ? "normal" :
      "low";
    next.priority = v2Priority;
  }
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
    const next: TaskV2 = touch({ ...task, status: "in_progress", startedAt: task.startedAt ?? nowIso(), owner });
    await writeTask(p, next);
    await refreshIndex(p);
  } else if (task) {
    const next: TaskV2 = touch({ ...task, owner });
    await writeTask(p, next);
    await refreshIndex(p);
  }
  // Mirror claim onto the board task so the dashboard reflects
  // ownership immediately. Patch is best-effort: when the server is
  // unreachable the offline cache still holds the lease and the
  // reconciler will pick up the state on the next server boot.
  //
  // Guard via `shouldMirrorToActiveServer`: skip the mirror when cwd is
  // not the active project (e.g. a `mkdtempSync` test fixture running
  // `ok task claim` would otherwise PATCH a card onto whichever
  // dashboard happens to be reachable and pollute the running board).
  let claimRes: { ok: boolean; status: number; body: unknown; offline: boolean; error?: string } | undefined;
  if (await shouldMirrorToActiveServer()) {
    claimRes = await apiRequest({
      path: `/api/tasks/${encodeURIComponent(positionals[0])}`,
      method: "PATCH",
      payload: {
        assignees: [owner],
        state: "running",
        agent: owner,
      },
      timeoutMs: 4000,
    });
  }
  if (!claimRes) {
    // mirror skipped (different project) — offline lease retained
  } else if (claimRes.offline) {
    process.stderr.write(`ok task claim: dashboard unreachable (${claimRes.error ?? "no server"}); offline lease retained\n`);
  } else if (!claimRes.ok) {
    const errMsg = (claimRes.body as { error?: string })?.error ?? `HTTP ${claimRes.status}`;
    process.stderr.write(`ok task claim: dashboard rejected PATCH (${errMsg})\n`);
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
  // Heartbeat is a lease refresh; the board has no lease concept, but
  // we re-affirm the assignee so a dashboard filter still surfaces
  // active ownership. Idempotent on the server side. Guarded via
  // `shouldMirrorToActiveServer` — same reasoning as `cmdTaskClaim`.
  let hbRes: { ok: boolean; status: number; body: unknown; offline: boolean; error?: string } | undefined;
  if (await shouldMirrorToActiveServer()) {
    hbRes = await apiRequest({
      path: `/api/tasks/${encodeURIComponent(positionals[0])}`,
      method: "PATCH",
      payload: { assignees: [owner] },
      timeoutMs: 4000,
    });
  }
  if (hbRes && hbRes.offline) {
    process.stderr.write(`ok task heartbeat: dashboard unreachable; offline lease refreshed\n`);
  }
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
  const next: TaskV2 = touch({
    ...task,
    status: "done",
    owner,
    completedAt: task.completedAt ?? now,
    evidence: [...(task.evidence ?? []), evidence],
  });
  await writeTask(p, next);
  await release(p, positionals[0], owner);
  await refreshIndex(p);
  // Promote the completion onto the board task so the card lands in
  // the Done column with the evidence trail. The HTTP path is
  // canonical; the offline cache is the lease mirror. Guarded via
  // `shouldMirrorToActiveServer` so a `mkdtempSync` test fixture
  // doesn't complete tasks onto the user's live dashboard.
  let completeRes: { ok: boolean; status: number; body: unknown; offline: boolean; error?: string } | undefined;
  if (await shouldMirrorToActiveServer()) {
    completeRes = await apiRequest({
      path: `/api/tasks/${encodeURIComponent(positionals[0])}`,
      method: "PATCH",
      payload: {
        column: "done",
        state: "done",
        assignees: [owner],
      },
      timeoutMs: 4000,
    });
  }
  if (!completeRes) {
    // mirror skipped (different project) — completion persisted offline
  } else if (completeRes.offline) {
    process.stderr.write(`ok task complete: dashboard unreachable; completion persisted offline\n`);
  } else if (!completeRes.ok) {
    const errMsg = (completeRes.body as { error?: string })?.error ?? `HTTP ${completeRes.status}`;
    process.stderr.write(`ok task complete: dashboard rejected PATCH (${errMsg})\n`);
  }
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
  const next: TaskV2 = touch({
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

async function cmdCleanupFixtures(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const apply = flagBool(flags, "apply");
  const yes = flagBool(flags, "yes");

  const p = await paths();

  // Detect fixture smells
  const smells = detectFixtureSmells(p.tasksDir);

  if (smells.length === 0) {
    process.stdout.write("No fixture tasks found.\n");
    return 0;
  }

  // Print summary table
  process.stdout.write("\n");
  process.stdout.write("Detected fixture tasks:\n");
  const tableRows = smells.map((s) => ({
    id: s.id,
    title: s.title.slice(0, 40) + (s.title.length > 40 ? "..." : ""),
    owner: s.owner ?? "(none)",
    action: apply ? "cancel + archive" : "(dry-run)",
  }));

  // Use console.table if available, otherwise fall back to manual formatting
  if (typeof (console as any).table === "function") {
    console.table(tableRows);
  } else {
    process.stdout.write("id".padEnd(14) + " " + "title".padEnd(43) + " " + "owner".padEnd(12) + " " + "action\n");
    process.stdout.write("".padEnd(14, "-") + " " + "".padEnd(43, "-") + " " + "".padEnd(12, "-") + " " + "".padEnd(20, "-") + "\n");
    for (const r of tableRows) {
      process.stdout.write(r.id.padEnd(14) + " " + r.title.padEnd(43) + " " + r.owner.padEnd(12) + " " + r.action + "\n");
    }
  }

  if (!apply) {
    process.stdout.write("\n(dry-run; pass --apply to execute)\n");
    return 0;
  }

  // --apply without --yes requires confirmation
  if (!yes) {
    process.stderr.write("\nThis will cancel and archive " + smells.length + " fixture tasks.\n");
    process.stderr.write("To proceed, pass --yes flag: ok task cleanup-fixtures --apply --yes\n");
    return 1;
  }

  // Apply the cleanup
  const now = nowIso();
  const boardPath = path.join(p.root, "board.json");

  for (const smell of smells) {
    const taskJsonPath = path.join(p.tasksDir, `${smell.id}.json`);

    // Read existing task
    let task: Task | undefined;
    try {
      const raw = await fs.readFile(taskJsonPath, "utf-8");
      task = JSON.parse(raw) as Task;
    } catch {
      process.stderr.write(`Warning: could not read ${smell.id}.json, skipping\n`);
      continue;
    }

    // Update task with cancelled status
    const updatedTask: Task = {
      ...task,
      status: "cancelled",
      archived: true,
      completedAt: task.completedAt ?? now,
      evidence: [
        ...(task.evidence ?? []),
        `cleanup-fixtures: detected as test fixture`,
        `original title: ${smell.title}`,
        `original owner: ${smell.owner ?? "(none)"}`,
      ],
    };
    await fs.writeFile(taskJsonPath, JSON.stringify(updatedTask, null, 2), "utf-8");

    // Update board.json
    try {
      let board: { tasks?: OfflineBoardTask[] } = { tasks: [] };
      try {
        const boardRaw = await fs.readFile(boardPath, "utf-8");
        board = JSON.parse(boardRaw);
      } catch {
        // board.json might not exist or be invalid
      }

      if (board.tasks) {
        const taskIdx = board.tasks.findIndex(
          (t) => t.id === smell.id || t.offlineMirrorId === smell.id
        );
        if (taskIdx !== -1) {
          board.tasks[taskIdx] = {
            ...board.tasks[taskIdx],
            column: "backlog",
            state: "cancelled",
            status: "cancelled",
            archived: true,
          };
          await fs.writeFile(boardPath, JSON.stringify(board, null, 2), "utf-8");
        }
      }
    } catch {
      // Best-effort board update - don't fail the whole cleanup
      process.stderr.write(`Warning: could not update board.json for ${smell.id}\n`);
    }
  }

  await refreshIndex(p);
  process.stdout.write(`\nCleaned up ${smells.length} fixture tasks.\n`);
  return 0;
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
