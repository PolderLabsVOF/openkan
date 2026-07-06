// Tests for the GET /api/tasks/:id cleaner payload shape.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, type Task } from "../kanban/board.ts";
import { apiCreateTask, apiGetTask } from "../kanban/server.ts";

describe("task-payload", () => {
  let tmp: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".openkan", "tasks"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);
    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `task-payload-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  // ─── metadata field ───────────────────────────────────────────────────────

  it("GET /api/tasks/:id includes metadata.title equal to task.title", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My Test Task" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    assert.strictEqual(createRes.status, 201);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    assert.strictEqual(getRes.status, 200);
    const payload = await getRes.json();

    assert.ok("metadata" in payload, "payload should have metadata");
    assert.strictEqual(payload.metadata.title, payload.task.title);
    assert.strictEqual(payload.metadata.title, "My Test Task");
  });

  it("metadata.tags matches task.tags", async () => {
    const ctx = await setupBoard();
    // Pass empty description so extractMetadata doesn't add extra tags beyond the base 'task' tag
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tagged Task", description: "", tags: ["frontend", "bug"] }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    // extractMetadata derives ['task'] as base, then body.tags are unioned in
    assert.deepStrictEqual(payload.metadata.tags, payload.task.tags);
    assert.ok(payload.metadata.tags.includes("frontend"));
    assert.ok(payload.metadata.tags.includes("bug"));
  });

  it("metadata.category matches task.category", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Categorized Task", category: "backend" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    assert.strictEqual(payload.metadata.category, payload.task.category);
    assert.strictEqual(payload.metadata.category, "backend");
  });

  it("metadata.description is body text after stripping frontmatter", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Task With Body", description: "This is the body text." }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    assert.ok("description" in payload.metadata, "metadata should have description");
    assert.ok(payload.metadata.description.includes("This is the body text"));
  });

  it("metadata includes priority, effort, assignees, updatedAt, mtime", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Full Metadata Task", description: "" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    assert.ok("priority" in payload.metadata);
    assert.ok("effort" in payload.metadata);
    assert.ok("assignees" in payload.metadata);
    assert.ok("updatedAt" in payload.metadata);
    assert.ok("mtime" in payload.metadata);
    assert.strictEqual(payload.metadata.priority, payload.task.priority);
  });

  // ─── html alias ───────────────────────────────────────────────────────────

  it("payload includes html as alias for rendered HTML", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "HTML Task" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    assert.ok("html" in payload, "payload should have html field");
    assert.ok(typeof payload.html === "string");
    assert.ok(payload.html.includes("<h1"));
  });

  // ─── attributions ────────────────────────────────────────────────────────

  it("commits are returned as attributions (renamed from commits)", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Attribution Task" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    assert.ok("attributions" in payload, "payload should have attributions field");
    assert.ok(Array.isArray(payload.attributions));
  });

  // ─── retained fields ─────────────────────────────────────────────────────

  it("payload retains task, mdx, blocks, comments, inputs, subtasks fields", async () => {
    const ctx = await setupBoard();
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Retained Fields Task" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    const created = await createRes.json();

    const getRes = await apiGetTask(created.id);
    const payload = await getRes.json();

    assert.ok("task" in payload);
    assert.ok("mdx" in payload);
    assert.ok("blocks" in payload);
    assert.ok("comments" in payload);
    assert.ok("inputs" in payload);
    assert.ok("subtasks" in payload);
  });
});
