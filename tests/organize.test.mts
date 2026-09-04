// tests/organize.test.mts — unit tests for POST /api/organize

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, getBoard, setProjectRoot, type Task } from "../kanban/board.ts";
import { apiOrganize } from "../kanban/server.ts";
import { readEvents } from "../kanban/changelog.ts";

describe("organize", () => {
  let tmp: string;
  let task1Id: string;
  let task2Id: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    const ctx = {
      directory: tmp,
      client: null as any,
      log: async () => {},
    };
    await initBoard(ctx);
    setProjectRoot(tmp);

    const { withWrite } = await import("../kanban/board.ts");
    const now = new Date().toISOString();
    task1Id = "tsk-org1";
    task2Id = "tsk-org2";
    const tasks: Task[] = [
      { id: task1Id, title: "Task One", description: "Do the thing", column: "todo", order: 0, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: now, updatedAt: now, artifact: "tasks/tsk-org1/task.mdx", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "tasks/tsk-org1/task.mdx", commentsPath: "tasks/tsk-org1/comments.json", inputsPath: "tasks/tsk-org1/inputs.json", statePath: "tasks/tsk-org1/state.json" }, tags: ["frontend"], category: "frontend", priority: "normal", effort: null, archived: false } as Task,
      { id: task2Id, title: "Task Two", description: "Backend work", column: "backlog", order: 0, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: now, updatedAt: now, artifact: "tasks/tsk-org2/task.mdx", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "tasks/tsk-org2/task.mdx", commentsPath: "tasks/tsk-org2/comments.json", inputsPath: "tasks/tsk-org2/inputs.json", statePath: "tasks/tsk-org2/state.json" }, tags: [], category: "backend", priority: "high", effort: null, archived: false } as Task,
    ];
    await withWrite(async (board) => {
      board.tasks.push(...tasks);
    });

    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `organize-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("applies multiple operations and records one kanban.organized event", async () => {
    const ctx = await setupBoard();
    const req = new Request("http://localhost/api/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: [
          { kind: "move", taskId: task1Id, column: "doing" },
          { kind: "set-priority", taskId: task2Id, priority: "urgent" },
          { kind: "add-area", taskId: task1Id, area: "auth" },
        ],
      }),
    });

    const res = await apiOrganize(ctx as any, req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.applied.length, 3, `expected 3 applied, got ${JSON.stringify(json.applied)}`);
    assert.strictEqual(json.skipped.length, 0);
    assert.strictEqual(json.summary.moved, 1);
    assert.strictEqual(json.summary.retagged, 1); // add-area only; set-priority is not retagged

    // Verify kanban.organized changelog event was recorded
    const { events } = readEvents(join(tmp, ".ok"));
    const orgEvent = events.find(e => e.kind === "kanban.organized");
    assert.ok(orgEvent, "kanban.organized event should be recorded");
    assert.strictEqual(orgEvent.author, "user");
  });

  it("set-tags replaces tags (not merge)", async () => {
    const ctx = await setupBoard();
    const req = new Request("http://localhost/api/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: [
          { kind: "set-tags", taskId: task1Id, tags: ["docs", "refactor"] },
        ],
      }),
    });

    const res = await apiOrganize(ctx as any, req);
    const json = await res.json();
    assert.strictEqual(json.applied.length, 1);

    const board = await getBoard();
    const task = board.tasks.find(t => t.id === task1Id)!;
    assert.deepStrictEqual(task.tags, ["docs", "refactor"]);
    // category should be preserved (not overwritten by set-tags)
    assert.strictEqual(task.category, "frontend");
  });

  it("add-area adds area:<name> tag", async () => {
    const ctx = await setupBoard();
    const req = new Request("http://localhost/api/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: [
          { kind: "add-area", taskId: task2Id, area: "payments" },
        ],
      }),
    });

    const res = await apiOrganize(ctx as any, req);
    const json = await res.json();
    assert.strictEqual(json.applied.length, 1);

    const board = await getBoard();
    const task = board.tasks.find(t => t.id === task2Id)!;
    assert.ok(task.tags.includes("area:payments"));
  });

  it("invalid taskId goes to skipped", async () => {
    const ctx = await setupBoard();
    const req = new Request("http://localhost/api/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: [
          { kind: "move", taskId: "tsk-nonexistent", column: "doing" },
        ],
      }),
    });

    const res = await apiOrganize(ctx as any, req);
    const json = await res.json();
    assert.strictEqual(json.applied.length, 0);
    assert.strictEqual(json.skipped.length, 1);
    assert.strictEqual(json.skipped[0].reason, "Task not found");
  });

  it("archive operation sets archived=true", async () => {
    const ctx = await setupBoard();
    const req = new Request("http://localhost/api/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: [
          { kind: "archive", taskId: task1Id },
        ],
      }),
    });

    const res = await apiOrganize(ctx as any, req);
    const json = await res.json();
    assert.strictEqual(json.applied.length, 1);

    const board = await getBoard();
    const task = board.tasks.find(t => t.id === task1Id)!;
    assert.strictEqual(task.archived, true);
    assert.strictEqual(json.summary.archived, 1);
  });

  it("restore operation sets archived=false", async () => {
    const ctx = await setupBoard();
    // First archive via organize
    const { withWrite } = await import("../kanban/board.ts");
    await withWrite(async (board) => {
      const t = board.tasks.find(t => t.id === task1Id)!;
      t.archived = true;
    });

    const req = new Request("http://localhost/api/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operations: [
          { kind: "restore", taskId: task1Id },
        ],
      }),
    });

    const res = await apiOrganize(ctx as any, req);
    const json = await res.json();
    assert.strictEqual(json.applied.length, 1);

    const board = await getBoard();
    const task = board.tasks.find(t => t.id === task1Id)!;
    assert.strictEqual(task.archived, false);
  });
});
