// tests/ok-prd.test.mts — PRD lifecycle.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initIfMissing, paths, readPrd } from "../ok/storage.ts";
import { runPrd } from "../ok/commands/prd.ts";

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
  try { code = await fn(); }
  finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
    process.chdir(saved);
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("ok prd", () => {
  let root: string;

  before(async () => { root = mkdtempSync(join(tmpdir(), "ok-prd-")); await initIfMissing(root); });
  beforeEach(async () => {
    const p = paths(root);
    rmSync(p.prdsDir, { recursive: true, force: true });
    rmSync(p.indexFile, { force: true });
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("prd add creates goals and milestones", async () => {
    const { code, stdout } = await runOk(root, () => runPrd([
      "add", "Planning v1",
      "--vision", "Self-contained .ok/ workspace",
      "--goals", "ship schemas|ship CLI|ship skill",
      "--milestones", "v0.1|v1.0",
      "--non-goals", "Windows support",
      "--owners", "karen,brenda",
    ]));
    assert.strictEqual(code, 0);
    const id = extractId(stdout);
    const prd = await readPrd(paths(root), id);
    assert.deepStrictEqual(prd!.goals.map((g) => g.text), ["ship schemas", "ship CLI", "ship skill"]);
    assert.deepStrictEqual(prd!.goals.map((g) => g.status), ["open", "open", "open"]);
    assert.deepStrictEqual(prd!.milestones.map((m) => m.title), ["v0.1", "v1.0"]);
    assert.deepStrictEqual(prd!.owners, ["karen", "brenda"]);
  });

  it("prd update --goal-status flips a goal", async () => {
    const r = await runOk(root, () => runPrd(["add", "G", "--vision", "x", "--goals", "a|b"]));
    const id = extractId(r.stdout);
    await runOk(root, () => runPrd(["update", id, "--goal", "g1", "--goal-status", "met"]));
    const prd = await readPrd(paths(root), id);
    const g1 = prd!.goals.find((g) => g.id === "g1")!;
    assert.strictEqual(g1.status, "met");
  });

  it("prd update --milestone-status flips a milestone", async () => {
    const r = await runOk(root, () => runPrd(["add", "M", "--vision", "x", "--milestones", "v1|v2"]));
    const id = extractId(r.stdout);
    await runOk(root, () => runPrd(["update", id, "--milestone", "m2", "--milestone-status", "hit"]));
    const prd = await readPrd(paths(root), id);
    const m2 = prd!.milestones.find((m) => m.id === "m2")!;
    assert.strictEqual(m2.status, "hit");
  });

  it("prd update --append-plan links a plan", async () => {
    const r = await runOk(root, () => runPrd(["add", "P", "--vision", "x"]));
    const id = extractId(r.stdout);
    await runOk(root, () => runPrd(["update", id, "--append-plan", "pln-fake001"]));
    const prd = await readPrd(paths(root), id);
    assert.deepStrictEqual(prd!.plans, ["pln-fake001"]);
  });

  it("prd list --status filters", async () => {
    const a = await runOk(root, () => runPrd(["add", "draft", "--vision", "x"]));
    const b = await runOk(root, () => runPrd(["add", "to ship", "--vision", "x"]));
    const bId = extractId(b.stdout);
    await runOk(root, () => runPrd(["update", bId, "--status", "active"]));
    const r = await runOk(root, () => runPrd(["list", "--status", "active", "--json"]));
    const arr = JSON.parse(r.stdout);
    assert.strictEqual(arr.length, 1);
    assert.strictEqual(arr[0].id, bId);
  });

  it("prd add requires --vision", async () => {
    const { code, stderr } = await runOk(root, () => runPrd(["add", "no vision"]));
    assert.strictEqual(code, 2);
    assert.match(stderr, /--vision is required/);
  });

  it("prd show prints fields", async () => {
    const r = await runOk(root, () => runPrd(["add", "shown", "--vision", "north star"]));
    const id = extractId(r.stdout);
    const out = await runOk(root, () => runPrd(["show", id]));
    assert.match(out.stdout, /vision: north star/);
    assert.match(out.stdout, /status: draft/);
  });
});
