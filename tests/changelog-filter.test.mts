// tests/changelog-filter.test.mts — unit tests for completedOnly changelog filter

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, type Task } from "../kanban/board.ts";
import { apiGetChangelog } from "../kanban/server.ts";
import { recordEvent, COMPLETION_KINDS } from "../kanban/changelog.ts";

describe("changelog — completedOnly filter", () => {
  let tmp: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);

    const { withWrite } = await import("../kanban/board.ts");
    const now = new Date().toISOString();

    // Create a task in "done" column
    const doneTask: Task = {
      id: "tsk-done1",
      title: "Done Task",
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
      artifact: "tasks/tsk-done1/task.mdx",
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-done1/task.mdx", commentsPath: "tasks/tsk-done1/comments.json", inputsPath: "tasks/tsk-done1/inputs.json", statePath: "tasks/tsk-done1/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    };

    // Create a task in "todo" column
    const todoTask: Task = {
      id: "tsk-todo1",
      title: "Todo Task",
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
      artifact: "tasks/tsk-todo1/task.mdx",
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-todo1/task.mdx", commentsPath: "tasks/tsk-todo1/comments.json", inputsPath: "tasks/tsk-todo1/inputs.json", statePath: "tasks/tsk-todo1/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    };

    await withWrite(async (board) => {
      board.tasks.push(doneTask, todoTask);
    });

    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `changelog-filter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("completedOnly=true returns only done-column events and terminal kinds", async () => {
    const ctx = await setupBoard();

    // Record events for both tasks
    recordEvent(join(tmp, ".ok"), "task.updated", { taskId: "tsk-done1", author: "user", summary: "done task updated", payload: {} });
    recordEvent(join(tmp, ".ok"), "task.updated", { taskId: "tsk-todo1", author: "user", summary: "todo task updated", payload: {} });
    recordEvent(join(tmp, ".ok"), "task.archived", { taskId: "tsk-done1", author: "user", summary: "archived done task", payload: {} });
    recordEvent(join(tmp, ".ok"), "kanban.organized", { author: "user", summary: "organized", payload: {} });

    const req = new Request("http://localhost/api/changelog?completedOnly=true", { method: "GET" });
    const res = await apiGetChangelog(req);
    assert.strictEqual(res.status, 200);
    const { events } = await res.json();

    // Should include the done task updated event
    assert.ok(events.some(e => e.taskId === "tsk-done1" && e.summary === "done task updated"), "done-column event should be included");
    // Should include task.archived (terminal kind)
    assert.ok(events.some(e => e.kind === "task.archived"), "task.archived should be included");
    // Should include kanban.organized (terminal kind)
    assert.ok(events.some(e => e.kind === "kanban.organized"), "kanban.organized should be included");
    // Should NOT include the todo-column event
    assert.ok(!events.some(e => e.taskId === "tsk-todo1" && e.summary === "todo task updated"), "todo-column event should NOT be included");
  });

  it("default behavior (no completedOnly) returns all events", async () => {
    const ctx = await setupBoard();

    recordEvent(join(tmp, ".ok"), "task.updated", { taskId: "tsk-done1", author: "user", summary: "done task updated", payload: {} });
    recordEvent(join(tmp, ".ok"), "task.updated", { taskId: "tsk-todo1", author: "user", summary: "todo task updated", payload: {} });

    const req = new Request("http://localhost/api/changelog", { method: "GET" });
    const res = await apiGetChangelog(req);
    assert.strictEqual(res.status, 200);
    const { events } = await res.json();

    assert.ok(events.some(e => e.taskId === "tsk-done1"), "done task event should be present");
    assert.ok(events.some(e => e.taskId === "tsk-todo1"), "todo task event should be present");
    assert.strictEqual(events.length, 2);
  });

  it("completedOnly=false same as default", async () => {
    const ctx = await setupBoard();

    recordEvent(join(tmp, ".ok"), "task.updated", { taskId: "tsk-todo1", author: "user", summary: "todo updated", payload: {} });

    const req = new Request("http://localhost/api/changelog?completedOnly=false", { method: "GET" });
    const res = await apiGetChangelog(req);
    assert.strictEqual(res.status, 200);
    const { events } = await res.json();
    assert.ok(events.some(e => e.taskId === "tsk-todo1"));
  });

  it("task.deleted is always included via terminal kinds", async () => {
    const ctx = await setupBoard();
    recordEvent(join(tmp, ".ok"), "task.deleted", { taskId: "tsk-todo1", author: "user", summary: "deleted todo task", payload: {} });

    const req = new Request("http://localhost/api/changelog?completedOnly=true", { method: "GET" });
    const res = await apiGetChangelog(req);
    assert.strictEqual(res.status, 200);
    const { events } = await res.json();
    assert.ok(events.some(e => e.kind === "task.deleted"), "task.deleted should be included even for non-done task");
  });

  it("agent.ended is included via terminal kinds", async () => {
    const ctx = await setupBoard();
    recordEvent(join(tmp, ".ok"), "agent.ended", { taskId: "tsk-todo1", author: "agent", summary: "agent ended", payload: {} });

    const req = new Request("http://localhost/api/changelog?completedOnly=true", { method: "GET" });
    const res = await apiGetChangelog(req);
    assert.strictEqual(res.status, 200);
    const { events } = await res.json();
    assert.ok(events.some(e => e.kind === "agent.ended"), "agent.ended should be included via terminal kinds");
  });
});
