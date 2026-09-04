// tests/migration.test.mjs — unit tests for legacy task MDX migration

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, getBoard } from "../kanban/board.ts";

describe("migration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    mkdirSync(join(tmp, "web"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("migrates flat tasks/<id>.mdx → tasks/<id>/task.mdx", async () => {
    const taskId = "tsk-test123";
    const legacyContent = `---\ntitle: Test Task\nid: tsk-test123\n---\n\n# Test Task\n\nDescription here.`;

    // Create legacy flat MDX file
    const flatPath = join(tmp, ".ok", "tasks", `${taskId}.mdx`);
    writeFileSync(flatPath, legacyContent, "utf-8");

    // Create a minimal board.json with the task pointing to the legacy path
    const boardContent = {
      version: 1,
      columns: [
        { id: "backlog", title: "Backlog" },
        { id: "todo", title: "To Do" },
        { id: "doing", title: "In Progress" },
        { id: "review", title: "Review" },
        { id: "done", title: "Done" },
      ],
      tasks: [
        {
          id: taskId,
          title: "Test Task",
          description: "Description here.",
          column: "todo",
          order: 0,
          sessionId: null,
          agent: "",
          model: null,
          status: "idle",
          state: "idle",
          lastError: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          artifact: `tasks/${taskId}.mdx`,
          sessionArtifact: null,
          pendingInputs: [],
          artifacts: {
            mdxPath: `tasks/${taskId}/task.mdx`,
            commentsPath: `tasks/${taskId}/comments.json`,
            inputsPath: `tasks/${taskId}/inputs.json`,
            statePath: `tasks/${taskId}/state.json`,
          },
        },
      ],
      sessions: {},
    };
    writeFileSync(join(tmp, ".ok", "board.json"), JSON.stringify(boardContent), "utf-8");

    // Init board — should trigger migration
    const ctx = {
      directory: tmp,
      client: null as any,
      log: async () => {},
    };
    const { board } = await initBoard(ctx);

    // Check: flat file should be gone
    assert.ok(!existsSync(flatPath), "legacy flat file should be removed");

    // Check: per-task task.mdx should exist
    const newPath = join(tmp, ".ok", "tasks", taskId, "task.mdx");
    assert.ok(existsSync(newPath), "new per-task MDX should exist");
    const newContent = readFileSync(newPath, "utf-8");
    assert.ok(newContent.includes("Test Task"), "content should be preserved");

    // Check: task.artifact should be updated to new layout
    const migratedTask = board.tasks.find(t => t.id === taskId);
    assert.ok(migratedTask);
    assert.strictEqual(migratedTask!.artifact, `tasks/${taskId}/task.mdx`);
  });

  it("is idempotent: calling initBoard twice doesn't break", async () => {
    const taskId = "tsk-idempotent";
    mkdirSync(join(tmp, ".ok", "tasks", taskId), { recursive: true });
    writeFileSync(join(tmp, ".ok", "tasks", taskId, "task.mdx"), "# Already migrated\n", "utf-8");

    const boardContent = {
      version: 1,
      columns: [{ id: "backlog", title: "Backlog" }, { id: "todo", title: "To Do" }, { id: "doing", title: "In Progress" }, { id: "review", title: "Review" }, { id: "done", title: "Done" }],
      tasks: [
        {
          id: taskId, title: "Already", description: "", column: "todo", order: 0,
          sessionId: null, agent: "", model: null, status: "idle", state: "idle",
          lastError: null, createdAt: now(), updatedAt: now(), artifact: `tasks/${taskId}/task.mdx`,
          sessionArtifact: null, pendingInputs: [], artifacts: {
            mdxPath: `tasks/${taskId}/task.mdx`,
            commentsPath: `tasks/${taskId}/comments.json`,
            inputsPath: `tasks/${taskId}/inputs.json`,
            statePath: `tasks/${taskId}/state.json`,
          },
        },
      ],
      sessions: {},
    };
    writeFileSync(join(tmp, ".ok", "board.json"), JSON.stringify(boardContent), "utf-8");

    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    const { board: b1 } = await initBoard(ctx);
    const { board: b2 } = await initBoard(ctx);

    assert.strictEqual(b1.tasks.length, b2.tasks.length);
    assert.strictEqual(b1.tasks[0].artifact, `tasks/${taskId}/task.mdx`);
  });
});

function now() { return new Date().toISOString(); }
