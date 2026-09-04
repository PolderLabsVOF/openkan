// tests/ok-plan.test.mts — plan lifecycle.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initIfMissing, paths, readTask, readPlan } from "../ok/storage.ts";
import { runTask } from "../ok/commands/task.ts";
import { runPlan } from "../ok/commands/plan.ts";

function extractId(stdout: string): string {
  const m = stdout.match(/tsk-[A-Za-z0-9_-]{6,}/) || stdout.match(/pln-[A-Za-z0-9_-]{6,}/) || stdout.match(/prd-[A-Za-z0-9_-]{6,}/);
  if (!m) throw new Error(`no task/plan/prd id found in stdout`);
  return m[0];
}

async function runOk(cwd: string, fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const saved = process.cwd();
  process.chdir(cwd);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (s: string) => { stdout.push(s); return true; };
  (process.stderr as any).write = (s: string) => { stderr.push(s); return true; };
  let code = 0;
  try {
    code = await fn();
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
    process.chdir(saved);
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("ok plan", () => {
  let root: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "ok-plan-"));
    await initIfMissing(root);
  });
  beforeEach(async () => {
    const p = paths(root);
    rmSync(p.tasksDir, { recursive: true, force: true });
    rmSync(p.plansDir, { recursive: true, force: true });
    rmSync(p.indexFile, { force: true });
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("plan add creates a draft plan", async () => {
    const { code, stdout } = await runOk(root, () => runPlan(["add", "M1: schemas", "--summary", "ship", "--acceptance", "tests green,docs merged"]));
    assert.strictEqual(code, 0);
    const id = extractId(stdout);
    const plan = await readPlan(paths(root), id);
    assert.strictEqual(plan!.status, "draft");
    assert.strictEqual(plan!.summary, "ship");
    assert.deepStrictEqual(plan!.acceptance, ["tests green", "docs merged"]);
  });

  it("plan add with --tasks back-links tasks", async () => {
    const t = await runOk(root, () => runTask(["add", "wire storage"]));
    const tId = extractId(t.stdout);
    const pl = await runOk(root, () => runPlan(["add", "M2: storage", "--tasks", tId]));
    const plId = extractId(pl.stdout);
    const plan = await readPlan(paths(root), plId);
    assert.deepStrictEqual(plan!.tasks, [tId]);
    const task = await readTask(paths(root), tId);
    assert.strictEqual(task!.plan, plId);
  });

  it("plan list --status filters", async () => {
    const a = await runOk(root, () => runPlan(["add", "draft one"]));
    const b = await runOk(root, () => runPlan(["add", "draft two"]));
    const bId = extractId(b.stdout);
    await runOk(root, () => runPlan(["update", bId, "--status", "active"]));
    const r = await runOk(root, () => runPlan(["list", "--status", "active", "--json"]));
    const arr = JSON.parse(r.stdout);
    assert.strictEqual(arr.length, 1);
    assert.strictEqual(arr[0].id, bId);
  });

  it("plan update appends tasks", async () => {
    const t1 = await runOk(root, () => runTask(["add", "alpha"]));
    const t2 = await runOk(root, () => runTask(["add", "beta"]));
    const pl = await runOk(root, () => runPlan(["add", "scope", "--tasks", extractId(t1.stdout)]));
    const plId = extractId(pl.stdout);
    await runOk(root, () => runPlan(["update", plId, "--append-task", extractId(t2.stdout)]));
    const plan = await readPlan(paths(root), plId);
    assert.deepStrictEqual(plan!.tasks, [extractId(t1.stdout), extractId(t2.stdout)]);
  });

  it("plan show prints fields", async () => {
    const pl = await runOk(root, () => runPlan(["add", "shown"]));
    const id = extractId(pl.stdout);
    const r = await runOk(root, () => runPlan(["show", id]));
    assert.match(r.stdout, /status: draft/);
    assert.match(r.stdout, /title: shown/);
  });
});
