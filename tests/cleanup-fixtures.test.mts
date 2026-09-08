// tests/cleanup-fixtures.test.mts — tests for ok task cleanup-fixtures command

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cleanup-fixtures-"));
}

function writeTaskJson(dir: string, id: string, title: string, owner?: string, status: string = "in_progress"): void {
  const tasksDir = join(dir, ".ok", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const task = {
    schema: "ok.task.v1",
    id,
    title,
    status,
    owner,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    mirrorStatus: "pending",
  };

  writeFileSync(join(tasksDir, `${id}.json`), JSON.stringify(task, null, 2));
}

function writeTaskMdx(dir: string, id: string, title: string, owner?: string, taskStatus: string = "in_progress"): void {
  const taskDir = join(dir, ".ok", "tasks", id);
  mkdirSync(taskDir, { recursive: true });

  let frontmatter = `---
title: ${title}
id: ${id}
status: ${taskStatus}
`;

  if (owner) frontmatter += `owner: ${owner}\n`;

  frontmatter += `---\n\n# ${title}\n`;

  writeFileSync(join(taskDir, "task.mdx"), frontmatter);
}

function writeBoardJson(dir: string, tasks: Array<{ id: string; offlineMirrorId: string; title: string; column: string; state: string; status: string; archived: boolean }>): void {
  const board = {
    version: 1,
    columns: [
      { id: "backlog", title: "Backlog" },
      { id: "todo", title: "To Do" },
      { id: "doing", title: "In Progress" },
      { id: "review", title: "Review" },
      { id: "done", title: "Done" },
    ],
    tasks: tasks.map((t, i) => ({
      ...t,
      description: "",
      order: i,
      sessionId: null,
      agent: "",
      model: null,
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      artifact: `tasks/${t.id}/task.mdx`,
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: {
        mdxPath: `tasks/${t.id}/task.mdx`,
        commentsPath: `tasks/${t.id}/comments.json`,
        inputsPath: `tasks/${t.id}/inputs.json`,
        statePath: `tasks/${t.id}/state.json`,
      },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    })),
    sessions: {},
  };

  writeFileSync(join(dir, ".ok", "board.json"), JSON.stringify(board, null, 2));
}

function runCleanupFixtures(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "bin/ok.ts"),
        "task",
        "cleanup-fixtures",
        ...args,
      ],
      {
        cwd: dir,
        env: { ...process.env },
      }
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

