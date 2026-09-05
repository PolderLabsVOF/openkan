// tests/cross-project-move.test.mts — covers the
// POST /api/projects/:projectId/tasks/move endpoint plus the
// resolveTargetColumn resolver used to map columns across projects.

import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initBoard, withWrite, setProjectRoot, getBoard, KANBAN_DIR, type Task, type Board } from "../kanban/board.ts";
import {
  setRegistryPathForTesting,
  addProject,
  setActiveProject,
  resolveKanbanDir,
} from "../kanban/projects.ts";
import { writeTaskMdx } from "../kanban/mdx.ts";

// We import the endpoint indirectly: the server module wraps
// apiMoveTasksToProject behind the route matcher, but the handler is
// `async (projectId, req) => Response`. We re-import the same logic via
// a thin re-export so the test exercises the real implementation.
import { apiMoveTasksToProject } from "../kanban/server.ts";

interface TaskSeed {
  id: string;
  title: string;
  column: string;
  parentId?: string | null;
  subtaskIds?: string[];
}

function taskArtifact(id: string) {
  return {
    mdxPath: `tasks/${id}/task.mdx`,
    commentsPath: `tasks/${id}/comments.json`,
    inputsPath: `tasks/${id}/inputs.json`,
    statePath: `tasks/${id}/state.json`,
  };
}

function makeTask(seed: TaskSeed): Task {
  const now = new Date().toISOString();
  return {
    id: seed.id,
    title: seed.title,
    description: "",
    column: seed.column,
    order: 0,
    sessionId: null,
    agent: "",
    model: null,
    status: "idle",
    state: "idle",
    lastError: null,
    createdAt: now,
    updatedAt: now,
    artifact: `tasks/${seed.id}/task.mdx`,
    sessionArtifact: null,
    pendingInputs: [],
    artifacts: taskArtifact(seed.id),
    tags: [],
    category: "task",
    priority: "normal",
    effort: null,
    archived: false,
    assignees: [],
    images: [],
    parentId: seed.parentId ?? null,
    subtaskIds: seed.subtaskIds ?? [],
  } as Task;
}

