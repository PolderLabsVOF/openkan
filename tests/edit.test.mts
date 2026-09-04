// tests/edit.test.mts — unit tests for PATCH /api/tasks/:id edit support

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, type Task } from "../kanban/board.ts";
import { apiUpdateTask } from "../kanban/server.ts";
import { readEvents } from "../kanban/changelog.ts";
import { readFileSync } from "node:fs";

describe("PATCH /api/tasks/:id — edit support", () => {
  let tmp: string;
  let taskId: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);

    const { withWrite } = await import("../kanban/board.ts");
    const now = new Date().toISOString();
    taskId = "tsk-edit1";
    const task: Task = {
      id: taskId,
      title: "Original Title",
      description: "Original description",
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
      artifact: `tasks/${taskId}/task.mdx`,
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: `tasks/${taskId}/task.mdx`, commentsPath: `tasks/${taskId}/comments.json`, inputsPath: `tasks/${taskId}/inputs.json`, statePath: `tasks/${taskId}/state.json` },
      tags: ["frontend"],
      category: "frontend",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    };
    await withWrite(async (board) => { board.tasks.push(task); });
    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `edit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("PATCH with new title updates title and re-derives tags/category", async () => {
    const ctx = await setupBoard();
    const req = new Request(`http://localhost/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Backend server route handler" }),
    });
    const res = await apiUpdateTask(ctx as any, taskId, req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.title, "Backend server route handler");
    // "server" / "route" in title should re-derive category to "backend"
    assert.strictEqual(json.category, "backend");
    // Re-derivation should update tags
    assert.ok(json.tags.includes("backend") || json.tags.includes("refactor"), `expected backend/refactor tag, got ${JSON.stringify(json.tags)}`);
  });

  it("PATCH with empty title returns 422", async () => {
    const ctx = await setupBoard();
    const req = new Request(`http://localhost/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    const res = await apiUpdateTask(ctx as any, taskId, req);
    assert.strictEqual(res.status, 422);
    const json = await res.json();
    assert.ok(json.error.toLowerCase().includes("title") || json.error.toLowerCase().includes("empty"));
  });

  it("PATCH with new description triggers MDX re-write", async () => {
    const ctx = await setupBoard();
    const req = new Request(`http://localhost/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "New description content" }),
    });
    const res = await apiUpdateTask(ctx as any, taskId, req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.description, "New description content");

    // Verify MDX file was updated on disk
    const mdxPath = join(tmp, ".ok", "tasks", taskId, "task.mdx");
    const content = readFileSync(mdxPath, "utf-8");
    assert.ok(content.includes("New description content"), "MDX should contain new description");
  });

  it("PATCH with both title and description works", async () => {
    const ctx = await setupBoard();
    const req = new Request(`http://localhost/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Updated Title",
        description: "Updated description",
      }),
    });
    const res = await apiUpdateTask(ctx as any, taskId, req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.title, "Updated Title");
    assert.strictEqual(json.description, "Updated description");
  });

  it("PATCH records a task.updated changelog event with edited summary", async () => {
    const ctx = await setupBoard();
    const req = new Request(`http://localhost/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Edited Title" }),
    });
    await apiUpdateTask(ctx as any, taskId, req);
    const { events } = readEvents(join(tmp, ".ok"));
    const editEvent = events.find(e => e.kind === "task.updated" && e.taskId === taskId);
    assert.ok(editEvent, "task.updated event should be recorded");
    assert.ok(editEvent.summary.includes("edited"), `expected "edited" in summary, got "${editEvent.summary}"`);
  });
});