describe("cleanup-fixtures", () => {
  describe("dry-run (no --apply)", () => {
    const t = tmp();
    beforeEach(() => {
      // Seed 2 fixture tasks and 1 real task
      writeTaskJson(t, "tsk-fix1", "move a card", undefined, "in_progress");
      writeTaskMdx(t, "tsk-fix1", "move a card", undefined);
      writeTaskJson(t, "tsk-fix2", "server-visible task", "alice", "in_progress");
      writeTaskMdx(t, "tsk-fix2", "server-visible task", "alice");
      writeTaskJson(t, "tsk-real1", "Real user task", "todd", "pending");
      writeTaskMdx(t, "tsk-real1", "Real user task", "todd", "pending");
    });

    afterEach(() => {
      rmSync(t, { recursive: true, force: true });
    });

    it("prints table but does not mutate files", async () => {
      const result = await runCleanupFixtures(t, []);

      assert.ok(result.stdout.includes("tsk-fix1"), "should list fixture tsk-fix1");
      assert.ok(result.stdout.includes("tsk-fix2"), "should list fixture tsk-fix2");
      assert.ok(result.stdout.includes("(dry-run"), "should indicate dry-run");
      assert.strictEqual(result.code, 0);

      // Verify files are NOT modified
      const task1 = JSON.parse(readFileSync(join(t, ".ok", "tasks", "tsk-fix1.json"), "utf-8"));
      assert.strictEqual(task1.status, "in_progress", "task should remain in_progress");
      assert.ok(!task1.archived, "task should not be archived");
    });
  });

  describe("--apply without --yes", () => {
    const t = tmp();
    beforeEach(() => {
      writeTaskJson(t, "tsk-fix1", "move a card", undefined, "in_progress");
      writeTaskMdx(t, "tsk-fix1", "move a card", undefined);
    });

    afterEach(() => {
      rmSync(t, { recursive: true, force: true });
    });

    it("refuses with exit code != 0", async () => {
      const result = await runCleanupFixtures(t, ["--apply"]);

      assert.notStrictEqual(result.code, 0, "should fail without --yes");
      assert.ok(result.stderr.includes("--yes"), "should prompt for --yes");
    });
  });

  describe("--apply --yes", () => {
    const t = tmp();
    beforeEach(() => {
      writeTaskJson(t, "tsk-fix1", "move a card", undefined, "in_progress");
      writeTaskMdx(t, "tsk-fix1", "move a card", undefined);
      writeTaskJson(t, "tsk-fix2", "server-visible task", "alice", "in_progress");
      writeTaskMdx(t, "tsk-fix2", "server-visible task", "alice");
      writeTaskJson(t, "tsk-real1", "Real user task", "todd", "pending");
      writeTaskMdx(t, "tsk-real1", "Real user task", "todd", "pending");

      // Also create a board.json with the tasks
      writeBoardJson(t, [
        { id: "tsk-fix1", offlineMirrorId: "tsk-fix1", title: "move a card", column: "doing", state: "running", status: "running", archived: false },
        { id: "tsk-fix2", offlineMirrorId: "tsk-fix2", title: "server-visible task", column: "doing", state: "running", status: "running", archived: false },
        { id: "tsk-real1", offlineMirrorId: "tsk-real1", title: "Real user task", column: "todo", state: "idle", status: "idle", archived: false },
      ]);
    });

    afterEach(() => {
      rmSync(t, { recursive: true, force: true });
    });

    it("cancels fixtures, archives them, patches board.json", async () => {
      const result = await runCleanupFixtures(t, ["--apply", "--yes"]);

      assert.strictEqual(result.code, 0, "should succeed");

      // Check fixture tasks are cancelled
      const task1 = JSON.parse(readFileSync(join(t, ".ok", "tasks", "tsk-fix1.json"), "utf-8"));
      assert.strictEqual(task1.status, "cancelled", "fixture should be cancelled");
      assert.strictEqual(task1.archived, true, "fixture should be archived");
      assert.ok(task1.evidence?.some((e: string) => e.includes("cleanup-fixtures")), "should have cleanup evidence");

      const task2 = JSON.parse(readFileSync(join(t, ".ok", "tasks", "tsk-fix2.json"), "utf-8"));
      assert.strictEqual(task2.status, "cancelled", "fixture with alice owner should be cancelled");
      assert.strictEqual(task2.archived, true, "fixture should be archived");

      // Check board.json is patched
      const board = JSON.parse(readFileSync(join(t, ".ok", "board.json"), "utf-8"));
      const fix1Board = board.tasks.find((t: any) => t.id === "tsk-fix1");
      assert.strictEqual(fix1Board?.column, "backlog", "board column should be backlog");
      assert.strictEqual(fix1Board?.state, "cancelled", "board state should be cancelled");
      assert.strictEqual(fix1Board?.archived, true, "board archived should be true");

      // Check real task is untouched
      const realTask = JSON.parse(readFileSync(join(t, ".ok", "tasks", "tsk-real1.json"), "utf-8"));
      assert.strictEqual(realTask.status, "pending", "real task should be untouched");
      assert.ok(!realTask.archived, "real task should not be archived");

      const realBoard = board.tasks.find((t: any) => t.id === "tsk-real1");
      assert.strictEqual(realBoard?.column, "todo", "real task column should be untouched");
    });
  });

  describe("real task (not a fixture) passes through untouched", () => {
    const t = tmp();
    beforeEach(() => {
      writeTaskJson(t, "tsk-real1", "Real user task", "todd", "in_progress");
      writeTaskMdx(t, "tsk-real1", "Real user task", "todd", "in_progress");
      writeBoardJson(t, [
        { id: "tsk-real1", offlineMirrorId: "tsk-real1", title: "Real user task", column: "doing", state: "running", status: "running", archived: false },
      ]);
    });

    afterEach(() => {
      rmSync(t, { recursive: true, force: true });
    });

    it("real task is not affected by cleanup", async () => {
      const result = await runCleanupFixtures(t, ["--apply", "--yes"]);

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes("No fixture tasks found"), "should find no fixtures");

      // Verify real task is untouched
      const task = JSON.parse(readFileSync(join(t, ".ok", "tasks", "tsk-real1.json"), "utf-8"));
      assert.strictEqual(task.status, "in_progress", "real task should be untouched");
      assert.ok(!task.archived, "real task should not be archived");
    });
  });
});