async function seedBoard(tasks: Task[], columns: Array<{ id: string; title: string }>) {
  await withWrite(async (board: Board) => {
    board.tasks = [];
    board.columns = columns;
    for (const t of tasks) board.tasks.push(t);
  });
  const board = await getBoard();
  for (const t of tasks) {
    const taskDir = join(KANBAN_DIR, "tasks", t.id);
    mkdirSync(taskDir, { recursive: true });
    await writeTaskMdx(t, KANBAN_DIR, board);
  }
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/projects/x/tasks/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("apiMoveTasksToProject", () => {
  let homeRoot: string;
  let sourceRoot: string;
  let targetRoot: string;
  let registryPath: string;
  let sourceEntry: { id: string };
  let targetEntry: { id: string };

  beforeEach(async () => {
    homeRoot = mkdtempSync(join(tmpdir(), "openkan-cpm-home-"));
    sourceRoot = mkdtempSync(join(homeRoot, "src-"));
    targetRoot = mkdtempSync(join(homeRoot, "tgt-"));
    registryPath = join(homeRoot, "projects.json");
    setRegistryPathForTesting(registryPath);

    mkdirSync(join(sourceRoot, ".ok", "tasks"), { recursive: true });
    mkdirSync(join(targetRoot, ".ok", "tasks"), { recursive: true });

    // Register both projects so findProject + resolveKanbanDir have
    // something to look up. Capture the returned entries — the auto-
    // generated id is the slug of the project root basename.
    sourceEntry = addProject({ name: "Source", root: sourceRoot });
    targetEntry = addProject({ name: "Target", root: targetRoot });
    setActiveProject(sourceEntry.id);
  });

  afterEach(() => {
    setRegistryPathForTesting(null);
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it("happy path: 3 tasks move to target's matching column id", async () => {
    await initBoard({
      directory: sourceRoot,
      client: null as any,
      log: async () => {},
    });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [makeTask({ id: "tsk-s1", title: "S1", column: "todo" }),
       makeTask({ id: "tsk-s2", title: "S2", column: "todo" }),
       makeTask({ id: "tsk-s3", title: "S3", column: "todo" })],
      [
        { id: "todo", title: "To Do" },
        { id: "doing", title: "In Progress" },
        { id: "done", title: "Done" },
      ],
    );

    // Pre-seed the target board.json with a single 'todo' column.
    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({ version: 1, columns: [{ id: "todo", title: "To Do" }], tasks: [], sessions: {} }),
    );

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-s1", "tsk-s2", "tsk-s3"] }));
    assert.strictEqual(res.status, 200, "endpoint should return 200");
    const body: any = await res.json();
    assert.deepStrictEqual(body.skipped, [], "no skips expected");
    assert.strictEqual(body.moved.length, 3);
    for (const m of body.moved) {
      assert.ok(m.id && m.id !== m.sourceId, "id should be reminted");
      assert.strictEqual(m.column, "todo");
    }

    // Source board.json no longer carries the moved tasks.
    const source = JSON.parse(readFileSync(join(sourceRoot, ".ok", "board.json"), "utf-8")) as Board;
    const srcIds = source.tasks.map((t) => t.id);
    assert.ok(!srcIds.includes("tsk-s1") && !srcIds.includes("tsk-s2") && !srcIds.includes("tsk-s3"), "source should be empty of moved tasks");
    // Source per-task dirs gone.
    assert.ok(!existsSync(join(sourceRoot, ".ok", "tasks", "tsk-s1")), "source dir for tsk-s1 should be removed");
    assert.ok(!existsSync(join(sourceRoot, ".ok", "tasks", "tsk-s2")), "source dir for tsk-s2 should be removed");

    // Target board.json has the new tasks.
    const target = JSON.parse(readFileSync(join(targetRoot, ".ok", "board.json"), "utf-8")) as Board;
    assert.strictEqual(target.tasks.length, 3);
    for (const m of body.moved) {
      const t = target.tasks.find((x) => x.id === m.id);
      assert.ok(t, `target should hold the moved id ${m.id}`);
      assert.strictEqual(t!.column, "todo");
    }

    // Each moved task has a per-task directory on the target side.
    for (const m of body.moved) {
      const dir = join(targetRoot, ".ok", "tasks", m.id);
      assert.ok(existsSync(dir), `target dir for ${m.id} should exist`);
      assert.ok(existsSync(join(dir, "task.mdx")), `target task.mdx for ${m.id} should exist`);
    }
  });

  it("column match by title (case-insensitive) when ids differ", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    // Source uses id 'next-up' for "Next Up". Target uses id 'backlog'
    // for "Backlog" but ALSO has a column titled "Next Up" (different id).
    await seedBoard(
      [makeTask({ id: "tsk-t1", title: "T1", column: "next-up" })],
      [{ id: "next-up", title: "Next Up" }, { id: "backlog", title: "Backlog" }],
    );

    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({
        version: 1,
        columns: [
          { id: "backlog", title: "Backlog" },
          // 'Next Up' with a *different* id but matching title.
          { id: "queued", title: "Next Up" },
        ],
        tasks: [],
        sessions: {},
      }),
    );

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-t1"] }));
    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.deepStrictEqual(body.skipped, []);
    assert.strictEqual(body.moved.length, 1);
    assert.strictEqual(body.moved[0].column, "queued", "should match by title to id 'queued'");
  });

  it("falls back to first column when no id or title matches", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [makeTask({ id: "tsk-r1", title: "R1", column: "random-id" })],
      [{ id: "random-id", title: "Random" }],
    );

    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({
        version: 1,
        columns: [
          { id: "first", title: "First Title" },
          { id: "second", title: "Second Title" },
        ],
        tasks: [],
        sessions: {},
      }),
    );

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-r1"] }));
    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.moved.length, 1);
    assert.strictEqual(body.moved[0].column, "first", "should fall back to first column id");
  });

  it("mixed valid/invalid: 3 moved, 2 skipped with reason 'not found'", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [makeTask({ id: "tsk-m1", title: "M1", column: "todo" }),
       makeTask({ id: "tsk-m2", title: "M2", column: "todo" }),
       makeTask({ id: "tsk-m3", title: "M3", column: "todo" })],
      [{ id: "todo", title: "To Do" }],
    );

    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({ version: 1, columns: [{ id: "todo", title: "To Do" }], tasks: [], sessions: {} }),
    );

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-m1", "tsk-m2", "tsk-m3", "tsk-bogus-1", "tsk-bogus-2"] }));
    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.moved.length, 3);
    assert.strictEqual(body.skipped.length, 2);
    const skipIds = body.skipped.map((s: any) => s.id).sort();
    assert.deepStrictEqual(skipIds, ["tsk-bogus-1", "tsk-bogus-2"]);
    for (const s of body.skipped) assert.strictEqual(s.reason, "not found");
  });

  it("subtasks: parent + child selected together re-link in target", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [
        makeTask({ id: "tsk-parent", title: "Parent", column: "todo", subtaskIds: ["tsk-child"] }),
        makeTask({ id: "tsk-child", title: "Child", column: "todo", parentId: "tsk-parent" }),
      ],
      [{ id: "todo", title: "To Do" }],
    );

    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({ version: 1, columns: [{ id: "todo", title: "To Do" }], tasks: [], sessions: {} }),
    );

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-parent", "tsk-child"] }));
    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.moved.length, 2);
    assert.deepStrictEqual(body.skipped, []);

    const target = JSON.parse(readFileSync(join(targetRoot, ".ok", "board.json"), "utf-8")) as Board;
    const parentNewId = body.moved.find((m: any) => m.sourceId === "tsk-parent").id;
    const childNewId = body.moved.find((m: any) => m.sourceId === "tsk-child").id;
    const parentClone = target.tasks.find((t) => t.id === parentNewId)!;
    const childClone = target.tasks.find((t) => t.id === childNewId)!;
    assert.deepStrictEqual(parentClone.subtaskIds, [childNewId], "parent should list new child id");
    assert.strictEqual(childClone.parentId, parentNewId, "child should reference new parent id");
  });

  it("subtask alone: child moves with parentId=null", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [makeTask({ id: "tsk-orphan-parent", title: "Orphan Parent", column: "todo", subtaskIds: ["tsk-orphan"] }),
       makeTask({ id: "tsk-orphan", title: "Orphan", column: "todo", parentId: "tsk-orphan-parent" })],
      [{ id: "todo", title: "To Do" }],
    );

    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({ version: 1, columns: [{ id: "todo", title: "To Do" }], tasks: [], sessions: {} }),
    );

    // Move only the child. Parent is NOT selected, so child's parentId
    // should be null on the target.
    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-orphan"] }));
    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    assert.strictEqual(body.moved.length, 1);
    const target = JSON.parse(readFileSync(join(targetRoot, ".ok", "board.json"), "utf-8")) as Board;
    const cloned = target.tasks.find((t) => t.id === body.moved[0].id)!;
    assert.strictEqual(cloned.parentId, null, "orphan subtask should have parentId=null after move");
    assert.deepStrictEqual(cloned.subtaskIds, [], "no subtasks should be linked");

    // Sanity: parent's subtaskIds entry no longer references the
    // moved child id (the child id on the target is a NEW id, so the
    // parent's reference would never be the same — but we ensure the
    // child id is NOT in source's subtaskIds either since the child
    // is gone from source).
    const source = JSON.parse(readFileSync(join(sourceRoot, ".ok", "board.json"), "utf-8")) as Board;
    const parent = source.tasks.find((t) => t.id === "tsk-orphan-parent")!;
    assert.ok(!parent.subtaskIds.includes("tsk-orphan"), "parent's subtaskIds should drop the moved child on the source side");
  });

  it("files moved: target task.mdx matches source content", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [makeTask({ id: "tsk-files", title: "FilesTask", column: "todo" })],
      [{ id: "todo", title: "To Do" }],
    );

    // Snapshot source content BEFORE the move so the assertion has
    // something to compare against. Source tasks are removed by the
    // move endpoint.
    const srcMdx = readFileSync(join(sourceRoot, ".ok", "tasks", "tsk-files", "task.mdx"), "utf-8");

    writeFileSync(
      join(targetRoot, ".ok", "board.json"),
      JSON.stringify({ version: 1, columns: [{ id: "todo", title: "To Do" }], tasks: [], sessions: {} }),
    );

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: ["tsk-files"] }));
    assert.strictEqual(res.status, 200);
    const body: any = await res.json();
    const newId = body.moved[0].id;

    const tgtMdx = readFileSync(join(targetRoot, ".ok", "tasks", newId, "task.mdx"), "utf-8");
    assert.strictEqual(tgtMdx, srcMdx, "target mdx should match source mdx byte-for-byte");
  });

  it("empty taskIds array → 400", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({ taskIds: [] }));
    assert.strictEqual(res.status, 400);
  });

  it("missing taskIds field → 400", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    const targetId = targetEntry.id;
    const res = await apiMoveTasksToProject(targetId, makeRequest({}));
    assert.strictEqual(res.status, 400);
  });

  it("invalid projectId → 404", async () => {
    await initBoard({ directory: sourceRoot, client: null as any, log: async () => {} });
    setProjectRoot(sourceRoot);

    await seedBoard(
      [makeTask({ id: "tsk-x", title: "X", column: "todo" })],
      [{ id: "todo", title: "To Do" }],
    );

    const res = await apiMoveTasksToProject("nonexistent-project-id", makeRequest({ taskIds: ["tsk-x"] }));
    assert.strictEqual(res.status, 404);
  });
});

describe("resolveTargetColumn helper integration", () => {
  it("resolveKanbanDir returns the .ok dir for a registered project root", () => {
    const homeRoot = mkdtempSync(join(tmpdir(), "openkan-cpm-resolve-"));
    const root = join(homeRoot, "fixture");
    mkdirSync(join(root, ".ok"), { recursive: true });
    setRegistryPathForTesting(join(homeRoot, "projects.json"));
    try {
      const entry = addProject({ name: "ResolveMe", root });
      const resolved = resolveKanbanDir(entry.root);
      assert.strictEqual(resolved, join(root, ".ok"));
    } finally {
      setRegistryPathForTesting(null);
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });
});
