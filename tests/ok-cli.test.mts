// tests/ok-cli.test.mts — spawn bin/ok.ts and assert exit codes / stdout.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI = `node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "ok.ts")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ok-cli-"));
}

function runCli(cwd: string, args: string): { stdout: string; stderr: string; code: number } {
  try {
    const out = execSync(`${CLI} ${args}`, { cwd, encoding: "utf-8", stdio: "pipe" });
    return { stdout: out, stderr: "", code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "", code: e.status ?? 1 };
  }
}

function extractId(stdout: string): string {
  const m = stdout.match(/tsk-[A-Za-z0-9_-]{6,}/) || stdout.match(/pln-[A-Za-z0-9_-]{6,}/) || stdout.match(/prd-[A-Za-z0-9_-]{6,}/);
  if (!m) throw new Error(`no id in CLI output: ${JSON.stringify(stdout.slice(0, 200))}`);
  return m[0];
}

describe("ok CLI", () => {
  let root: string;

  before(async () => { root = tmp(); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("ok init creates the layout", () => {
    const r = runCli(root, "init");
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /\.ok\//);
  });

  it("ok init is idempotent", () => {
    const a = runCli(root, "init");
    const b = runCli(root, "init");
    assert.strictEqual(a.code, 0);
    assert.strictEqual(b.code, 0);
  });

  it("ok task add prints the new task id", () => {
    const r = runCli(root, "task add \"CLI smoke test\" --owner alice");
    assert.strictEqual(r.code, 0);
    assert.match(extractId(r.stdout), /^tsk-[A-Za-z0-9_-]+$/);
  });

  it("ok task list --json returns JSON", () => {
    const r = runCli(root, "task list --json");
    assert.strictEqual(r.code, 0);
    const arr = JSON.parse(r.stdout);
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length >= 1);
  });

  it("ok task claim -> heartbeat -> complete flow", () => {
    const add = runCli(root, "task add \"CLI claim/complete\" --owner alice");
    const id = extractId(add.stdout);
    const claim = runCli(root, `task claim ${id} --owner alice`);
    assert.strictEqual(claim.code, 0);
    const beat = runCli(root, `task heartbeat ${id} --owner alice`);
    assert.strictEqual(beat.code, 0);
    const done = runCli(root, `task complete ${id} --owner alice --evidence "smoke test"`);
    assert.strictEqual(done.code, 0);
  });

  it("ok plan add + update", () => {
    const add = runCli(root, "plan add \"CLI plan\" --summary x --acceptance a,b");
    assert.strictEqual(add.code, 0);
    const id = extractId(add.stdout);
    const upd = runCli(root, `plan update ${id} --status active`);
    assert.strictEqual(upd.code, 0);
  });

  it("ok prd add + goal-status update", () => {
    const add = runCli(root, "prd add \"CLI prd\" --vision north --goals \"a,b\"");
    assert.strictEqual(add.code, 0);
    const id = extractId(add.stdout);
    const upd = runCli(root, `prd update ${id} --goal g1 --goal-status met`);
    assert.strictEqual(upd.code, 0);
  });

  it("ok index rebuilds and reports counts", () => {
    const r = runCli(root, "index");
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^tasks: \d+, plans: \d+, prds: \d+/);
  });

  it("ok doctor reports 0 issues on a clean tree", () => {
    const r = runCli(root, "doctor");
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /0 issues/);
  });

  it("ok help prints usage", () => {
    const r = runCli(root, "help");
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /ok — self-contained planning workspace/);
  });

  it("unknown subcommand exits non-zero with helpful message", () => {
    const r = runCli(root, "nope");
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /unknown command|nope/);
  });

  it("ok task update requires an id positional", () => {
    const r = runCli(root, "task update");
    assert.strictEqual(r.code, 2);
  });
});
