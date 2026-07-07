// tests/sanity-check.test.mts — unit tests for scripts/sanity-check.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runSanityCheck(kanbanDir: string): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("node", ["--experimental-strip-types", "scripts/sanity-check.ts"], {
    cwd: "/home/drb0rk/Projects/openkan",
    env: { ...process.env, OPENKAN_DIR: kanbanDir },
    encoding: "utf-8",
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function makeBoardJson(tasks: any[]): string {
  return JSON.stringify({ version: 1, columns: [{ id: "backlog", title: "Backlog" }], tasks, sessions: {} }, null, 2);
}

describe("sanity-check", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `sanity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".openkan"), { recursive: true });
    // Write a dummy docs/roadmap.mdx for valid source paths (at project root so
    // the script's cwd-relative path check finds it; the .openkan is in tmp via OPENKAN_DIR)
    mkdirSync(join(tmp, "docs"), { recursive: true });
    writeFileSync(join(tmp, "docs", "roadmap.mdx"), "- [ ] Fix the bug\n", "utf-8");
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("exits 0 with no tasks", () => {
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson([]), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    assert.strictEqual(r.exitCode, 0, `expected 0, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
  });

  it("exits 0 with 2 valid tasks (no sources)", () => {
    const tasks = [
      { id: "tsk-001", title: "Do thing", column: "backlog", order: 0, source: null },
      { id: "tsk-002", title: "Do other", column: "backlog", order: 1, source: null },
    ];
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson(tasks), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    assert.strictEqual(r.exitCode, 0, `expected 0, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
  });

  it("exits 0 with a task whose source file exists", () => {
    const tasks = [
      { id: "imp-abc123", title: "Imported task", column: "backlog", order: 0, source: { path: "docs/roadmap.mdx", line: 1, slug: "docs/roadmap.mdx" } },
    ];
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson(tasks), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    assert.strictEqual(r.exitCode, 0, `expected 0, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
  });

  it("exits 1 when a task's source.path does not exist", () => {
    const tasks = [
      { id: "imp-abc123", title: "Imported task", column: "backlog", order: 0, source: { path: "docs/nonexistent.mdx", line: 1, slug: "docs/nonexistent.mdx" } },
    ];
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson(tasks), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    assert.strictEqual(r.exitCode, 1, `expected 1, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes("missing source"), `expected 'missing source' in output: ${r.stdout}`);
  });

  it("exits 1 with duplicate task IDs", () => {
    const tasks = [
      { id: "tsk-001", title: "Thing one", column: "backlog", order: 0, source: null },
      { id: "tsk-001", title: "Thing two", column: "backlog", order: 1, source: null },
    ];
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson(tasks), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    assert.strictEqual(r.exitCode, 1, `expected 1, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes("duplicate task id"), `expected 'duplicate task id' in output: ${r.stdout}`);
  });

  it("exits 1 when a Done task has stale=true", () => {
    const tasks = [
      { id: "imp-abc123", title: "Done but stale", column: "done", order: 0, source: null, stale: true },
    ];
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson(tasks), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    assert.strictEqual(r.exitCode, 1, `expected 1, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes("Done but stale"), `expected 'Done but stale' in output: ${r.stdout}`);
  });

  it("exits 0 (warning only) for orphaned tasks/ directory", () => {
    // Create board with no tasks, but an orphaned per-task directory
    mkdirSync(join(tmp, ".openkan", "tasks", "tsk-orphan"), { recursive: true });
    writeFileSync(join(tmp, ".openkan", "board.json"), makeBoardJson([]), "utf-8");
    const r = runSanityCheck(join(tmp, ".openkan"));
    // Orphaned dir is a warning, not an error → exit 0
    assert.strictEqual(r.exitCode, 0, `expected 0, got ${r.exitCode}: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes("orphaned"), `expected 'orphaned' warning in output: ${r.stdout}`);
  });
});
