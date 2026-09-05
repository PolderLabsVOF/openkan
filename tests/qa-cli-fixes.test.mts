// tests/qa-cli-fixes.test.mts — regression tests for the CLI QA pass
// (board tasks tsk-nbAJzTwD, tsk-x7eazVDe, tsk-HZbMRqHE, tsk-raJ3sY_y).
//
// Each `it` block exercises one QA finding end-to-end against a scratch
// project rooted in a tmp directory. The scratch is initialised once and
// torn down after the suite finishes.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI = `node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "ok.ts")}`;
const OPENKAN_CLI = `node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "openkan.ts")}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ok-qa-fix-"));
}

function run(cwd: string, cli: string, args: string): { stdout: string; stderr: string; code: number } {
  try {
    const out = execSync(`${cli} ${args}`, { cwd, encoding: "utf-8", stdio: "pipe" });
    return { stdout: out, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      code: e.status ?? 1,
    };
  }
}

function initScratch(cwd: string): void {
  const r = run(cwd, OPENKAN_CLI, "init");
  assert.strictEqual(r.code, 0, `init failed: ${r.stderr || r.stdout}`);
}

function extractId(stdout: string): string {
  const m = stdout.match(/tsk-[A-Za-z0-9_-]{6,}/);
  if (!m) throw new Error(`no task id in output: ${JSON.stringify(stdout.slice(0, 200))}`);
  return m[0];
}

describe("QA CLI fixes (tsk-nbAJzTwD, tsk-x7eazVDe, tsk-HZbMRqHE, tsk-raJ3sY_y)", () => {
  let root: string;

  before(() => {
    root = tmp();
    initScratch(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ─── tsk-nbAJzTwD: --status flag must be stored, not dropped ─────────────
  describe("--status flag on task add (tsk-nbAJzTwD)", () => {
    it("stores --status in_progress on the new task", () => {
      const r = run(root, OPENKAN_CLI, 'task add "qa status in_progress" --status in_progress');
      assert.strictEqual(r.code, 0, `stderr=${r.stderr}`);
      const id = extractId(r.stdout);
      const file = readFileSync(join(root, ".ok", "tasks", `${id}.json`), "utf-8");
      const task = JSON.parse(file);
      assert.strictEqual(task.status, "in_progress");
    });

    it("stores --status review on the new task", () => {
      const r = run(root, OPENKAN_CLI, 'task add "qa status review" --status review');
      assert.strictEqual(r.code, 0, `stderr=${r.stderr}`);
      const id = extractId(r.stdout);
      const file = readFileSync(join(root, ".ok", "tasks", `${id}.json`), "utf-8");
      const task = JSON.parse(file);
      assert.strictEqual(task.status, "review");
    });

    it("defaults to pending when --status is omitted", () => {
      const r = run(root, OPENKAN_CLI, 'task add "qa status default"');
      assert.strictEqual(r.code, 0, `stderr=${r.stderr}`);
      const id = extractId(r.stdout);
      const file = readFileSync(join(root, ".ok", "tasks", `${id}.json`), "utf-8");
      const task = JSON.parse(file);
      assert.strictEqual(task.status, "pending");
    });

    it("rejects an unknown --status value with a clear error", () => {
      const r = run(root, OPENKAN_CLI, 'task add "qa status bogus" --status bogus');
      assert.notStrictEqual(r.code, 0);
      assert.match(r.stderr, /status must be one of/);
    });
  });

  // ─── tsk-x7eazVDe: empty/whitespace title must be rejected ───────────────
  describe("empty title rejection (tsk-x7eazVDe)", () => {
    it("rejects an empty title before any file is written", () => {
      const beforeCount = run(root, OPENKAN_CLI, "task list --json").stdout.trim().split("\n").filter(Boolean).length;
      // execSync quoting in shell is awkward for empty string; use ok CLI
      // directly to be sure the empty title is preserved.
      const r = run(root, CLI, 'task add ""');
      assert.notStrictEqual(r.code, 0);
      assert.match(r.stderr, /non-empty/);
      // No new task files should have been created.
      const afterCount = run(root, OPENKAN_CLI, "task list --json").stdout.trim().split("\n").filter(Boolean).length;
      assert.strictEqual(beforeCount, afterCount, "empty-title task must not write a file");
    });

    it("rejects a whitespace-only title", () => {
      const r = run(root, CLI, "task add \"   \"");
      assert.notStrictEqual(r.code, 0);
      assert.match(r.stderr, /non-empty/);
    });

    it("schema-loader error tells the operator which file to delete", () => {
      // Inject a schema-invalid task file. The next command that opens it
      // must produce an actionable error pointing at the exact path.
      const badDir = tmp();
      try {
        initScratch(badDir);
        const badPath = join(badDir, ".ok", "tasks", "tsk-corrupt01.json");
        mkdirSync(join(badDir, ".ok", "tasks"), { recursive: true });
        writeFileSync(badPath, JSON.stringify({ schema: "ok.task.v1", id: "tsk-corrupt01", title: "" }));
        const r = run(badDir, OPENKAN_CLI, "task show tsk-corrupt01");
        assert.notStrictEqual(r.code, 0);
        assert.match(r.stderr, /invalid shape in .*tsk-corrupt01\.json/);
        assert.match(r.stderr, /rm ".*tsk-corrupt01\.json"/);
      } finally {
        rmSync(badDir, { recursive: true, force: true });
      }
    });
  });

  // ─── tsk-HZbMRqHE: --path flag must be a real flag for migrate ───────────
  describe("--path flag on migrate-from-openkan (tsk-HZbMRqHE)", () => {
    let legacyDir: string;

    before(() => {
      legacyDir = mkdtempSync(join(tmpdir(), "ok-qa-mig-"));
      mkdirSync(join(legacyDir, ".openkan", "tasks", "legpath01"), { recursive: true });
      writeFileSync(join(legacyDir, ".openkan", "tasks.json"), JSON.stringify({
        tasks: [
          {
            id: "legpath01",
            title: "Path-flag legacy",
            column: "doing",
            order: 0,
            state: "running",
            agent: "alice",
            tags: ["migrated"],
            priority: "urgent",
            mdxPath: "tasks/legpath01/task.mdx",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            archived: false,
          },
        ],
      }));
      writeFileSync(
        join(legacyDir, ".openkan", "tasks", "legpath01", "task.mdx"),
        "---\nid: legpath01\ntitle: Path-flag legacy\n---\n# legacy body\n",
      );
    });

    after(() => {
      rmSync(legacyDir, { recursive: true, force: true });
    });

    it("--path DIR imports the legacy workspace", () => {
      const r = run(root, OPENKAN_CLI, `migrate-from-openkan --path ${legacyDir}`);
      assert.strictEqual(r.code, 0, `stderr=${r.stderr}`);
      assert.ok(r.stdout.includes(`from ${legacyDir}/.openkan`), `unexpected stdout: ${r.stdout}`);
      assert.match(r.stdout, /migrated 1 tasks/);
    });

    it("--path=DIR (equals form) imports the legacy workspace", () => {
      const r = run(root, OPENKAN_CLI, `migrate-from-openkan --path=${legacyDir}`);
      assert.strictEqual(r.code, 0, `stderr=${r.stderr}`);
      assert.ok(r.stdout.includes(`from ${legacyDir}/.openkan`), `unexpected stdout: ${r.stdout}`);
    });

    it("positional root argument still works (backward compatible)", () => {
      const r = run(root, OPENKAN_CLI, `migrate-from-openkan ${legacyDir}`);
      assert.strictEqual(r.code, 0, `stderr=${r.stderr}`);
      assert.ok(r.stdout.includes(`from ${legacyDir}/.openkan`), `unexpected stdout: ${r.stdout}`);
    });

    it("bare --path with no value is rejected", () => {
      const r = run(root, OPENKAN_CLI, "migrate-from-openkan --path");
      assert.notStrictEqual(r.code, 0);
      assert.match(r.stderr, /--path requires a directory argument/);
    });

    it("unknown flag is rejected with a clear error", () => {
      const r = run(root, OPENKAN_CLI, "migrate-from-openkan --bogus /tmp");
      assert.notStrictEqual(r.code, 0);
      assert.match(r.stderr, /unknown flag: --bogus/);
    });
  });

  // ─── tsk-raJ3sY_y: ok --help enumerates every subcommand ─────────────────
  describe("ok --help enumerates every subcommand (tsk-raJ3sY_y)", () => {
    it("prints more than two lines of help", () => {
      const r = run(root, CLI, "--help");
      assert.strictEqual(r.code, 0);
      const lines = r.stdout.split("\n").filter((l) => l.length > 0);
      assert.ok(lines.length > 10, `expected >10 lines of help, got ${lines.length}`);
    });

    it("enumerates every top-level subcommand", () => {
      const r = run(root, CLI, "--help");
      assert.strictEqual(r.code, 0);
      for (const sub of [
        "init",
        "task",
        "plan",
        "prd",
        "goal",
        "progress",
        "index",
        "doctor",
        "migrate-from-openkan",
        "help",
      ]) {
        assert.match(r.stdout, new RegExp(`(^|\\s)${sub}(\\s|$|\\|)`), `help missing subcommand: ${sub}`);
      }
    });

    it("documents the --status flag on ok task add", () => {
      const r = run(root, CLI, "--help");
      assert.strictEqual(r.code, 0);
      assert.match(r.stdout, /--status pending\|in_progress\|review\|done\|cancelled/);
    });

    it("documents the --path flag on migrate-from-openkan", () => {
      const r = run(root, CLI, "--help");
      assert.strictEqual(r.code, 0);
      assert.match(r.stdout, /--path DIR/);
    });
  });
});
