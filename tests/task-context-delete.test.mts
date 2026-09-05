// tests/task-context-delete.test.mts — regression test for tsk-LxeIjucy:
// deleting a task from the per-card right-click context menu (or the
// per-card three-dot menu) must actually remove it from the server.
//
// The bug: `deleteWithUndo` in web/app.js optimistically removed the
// task from the local `tasks` map and rendered, but it never called
// DELETE /api/tasks/:id. The next board.snapshot pulled the task right
// back from the server, so the user saw the menu action "no-op".
// This file pins both halves of the fix:
//   1. Source-level: the client must call DELETE on the server after
//      the optimistic remove, and must restore from snapshot on error.
//   2. API-level: the server's delete endpoint actually removes the
//      task from the board so the next snapshot stays clean.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initBoard, setProjectRoot, getBoard, KANBAN_DIR, type Task } from "../kanban/board.ts";
import {
  apiCreateTask,
  apiDeleteTask,
  apiGetTask,
} from "../kanban/server.ts";

const APP_JS = readFileSync("web/app.js", "utf-8");

describe("deleteWithUndo (web/app.js) — context-menu DELETE wiring", () => {
  it("sends DELETE /api/tasks/:id after the optimistic local remove", () => {
    // Find the function body and assert it actually talks to the server.
    const m = APP_JS.match(/function deleteWithUndo\(task\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(m, "expected deleteWithUndo function in web/app.js");
    const body = m![0];
    assert.match(
      body,
      /api\(\s*["']DELETE["']\s*,\s*`\/api\/tasks\/\$\{task\.id\}`\s*\)/,
      `deleteWithUndo must call api("DELETE", /api/tasks/{task.id}); got:\n${body}`,
    );
  });

  it("rolls back the optimistic remove if the DELETE request rejects", () => {
    const m = APP_JS.match(/function deleteWithUndo\(task\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(m, "expected deleteWithUndo function in web/app.js");
    const body = m![0];
    // The .then(..., onError) branch must restore the snapshot and re-render.
    assert.match(
      body,
      /tasks\.set\(\s*snapshot\.id\s*,\s*snapshot\s*\)/,
      "deleteWithUndo error path must restore the task from snapshot",
    );
    assert.match(
      body,
      /Delete failed:/,
      "deleteWithUndo error path must surface a Delete failed toast",
    );
  });

  it("clears the task from selectedIds so the bulk tray doesn't keep a ghost reference", () => {
    // Stale selectedIds entries used to leak across deletes and made the
    // bulk Delete button stay enabled with a count > 0 of "missing" tasks.
    const m = APP_JS.match(/function deleteWithUndo\(task\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(m, "expected deleteWithUndo function in web/app.js");
    assert.match(
      m![0],
      /selectedIds\.delete\(\s*task\.id\s*\)/,
      "deleteWithUndo must drop the task id from selectedIds",
    );
  });

  it("is wired into both the right-click per-card menu and the three-dot ⋯ menu", () => {
    // Both code paths must funnel into deleteWithUndo — otherwise the
    // user reports one menu "doesn't work" while the other does.
    const cardMenuMatch = APP_JS.match(/label:\s*["']Delete["'][\s\S]{0,200}?deleteWithUndo\(task\)/);
    assert.ok(cardMenuMatch, "per-card context menu 'Delete' entry must call deleteWithUndo(task)");
    const buttonMenuMatch = APP_JS.match(/run\(\s*["']Delete["']\s*,\s*\(\)\s*=>\s*deleteWithUndo\(task\)\s*,\s*true\s*\)/);
    assert.ok(buttonMenuMatch, "three-dot menu 'Delete' entry must call deleteWithUndo(task)");
  });
});

describe("DELETE /api/tasks/:id — server contract relied on by the menu fix", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `task-delete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("removes the task from the board so the next snapshot stays clean", async () => {
    const ctx = { directory: tmp, client: null as any, log: async () => {} };

    // Create one task via the same endpoint the client POSTs to.
    const createReq = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Delete me from the context menu" }),
    });
    const createRes = await apiCreateTask(ctx as any, createReq);
    assert.strictEqual(createRes.status, 201);
    const created = (await createRes.json()) as Task;
    assert.ok(created.id, "create response must include an id");

    // Board initially contains the task.
    let board = await getBoard();
    assert.ok(
      board.tasks.some((t) => t.id === created.id),
      "task should be present in the board right after create",
    );

    // The same DELETE call the new client wiring makes.
    const delRes = await apiDeleteTask(ctx as any, created.id);
    assert.strictEqual(delRes.status, 200, "DELETE should return 200 OK");

    // Board no longer contains the task — this is the invariant the fix
    // depends on. Without it the menu action looks like a no-op.
    board = await getBoard();
    assert.ok(
      !board.tasks.some((t) => t.id === created.id),
      "task should be removed from the board after DELETE",
    );

    // And the per-task directory was actually removed from disk — the
    // /api/tasks/:id endpoint should also be able to confirm.
    const taskDir = join(tmp, ".ok", "tasks", created.id);
    assert.ok(!existsSync(taskDir), "task directory should be cleaned up");
    const getRes = await apiGetTask(created.id);
    assert.strictEqual(getRes.status, 404, "GET /api/tasks/:id should 404 after delete");
  });

  it("returns 404 when deleting a task that does not exist", async () => {
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    const delRes = await apiDeleteTask(ctx as any, "tsk-does-not-exist");
    assert.strictEqual(delRes.status, 404, "deleting a missing task must 404");
  });
});
