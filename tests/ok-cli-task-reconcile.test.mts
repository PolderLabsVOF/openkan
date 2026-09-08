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

import { describe, it, test, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { initBoard, getBoard, reconcileOkTask, taskArtifacts, KANBAN_DIR } from "../kanban/board.ts";
import { writeTask, paths as okPaths, readTask as readOkTask } from "../ok/storage.ts";
import type { Task as OkTask } from "../ok/schemas.ts";
import { startOrAttach, type StartOrAttachResult } from "../kanban/server.ts";
import { addProject, setRegistryPathForTesting } from "../kanban/projects.ts";

// Module-scoped server reference for signal handler cleanup.
// This ensures that if npm test is interrupted, the in-process server is stopped.
let serverRef: Awaited<ReturnType<typeof startOrAttach>> | null = null;

function cleanupServer(): void {
  if (serverRef) {
    serverRef.stop().catch(() => { /* best effort */ });
    serverRef = null;
  }
}

process.on("SIGINT", cleanupServer);
process.on("SIGTERM", cleanupServer);
process.on("beforeExit", cleanupServer);

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

async function runOkTask(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // Spawn a child process so the test runner's process.stdout events
  // (test:start, test:complete, test:fail, etc.) cannot leak into the
  // captured stdout. In-process capture via a stdout.write hook
  // collides with node --test's reporter, which writes to
  // process.stdout asynchronously from the same event loop. The child
  // process is the only fully isolated path.
  const { spawn } = await import("node:child_process");
  const scriptPath = fileURLToPath(new URL("../bin/ok.ts", import.meta.url));
  writeFileSync("/tmp/ok-add-debug.log", `[parent] spawn cwd=${cwd} parentCwd=${process.cwd()}\n`, { flag: "a" });
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", scriptPath, "task", ...args],
      // OPENKAN_FORCE_MIRROR=1 opts into the mirror path even when cwd is
      // not the registry's active project. The test set up its own
      // server on a free port; without this env var the CLI's
      // shouldMirrorToActiveServer() guard (ok/commands/task.ts) refuses
      // to POST to the test's server because the global registry's
      // active project doesn't match cwd. The guard exists to prevent
      // a `mkdtempSync`-based fixture from leaking tasks onto the
      // developer's live dashboard, which is exactly the bug we're
      // covering in the inverse direction here.
      { cwd, env: { ...process.env, OPENKAN_FORCE_MIRROR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr + err.message }));
  });
}


