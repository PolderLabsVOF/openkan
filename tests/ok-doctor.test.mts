// tests/ok-doctor.test.mts — validate JSON against schema.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initIfMissing, paths, writeTask, writePlan, writePrd, rebuildIndex } from "../ok/storage.ts";
import { runDoctor } from "../ok/commands/index.ts";
import { nowIso } from "../ok/ids.ts";

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
  try { code = await fn(); }
  finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
    process.chdir(saved);
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("ok doctor", () => {
  let root: string;

  before(async () => { root = mkdtempSync(join(tmpdir(), "ok-doc-")); await initIfMissing(root); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("reports 0 issues for a clean store", async () => {
    const p = paths(root);
    await writeTask(p, {
      schema: "ok.task.v1",
      id: "tsk-doc001",
      title: "doc me",
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await writePlan(p, {
      schema: "ok.plan.v1",
      id: "pln-doc001",
      title: "doc plan",
      summary: "x",
      status: "draft",
      tasks: [],
      acceptance: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await writePrd(p, {
      schema: "ok.prd.v1",
      id: "prd-doc001",
      title: "doc prd",
      vision: "x",
      goals: [],
      nonGoals: [],
      successMetrics: [],
      milestones: [],
      risks: [],
      plans: [],
      owners: [],
      status: "draft",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const r = await runOk(root, () => runDoctor());
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /0 issues/);
  });

  it("reports parse errors", async () => {
    const p = paths(root);
    writeFileSync(join(p.tasksDir, "tsk-bad0001.json"), "{ not valid json", "utf-8");
    const r = await runOk(root, () => runDoctor());
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /JSON parse error/);
    rmSync(join(p.tasksDir, "tsk-bad0001.json"));
  });

  it("reports schema mismatches", async () => {
    const p = paths(root);
    writeFileSync(join(p.tasksDir, "tsk-bad0002.json"), JSON.stringify({ schema: "ok.task.v1", id: "tsk-bad0002" }), "utf-8");
    const r = await runOk(root, () => runDoctor());
    assert.strictEqual(r.code, 1);
    rmSync(join(p.tasksDir, "tsk-bad0002.json"));
  });

  it("rebuildIndex then doctor returns 0 issues", async () => {
    const p = paths(root);
    await rebuildIndex(p);
    const r = await runOk(root, () => runDoctor());
    assert.strictEqual(r.code, 0);
  });
});
