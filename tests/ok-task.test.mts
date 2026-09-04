// tests/ok-task.test.mts — task lifecycle: add → claim → heartbeat → complete / cancel.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initIfMissing, paths, readTask } from "../ok/storage.ts";
import { runTask } from "../ok/commands/task.ts";
import { LockHeldError } from "../ok/lock.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ok-task-"));
}

/** Run an ok task subcommand in `cwd`, returning { code, stdout, stderr }. */
async function runOk(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const saved = process.cwd();
  process.chdir(cwd);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (s: string) => { stdout.push(s); return true; };
  (process.stderr as any).write = (s: string) => { stderr.push(s); return true; };
  let code = 0;
  try {
    code = await runTask(args);
  } finally {
    (process.stdout as any).write = origStdout;
    (process.stderr as any).write = origStderr;
    process.chdir(saved);
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/**
 * Pull a tsk- id out of the add command's stdout (which may be polluted by
 * the node:test runner event stream on concurrent test runs).
 */
function extractId(stdout: string): string {
  // The captured stdout can contain arbitrary TAP runner events interleaved
  // with our command output; match the id anywhere and assert it is well-formed.
  const m = stdout.match(/tsk-[A-Za-z0-9_-]{6,}/);
  if (!m) {
    const tail = stdout.length > 2000 ? stdout.slice(-2000) : stdout;
    throw new Error(`no task id found in stdout (length=${stdout.length}); tail=${JSON.stringify(tail)}`);
  }
  return m[0];
}

describe("ok task", () => {
  let root: string;

  before(async () => { root = tmp(); await initIfMissing(root); });
  beforeEach(async () => {
    // wipe tasks between tests to keep the registry clean
    const p = paths(root);
    rmSync(p.tasksDir, { recursive: true, force: true });
    rmSync(p.locksDir, { recursive: true, force: true });
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("add creates a task in pending state", async () => {
    const { code, stdout } = await runOk(root, ["add", "Write the README"]);
    assert.strictEqual(code, 0);
    const id = extractId(stdout);
    assert.match(id, /^tsk-[A-Za-z0-9_-]+$/);
    const t = await readTask(paths(root), id);
    assert.strictEqual(t!.status, "pending");
    assert.strictEqual(t!.title, "Write the README");
  });

  it("add with --priority and --scope populates fields", async () => {
    const { stdout } = await runOk(root, ["add", "Wire CLI", "--priority", "p1", "--scope", "bin,docs", "--description", "x"]);
    const id = extractId(stdout);
    const t = await readTask(paths(root), id);
    assert.strictEqual(t!.priority, "p1");
    assert.deepStrictEqual(t!.scopes, ["bin", "docs"]);
    assert.strictEqual(t!.description, "x");
  });

  it("claim transitions to in_progress and writes lock", async () => {
    const { stdout: id1 } = await runOk(root, ["add", "claim me"]);
    const id = extractId(id1);
    const { code } = await runOk(root, ["claim", id, "--owner", "alice"]);
    assert.strictEqual(code, 0);
    const t = await readTask(paths(root), id);
    assert.strictEqual(t!.status, "in_progress");
    assert.strictEqual(t!.owner, "alice");
    assert.ok(t!.startedAt);
  });

  it("second claim by different owner fails", async () => {
    const { stdout: id1 } = await runOk(root, ["add", "compete"]);
    const id = extractId(id1);
    await runOk(root, ["claim", id, "--owner", "alice"]);
    const { code, stderr } = await runOk(root, ["claim", id, "--owner", "bob"]);
    assert.strictEqual(code, 1);
    assert.match(stderr, /locked by/);
  });

  it("heartbeat refreshes lease for the current owner", async () => {
    const { stdout: id1 } = await runOk(root, ["add", "heartbeat me"]);
    const id = extractId(id1);
    await runOk(root, ["claim", id, "--owner", "alice"]);
    const { code } = await runOk(root, ["heartbeat", id, "--owner", "alice"]);
    assert.strictEqual(code, 0);
  });

  it("complete moves to done and records evidence + completedAt", async () => {
    const { stdout: id1 } = await runOk(root, ["add", "finish me"]);
    const id = extractId(id1);
    await runOk(root, ["claim", id, "--owner", "alice"]);
    const { code } = await runOk(root, ["complete", id, "--owner", "alice", "--evidence", "abc1234 commit"]);
    assert.strictEqual(code, 0);
    const t = await readTask(paths(root), id);
    assert.strictEqual(t!.status, "done");
    assert.deepStrictEqual(t!.evidence, ["abc1234 commit"]);
    assert.ok(t!.completedAt);
  });

  it("cancel moves to cancelled with reason", async () => {
    const { stdout: id1 } = await runOk(root, ["add", "drop me"]);
    const id = extractId(id1);
    await runOk(root, ["claim", id, "--owner", "alice"]);
    const { code } = await runOk(root, ["cancel", id, "--owner", "alice", "--reason", "duplicate"]);
    assert.strictEqual(code, 0);
    const t = await readTask(paths(root), id);
    assert.strictEqual(t!.status, "cancelled");
    assert.ok(t!.evidence!.some((e) => e.includes("duplicate")));
  });

  it("list --json returns JSON", async () => {
    await runOk(root, ["add", "first"]);
    await runOk(root, ["add", "second"]);
    const { stdout } = await runOk(root, ["list", "--json"]);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 2);
  });

  it("list --status filters", async () => {
    const { stdout: id1 } = await runOk(root, ["add", "stay pending"]);
    const { stdout: id2 } = await runOk(root, ["add", "do this"]);
    const idd = extractId(id2);
    await runOk(root, ["claim", idd, "--owner", "alice"]);
    const { stdout: outPending } = await runOk(root, ["list", "--status", "pending", "--json"]);
    const pending = JSON.parse(outPending);
    assert.ok(pending.find((t: any) => t.id === extractId(id1)));
    assert.ok(!pending.find((t: any) => t.id === idd));
  });

  it("update --status moves a task through lifecycle", async () => {
    const { stdout } = await runOk(root, ["add", "lifecycle"]);
    const id = extractId(stdout);
    await runOk(root, ["update", id, "--status", "review"]);
    const t = await readTask(paths(root), id);
    assert.strictEqual(t!.status, "review");
  });

  it("show prints task fields", async () => {
    const { stdout: addOut } = await runOk(root, ["add", "show me"]);
    const id = extractId(addOut);
    const { stdout: showOut } = await runOk(root, ["show", id]);
    assert.match(showOut, /status: pending/);
    assert.match(showOut, /title: show me/);
  });

  it("requires --owner for claim/complete/cancel", async () => {
    const { stdout: addOut } = await runOk(root, ["add", "owner-required"]);
    const id = extractId(addOut);
    const { code, stderr } = await runOk(root, ["claim", id]);
    assert.strictEqual(code, 2);
    assert.match(stderr, /--owner is required/);
  });

  it("requires --evidence and --reason for complete and cancel", async () => {
    const { stdout: addOut } = await runOk(root, ["add", "evidence-required"]);
    const id = extractId(addOut);
    await runOk(root, ["claim", id, "--owner", "alice"]);
    const r1 = await runOk(root, ["complete", id, "--owner", "alice"]);
    assert.strictEqual(r1.code, 2);
    const r2 = await runOk(root, ["cancel", id, "--owner", "alice"]);
    assert.strictEqual(r2.code, 2);
  });
});