function taskIdFromOutput(stdout: string): string {
  const id = stdout.match(/tsk-[A-Za-z0-9_-]+/)?.[0];
  if (!id) throw new Error(`expected task id in ${JSON.stringify(stdout)}`);
  return id;
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

  it("promotes a pending mirror exactly once and marks it synced", async () => {
    const id = "tsk-pendingMirror";
    const p = okPaths(root);
    const pending = { ...makeOkTask(id, "pending", "pending mirror"), mirrorStatus: "pending" as const };
    await writeTask(p, pending);

    const first = await reconcileOkTask(id);
    assert.ok(first);
    const synchronized = await readOkTask(p, id);
    assert.strictEqual(synchronized!.mirrorStatus, "synced");
    assert.strictEqual(synchronized!.mirrorId, id);

    const second = await reconcileOkTask(id);
    assert.strictEqual(second, null);
    const board = await getBoard();
    assert.strictEqual(board.tasks.filter((task) => task.id === id).length, 1);
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
  // Snapshot OPENKAN_HOST/OPENKAN_PORT so the after() hook can restore them
  // exactly. Setting them in before() routes every ok task add/claim/complete
  // call through the test's ephemeral server instead of the developer's live
  // 127.0.0.1:7777 dashboard (the v0.6.1 fixture-leak shape).
  let savedHost: string | undefined;
  let savedPort: string | undefined;

  before(async () => {
    root = tmp();
    // Redirect the project registry to a per-suite file so the server's
    // getActiveProjectRoot() resolves to the test's tmpdir, not the
    // developer's live dashboard project. Without this, the running
    // server falls back to the global active project root, and
    // handleRequest() loads the developer's board.json into _board —
    // which is the v0.6.1 leak shape that contaminated the live
    // dashboard with test fixtures.
    setRegistryPathForTesting(join(root, ".ok", "projects.json"));
    await initBoard({ directory: root, client: null, log: async () => undefined });
    addProject({ name: "test", root });

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
    serverRef = server;
    baseUrl = `http://127.0.0.1:${port}`;
    writeFileSync(join(root, ".ok", "openkan.json"), JSON.stringify({ host: "127.0.0.1", port }));

    savedHost = process.env.OPENKAN_HOST;
    savedPort = process.env.OPENKAN_PORT;
    process.env.OPENKAN_HOST = "127.0.0.1";
    process.env.OPENKAN_PORT = String(port);
  });

  after(async () => {
    if (savedHost === undefined) delete process.env.OPENKAN_HOST;
    else process.env.OPENKAN_HOST = savedHost;
    if (savedPort === undefined) delete process.env.OPENKAN_PORT;
    else process.env.OPENKAN_PORT = savedPort;
    if (serverRef === server) serverRef = null;
    if (server) await server.stop();
    setRegistryPathForTesting(null);
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

  it("ok task add posts the locally-minted id to the board", async () => {
    const added = await runOkTask(root, ["add", "server-visible task", "--owner", "alice"]);
    assert.strictEqual(added.code, 0);
    const id = taskIdFromOutput(added.stdout);

    const board = await (await fetch(`${baseUrl}/api/board`)).json() as {
      tasks: Array<{ id: string; title: string; offlineMirrorId?: string }>;
    };
    const created = board.tasks.find((task) => task.id === id);
    assert.strictEqual(created?.title, "server-visible task");
    assert.strictEqual(created?.offlineMirrorId, id);

    const offline = await readOkTask(okPaths(root), id);
    assert.strictEqual(offline?.mirrorStatus, "synced");
  });

  it("ok task claim, heartbeat, and complete update the board card", async () => {
    const added = await runOkTask(root, ["add", "board lifecycle task"]);
    const id = taskIdFromOutput(added.stdout);

    assert.strictEqual((await runOkTask(root, ["claim", id, "--owner", "alice"])).code, 0);
    let board = await (await fetch(`${baseUrl}/api/board`)).json() as {
      tasks: Array<{ id: string; column: string; state: string; assignees: string[] }>;
    };
    let task = board.tasks.find((candidate) => candidate.id === id);
    assert.strictEqual(task?.state, "running");
    assert.ok(task?.assignees.includes("alice"));

    assert.strictEqual((await runOkTask(root, ["heartbeat", id, "--owner", "alice"])).code, 0);
    board = await (await fetch(`${baseUrl}/api/board`)).json() as {
      tasks: Array<{ id: string; assignees: string[] }>;
    };
    task = board.tasks.find((candidate) => candidate.id === id);
    assert.ok(task?.assignees.includes("alice"));

    assert.strictEqual((await runOkTask(root, ["complete", id, "--owner", "alice", "--evidence", "test evidence"])).code, 0);
    board = await (await fetch(`${baseUrl}/api/board`)).json() as {
      tasks: Array<{ id: string; column: string; state: string }>;
    };
    task = board.tasks.find((candidate) => candidate.id === id);
    assert.strictEqual(task?.column, "done");
    assert.strictEqual(task?.state, "done");
  });

  it("POST with the same clientId returns one board task", async () => {
    const clientId = `tsk-clientId${Date.now().toString(36)}`;
    const payload = { title: "dedupe this POST", clientId, column: "todo" };
    const first = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(first.status, 201);
    const created = await first.json() as { id: string; offlineMirrorId?: string };
    assert.strictEqual(created.id, clientId);
    assert.strictEqual(created.offlineMirrorId, clientId);

    const retry = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(retry.status, 200);
    const returned = await retry.json() as { id: string };
    assert.strictEqual(returned.id, clientId);

    const board = await (await fetch(`${baseUrl}/api/board`)).json() as { tasks: Array<{ id: string }> };
    assert.strictEqual(board.tasks.filter((task) => task.id === clientId).length, 1);
  });

  it("PATCH moves a board task to the requested column", async () => {
    const created = await (await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "move a card" }),
    })).json() as { id: string };

    const patch = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "doing" }),
    });
    assert.strictEqual(patch.status, 200);
    const moved = await patch.json() as { column: string };
    assert.strictEqual(moved.column, "doing");

    const board = await (await fetch(`${baseUrl}/api/board`)).json() as { tasks: Array<{ id: string; column: string }> };
    assert.strictEqual(board.tasks.find((task) => task.id === created.id)?.column, "doing");
  });
});

// Smoke test: verify that signal handlers for server cleanup are registered.
// This ensures that if npm test is interrupted, the in-process server is stopped.
test("signal handlers are registered for server cleanup", () => {
  const handlers = process.listeners("SIGINT");
  const hasCleanupHandler = handlers.some((h) => h.name === "cleanupServer");
  assert.equal(hasCleanupHandler, true, "SIGINT handler should be registered");
});
