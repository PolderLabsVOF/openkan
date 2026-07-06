// tests/subtasks.test.mts — unit tests for subtask support

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, type Task } from "../kanban/board.ts";
import { apiCreateTask, apiUpdateTask, apiArchiveTask, apiRestoreTask, apiDeleteTask, apiGetSubtasks, apiGetTask } from "../kanban/server.ts";
import { readEvents } from "../kanban/changelog.ts";

describe("subtasks", () => {
  let tmp: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".openkan", "tasks"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);
    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `subtask-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("creates a child with parentId and parent's subtaskIds is updated", async () => {
    const ctx = await setupBoard();

    // Create parent task
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    assert.strictEqual(parentRes.status, 201);
    const parent = await parentRes.json();
    const parentId = parent.id;

    // Create child with parentId
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    assert.strictEqual(childRes.status, 201);
    const child = await childRes.json();

    // Verify parent's subtaskIds includes the child
    const getRes = await apiGetTask(parentId);
    const getJson = await getRes.json();
    assert.ok(getJson.task.subtaskIds.includes(child.id), `expected ${child.id} in subtaskIds, got ${JSON.stringify(getJson.task.subtaskIds)}`);
    assert.strictEqual(child.parentId, parentId);
  });

  it("creating a grandchild fails with 422 (no transitive nesting)", async () => {
    const ctx = await setupBoard();

    // Create parent
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    const parent = await parentRes.json();

    // Create child
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId: parent.id }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    const child = await childRes.json();

    // Try to create grandchild — should fail
    const grandchildReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Grandchild Task", parentId: child.id }),
    });
    const grandchildRes = await apiCreateTask(ctx as any, grandchildReq);
    assert.strictEqual(grandchildRes.status, 422);
    const json = await grandchildRes.json();
    assert.ok(json.error.toLowerCase().includes("subtask") || json.error.toLowerCase().includes("nest"));
  });

  it("archive parent cascades archive to subtasks", async () => {
    const ctx = await setupBoard();

    // Create parent
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    const parent = await parentRes.json();

    // Create child
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId: parent.id }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    const child = await childRes.json();

    // Archive parent
    const archiveRes = await apiArchiveTask(ctx as any, parent.id);
    assert.strictEqual(archiveRes.status, 200);

    // Verify child is also archived
    const getRes = await apiGetTask(child.id);
    const getJson = await getRes.json();
    assert.strictEqual(getJson.task.archived, true, "subtask should be archived with parent");
  });

  it("restore parent cascades restore to subtasks", async () => {
    const ctx = await setupBoard();

    // Create parent
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    const parent = await parentRes.json();

    // Create child
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId: parent.id }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    const child = await childRes.json();

    // Archive parent (which archives child)
    await apiArchiveTask(ctx as any, parent.id);

    // Restore parent
    const restoreRes = await apiRestoreTask(ctx as any, parent.id);
    assert.strictEqual(restoreRes.status, 200);

    // Verify child is also restored
    const getRes = await apiGetTask(child.id);
    const getJson = await getRes.json();
    assert.strictEqual(getJson.task.archived, false, "subtask should be restored with parent");
  });

  it("delete parent cascades delete to subtask directories", async () => {
    const ctx = await setupBoard();

    // Create parent
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    const parent = await parentRes.json();

    // Create child
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId: parent.id }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    const child = await childRes.json();

    // Delete parent
    const deleteRes = await apiDeleteTask(ctx as any, parent.id);
    assert.strictEqual(deleteRes.status, 200);

    // Verify child directory is gone
    const childDir = join(tmp, ".openkan", "tasks", child.id);
    assert.ok(!existsSync(childDir), "subtask directory should be deleted with parent");
  });

  it("GET /api/tasks/:id/subtasks returns the children", async () => {
    const ctx = await setupBoard();

    // Create parent
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    const parent = await parentRes.json();

    // Create two children
    for (const title of ["Child One", "Child Two"]) {
      const childReq = new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, parentId: parent.id }),
      });
      await apiCreateTask(ctx as any, childReq);
    }

    // Fetch subtasks
    const subtasksRes = await apiGetSubtasks(parent.id);
    assert.strictEqual(subtasksRes.status, 200);
    const { subtasks } = await subtasksRes.json();
    assert.strictEqual(subtasks.length, 2, `expected 2 subtasks, got ${subtasks.length}`);
    const titles = subtasks.map((t: Task) => t.title);
    assert.ok(titles.includes("Child One"));
    assert.ok(titles.includes("Child Two"));
  });

  it("PATCH parentId to re-parent a subtask", async () => {
    const ctx = await setupBoard();

    // Create two parents
    const p1Req = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent 1" }),
    });
    const p1Res = await apiCreateTask(ctx as any, p1Req);
    const p1 = await p1Res.json();

    const p2Req = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent 2" }),
    });
    const p2Res = await apiCreateTask(ctx as any, p2Req);
    const p2 = await p2Res.json();

    // Create child under p1
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId: p1.id }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    const child = await childRes.json();

    // Verify child is under p1
    let p1Get = await apiGetTask(p1.id);
    let p1Json = await p1Get.json();
    assert.ok(p1Json.task.subtaskIds.includes(child.id));

    // Re-parent child to p2
    const patchReq = new Request(`http://localhost/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: p2.id }),
    });
    const patchRes = await apiUpdateTask(ctx as any, child.id, patchReq);
    assert.strictEqual(patchRes.status, 200);

    // Verify child is now under p2
    let p2Get = await apiGetTask(p2.id);
    let p2Json = await p2Get.json();
    assert.ok(p2Json.task.subtaskIds.includes(child.id), "child should now be under p2");

    // Verify p1 no longer has child
    p1Get = await apiGetTask(p1.id);
    p1Json = await p1Get.json();
    assert.ok(!p1Json.task.subtaskIds.includes(child.id), "child should no longer be under p1");
  });

  it("PATCH parentId to null un-parents a subtask", async () => {
    const ctx = await setupBoard();

    // Create parent
    const parentReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parent Task" }),
    });
    const parentRes = await apiCreateTask(ctx as any, parentReq);
    const parent = await parentRes.json();

    // Create child
    const childReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child Task", parentId: parent.id }),
    });
    const childRes = await apiCreateTask(ctx as any, childReq);
    const child = await childRes.json();

    // Un-parent child
    const patchReq = new Request(`http://localhost/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: null }),
    });
    const patchRes = await apiUpdateTask(ctx as any, child.id, patchReq);
    assert.strictEqual(patchRes.status, 200);

    // Verify child's parentId is null
    const getRes = await apiGetTask(child.id);
    const getJson = await getRes.json();
    assert.strictEqual(getJson.task.parentId, null, "parentId should be null after un-parenting");
  });
});
