// tests/stale-patch.test.mts — tests for stale field in PATCH /api/tasks/:id
// and POST /api/tasks/recheck-stale endpoint

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, withWrite, type Task } from "../kanban/board.ts";
import { apiUpdateTask, apiRecheckStale } from "../kanban/server.ts";

function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("stale field in PATCH /api/tasks/:id", () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = join(tmpdir(), `stale-patch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);

    // Seed a task
    const now = new Date().toISOString();
    const task: Task = {
      id: "tsk-stale1",
      title: "Stale Test Task",
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
      artifact: "tasks/tsk-stale1/task.mdx",
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-stale1/task.mdx", commentsPath: "tasks/tsk-stale1/comments.json", inputsPath: "tasks/tsk-stale1/inputs.json", statePath: "tasks/tsk-stale1/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
      stale: false,
    };
    await withWrite(async (b) => { b.tasks.push(task); });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("PATCH accepts stale: true and persists it", async () => {
    const req = new Request("http://localhost/api/tasks/tsk-stale1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stale: true }),
    });
    const res = await apiUpdateTask(ctx, "tsk-stale1", req);
    assert.strictEqual(res.status, 200);
    const updated = (await getBoard()).tasks.find(t => t.id === "tsk-stale1");
    assert.strictEqual(updated?.stale, true);
  });

  it("PATCH accepts stale: false and clears it", async () => {
    // First set it to true
    await withWrite(async (b) => {
      const t = b.tasks.find(t => t.id === "tsk-stale1");
      if (t) t.stale = true;
    });

    const req = new Request("http://localhost/api/tasks/tsk-stale1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stale: false }),
    });
    const res = await apiUpdateTask(ctx, "tsk-stale1", req);
    assert.strictEqual(res.status, 200);
    const updated = (await getBoard()).tasks.find(t => t.id === "tsk-stale1");
    assert.strictEqual(updated?.stale, false);
  });

  it("PATCH stale: false on a task already false is a no-op", async () => {
    const req = new Request("http://localhost/api/tasks/tsk-stale1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stale: false }),
    });
    const res = await apiUpdateTask(ctx, "tsk-stale1", req);
    assert.strictEqual(res.status, 200);
    const updated = (await getBoard()).tasks.find(t => t.id === "tsk-stale1");
    assert.strictEqual(updated?.stale, false);
  });
});

// Import getBoard for use in assertions
import { getBoard } from "../kanban/board.ts";

describe("POST /api/tasks/recheck-stale", () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = join(tmpdir(), `recheck-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("returns { stale: false, sourceHash: \"\" } when task has no source", async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: "tsk-nosrc",
      title: "No Source Task",
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
      artifact: "tasks/tsk-nosrc/task.mdx",
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-nosrc/task.mdx", commentsPath: "tasks/tsk-nosrc/comments.json", inputsPath: "tasks/tsk-nosrc/inputs.json", statePath: "tasks/tsk-nosrc/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
      stale: false,
    };
    await withWrite(async (b) => { b.tasks.push(task); });

    const req = new Request("http://localhost/api/tasks/recheck-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "tsk-nosrc" }),
    });
    const res = await apiRecheckStale(ctx, req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.stale, false);
    assert.strictEqual(body.sourceHash, "");
  });

  it("returns { stale: false, sourceHash: hash } when source file is unchanged", async () => {
    const sourceFile = join(tmp, "docs", "roadmap.mdx");
    writeFileSync(sourceFile, "- [ ] Fix the bug\n", "utf-8");
    const content = readFileSync(sourceFile, "utf-8");
    const hash = computeHash(content);

    const now = new Date().toISOString();
    const task: Task = {
      id: "tsk-unchanged",
      title: "Unchanged Source Task",
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
      artifact: "tasks/tsk-unchanged/task.mdx",
      sessionArtifact: null,
      source: { path: "docs/roadmap.mdx", line: 1, slug: "docs/roadmap.mdx" },
      sourceHash: hash,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-unchanged/task.mdx", commentsPath: "tasks/tsk-unchanged/comments.json", inputsPath: "tasks/tsk-unchanged/inputs.json", statePath: "tasks/tsk-unchanged/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
      stale: false,
    };
    await withWrite(async (b) => { b.tasks.push(task); });

    const req = new Request("http://localhost/api/tasks/recheck-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "tsk-unchanged" }),
    });
    const res = await apiRecheckStale(ctx, req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.stale, false);
    assert.strictEqual(body.sourceHash, hash);
  });

  it("returns { stale: true, sourceHash: newHash } and updates the task when source changed", async () => {
    const sourceFile = join(tmp, "docs", "roadmap.mdx");
    const originalContent = "- [ ] Fix the bug\n";
    writeFileSync(sourceFile, originalContent, "utf-8");
    const originalHash = computeHash(originalContent);

    const now = new Date().toISOString();
    const task: Task = {
      id: "tsk-changed",
      title: "Changed Source Task",
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
      artifact: "tasks/tsk-changed/task.mdx",
      sessionArtifact: null,
      source: { path: "docs/roadmap.mdx", line: 1, slug: "docs/roadmap.mdx" },
      sourceHash: originalHash,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-changed/task.mdx", commentsPath: "tasks/tsk-changed/comments.json", inputsPath: "tasks/tsk-changed/inputs.json", statePath: "tasks/tsk-changed/state.json" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
      stale: false,
    };
    await withWrite(async (b) => { b.tasks.push(task); });

    // Modify the source file
    writeFileSync(sourceFile, "- [ ] Fix the bug\n- [ ] Also fix this\n", "utf-8");

    const req = new Request("http://localhost/api/tasks/recheck-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "tsk-changed" }),
    });
    const res = await apiRecheckStale(ctx, req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.stale, true);
    assert.notStrictEqual(body.sourceHash, originalHash);

    // Verify the task was updated in board
    const updated = (await getBoard()).tasks.find(t => t.id === "tsk-changed");
    assert.strictEqual(updated?.stale, true);
  });

  it("returns 404 for unknown taskId", async () => {
    const req = new Request("http://localhost/api/tasks/recheck-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "tsk-nonexistent" }),
    });
    const res = await apiRecheckStale(ctx, req);
    assert.strictEqual(res.status, 404);
  });

  it("returns 422 when taskId is missing", async () => {
    const req = new Request("http://localhost/api/tasks/recheck-stale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await apiRecheckStale(ctx, req);
    assert.strictEqual(res.status, 422);
  });
});

import { readFileSync } from "node:fs";
