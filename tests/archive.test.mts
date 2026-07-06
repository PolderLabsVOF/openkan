// tests/archive.test.mts — unit tests for kanban/archive.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, getBoard, renormalizeOrder, setProjectRoot, type Task } from "../kanban/board.ts";
import { archiveTask, restoreTask } from "../kanban/archive.ts";
import { readEvents } from "../kanban/changelog.ts";
import { writeTaskMdx } from "../kanban/mdx.ts";

describe("archive", () => {
  let tmp: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".openkan", "tasks"), { recursive: true });
    const ctx = {
      directory: tmp,
      client: null as any,
      log: async () => {},
    };
    await initBoard(ctx);
    setProjectRoot(tmp);
    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("archiveTask sets archived=true and records event", async () => {
    const ctx = await setupBoard();
    // Add a task directly to the board
    const now = new Date().toISOString();
    const task: Task = {
      id: "tsk-test1",
      title: "Test Task",
      description: "",
      column: "todo",
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "idle",
      state: "idle",
      lastError: null,
      createdAt: now,
      updatedAt: now,
      artifact: "tasks/tsk-test1/task.mdx",
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-test1/task.mdx", commentsPath: "tasks/tsk-test1/comments.json", inputsPath: "tasks/tsk-test1/inputs.json", statePath: "tasks/tsk-test1/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
    };

    await ctx; // suppress unused warning
    const { withWrite: ww, getBoard: gb } = await import("../kanban/board.ts");
    await ww(async (board) => {
      board.tasks.push(task);
    });

    const updated = await archiveTask(task, join(tmp, ".openkan"), "alice");
    assert.strictEqual(updated.archived, true);

    // Verify persisted in board.json
    const board = await gb();
    const found = board.tasks.find(t => t.id === "tsk-test1");
    assert.strictEqual(found!.archived, true);

    // Verify changelog event was recorded
    const { events } = readEvents(join(tmp, ".openkan"));
    assert.ok(events.some(e => e.kind === "task.archived" && e.taskId === "tsk-test1"));
  });

  it("restoreTask sets archived=false and records event", async () => {
    const ctx = await setupBoard();
    const now = new Date().toISOString();
    const task: Task = {
      id: "tsk-test2",
      title: "Archived Task",
      description: "",
      column: "done",
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "idle",
      state: "idle",
      lastError: null,
      createdAt: now,
      updatedAt: now,
      artifact: "tasks/tsk-test2/task.mdx",
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-test2/task.mdx", commentsPath: "tasks/tsk-test2/comments.json", inputsPath: "tasks/tsk-test2/inputs.json", statePath: "tasks/tsk-test2/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: true,
    };

    await ctx;
    const { withWrite: ww, getBoard: gb } = await import("../kanban/board.ts");
    await ww(async (board) => {
      board.tasks.push(task);
    });

    const updated = await restoreTask(task, join(tmp, ".openkan"), "bob");
    assert.strictEqual(updated.archived, false);

    const board = await gb();
    const found = board.tasks.find(t => t.id === "tsk-test2");
    assert.strictEqual(found!.archived, false);

    const { events } = readEvents(join(tmp, ".openkan"));
    assert.ok(events.some(e => e.kind === "task.restored" && e.taskId === "tsk-test2"));
  });

  describe("renormalizeOrder", () => {
    it("skips archived tasks during renumbering", () => {
      const tasks: Task[] = [
        { id: "t1", title: "A", description: "", column: "todo", order: 0, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: "", updatedAt: "", artifact: "", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" }, tags: [], category: "task", priority: "normal", effort: null, archived: false } as Task,
        { id: "t2", title: "B", description: "", column: "todo", order: 1, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: "", updatedAt: "", artifact: "", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" }, tags: [], category: "task", priority: "normal", effort: null, archived: true } as Task,
        { id: "t3", title: "C", description: "", column: "todo", order: 2, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: "", updatedAt: "", artifact: "", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" }, tags: [], category: "task", priority: "normal", effort: null, archived: false } as Task,
      ];
      const result = renormalizeOrder(tasks);
      // Active tasks get renumbered: A=0, C=1; archived B retains its order
      assert.strictEqual(result.find(t => t.id === "t1")!.order, 0);
      assert.strictEqual(result.find(t => t.id === "t3")!.order, 1);
      assert.strictEqual(result.find(t => t.id === "t2")!.order, 1); // retained
    });
  });
});
