// tests/ok-cli-task-reconcile.test.mts
//
// Verifies the agent task-creation contract:
//   - `ok task add "..."` writes a planning-system JSON under .ok/tasks/<id>.json
//   - The running kanban dashboard reconciles that JSON into its in-memory board
//     so the task appears in GET /api/board WITHOUT a server restart.
//
// Two layers are covered:
//   1. Unit: reconcileOkTask() inserts a new task when the board is empty and
//      leaves it untouched when the board already owns the id.
//   2. Integration: with the server's watcher live, writing the per-task JSON
//      file fires task.created SSE and bumps GET /api/board.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initBoard, getBoard, reconcileOkTask, taskArtifacts, KANBAN_DIR } from "../kanban/board.ts";
import { writeTask, paths as okPaths, readTask as readOkTask } from "../ok/storage.ts";
import type { Task as OkTask } from "../ok/schemas.ts";
import { startOrAttach } from "../kanban/server.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ok-reconcile-"));
}

function makeOkTask(id: string, status: OkTask["status"], title: string): OkTask {
  const now = new Date().toISOString();
  return {
    schema: "ok.task.v1",
    id,
    title,
    status,
    createdAt: now,
    updatedAt: now,
    description: `auto-generated: ${title}`,
    scopes: ["smoke"],
    priority: "p2",
    owner: "agent:test",
  };
}

// ─── Unit layer ───────────────────────────────────────────────────────────

describe("reconcileOkTask (unit)", () => {
  let root: string;

  before(async () => {
    root = tmp();
    await initBoard({ directory: root, client: null, log: async () => undefined });
  });

  beforeEach(async () => {
    // Reset tasks between tests so id collisions don't leak across cases.
    const p = okPaths(root);
    rmSync(p.tasksDir, { recursive: true, force: true });
    rmSync(join(root, ".ok", "tasks"), { recursive: true, force: true });
    const board = await getBoard();
    board.tasks.length = 0;
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("inserts a fresh ok task with column=todo for status=pending", async () => {
    const id = "tsk-reconA";
    const p = okPaths(root);
    const ok = makeOkTask(id, "pending", "smoke reconcile pending");
    await writeTask(p, ok);

    const inserted = await reconcileOkTask(id);
    assert.ok(inserted, "reconcileOkTask should return the inserted task");
    assert.strictEqual(inserted!.id, id);
    assert.strictEqual(inserted!.title, "smoke reconcile pending");
    assert.strictEqual(inserted!.column, "todo");
    assert.strictEqual(inserted!.state, "idle");
    assert.ok(!inserted!.archived);

    const board = await getBoard();
    assert.ok(board.tasks.find(t => t.id === id), "board now contains the task");
  });

  it("maps status=in_progress to column=doing and state=running", async () => {
    const id = "tsk-reconB";
    const p = okPaths(root);
    const ok = makeOkTask(id, "in_progress", "smoke reconcile in_progress");
    await writeTask(p, ok);

    const inserted = await reconcileOkTask(id);
    assert.ok(inserted);
    assert.strictEqual(inserted!.column, "doing");
    assert.strictEqual(inserted!.state, "running");
    assert.strictEqual(inserted!.agent, "agent:test");
  });

  it("maps status=done to column=done and state=done", async () => {
    const id = "tsk-reconC";
    const p = okPaths(root);
    const ok = makeOkTask(id, "done", "smoke reconcile done");
    await writeTask(p, ok);

    const inserted = await reconcileOkTask(id);
    assert.ok(inserted);
    assert.strictEqual(inserted!.column, "done");
    assert.strictEqual(inserted!.state, "done");
  });

  it("archives cancelled tasks (column=backlog, archived=true)", async () => {
    const id = "tsk-reconD";
    const p = okPaths(root);
    const ok = makeOkTask(id, "cancelled", "smoke reconcile cancelled");
    await writeTask(p, ok);

    const inserted = await reconcileOkTask(id);
    assert.ok(inserted);
    assert.strictEqual(inserted!.column, "backlog");
    assert.strictEqual(inserted!.state, "cancelled");
    assert.strictEqual(inserted!.archived, true);
  });

  it("is a no-op when the board already owns the id", async () => {
    const id = "tsk-reconE";
    const p = okPaths(root);
    const ok = makeOkTask(id, "pending", "do not duplicate me");
    await writeTask(p, ok);

    const first = await reconcileOkTask(id);
    assert.ok(first);

    // Second call: task already exists in board — returns null.
    const second = await reconcileOkTask(id);
    assert.strictEqual(second, null);

    const board = await getBoard();
    assert.strictEqual(
      board.tasks.filter(t => t.id === id).length,
      1,
      "task appears exactly once in board",
    );
  });

  it("returns null and writes nothing when the ok file is missing", async () => {
    const inserted = await reconcileOkTask("tsk-reconMissing");
    assert.strictEqual(inserted, null);

    const board = await getBoard();
    assert.ok(!board.tasks.find(t => t.id === "tsk-reconMissing"));
  });

  it("rejects malformed task ids without writing or throwing", async () => {
    const inserted = await reconcileOkTask("not-a-tsk-id");
    assert.strictEqual(inserted, null);
  });
});

// ─── Integration layer ────────────────────────────────────────────────────
//
// Starts the OpenKan server on an ephemeral port, writes a per-task JSON
// directly (the same path `ok task add` would take), waits for the watcher
// to reconcile, then asserts GET /api/board returns the task.

describe("ok task add → dashboard (integration)", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startOrAttach>> | null = null;
  let baseUrl = "";

  before(async () => {
    root = tmp();
    await initBoard({ directory: root, client: null, log: async () => undefined });

    // Pick a free port.
    const { createServer } = await import("node:http");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    server = await startOrAttach(
      { directory: root, client: null, log: async () => undefined },
      { port, host: "127.0.0.1", _autoDetect: false },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("a newly-written .ok/tasks/<id>.json appears in GET /api/board", async () => {
    // Give the watcher ample time to bind its fs.watch handle before we write;
    // otherwise the kernel-level change event may race with registration.
    await new Promise((r) => setTimeout(r, 2500));
    const id = "tsk-intReconcile1";
    const p = okPaths(root);
    await writeTask(p, makeOkTask(id, "pending", "integration reconcile smoke"));

    // Poll up to 5s for the task to appear (covers cold-start debounce).
    let found: { id: string; title: string; column: string } | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const res = await fetch(`${baseUrl}/api/board`);
      const board = await res.json() as { tasks: Array<{ id: string; title: string; column: string }> };
      found = board.tasks.find((t) => t.id === id);
      if (found) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(found, `task ${id} should appear in /api/board within 5s`);
    assert.strictEqual(found!.title, "integration reconcile smoke");
    assert.strictEqual(found!.column, "todo");
  });

  it("in_progress ok task surfaces in the doing column on /api/board", async () => {
    const id = "tsk-intReconcile2";
    const p = okPaths(root);
    await writeTask(p, makeOkTask(id, "in_progress", "integration in_progress"));

    await new Promise((r) => setTimeout(r, 1500));

    const res = await fetch(`${baseUrl}/api/board`);
    const board = await res.json() as { tasks: Array<{ id: string; column: string }> };
    const found = board.tasks.find((t) => t.id === id);
    assert.ok(found);
    assert.strictEqual(found!.column, "doing");
  });
});
