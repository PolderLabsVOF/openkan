// tests/ok-engine-mirror.test.mts — OpenKan board engine mirrors into .ok/tasks/.
//
// Verifies the integration: when kanban/board.ts persist() is called, the
// per-task planning JSON files appear under .ok/tasks/<id>.json with the
// correct status mapping.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initBoard, persist, type Task } from "../kanban/board.ts";
import { readTask, paths as okPaths } from "../ok/storage.ts";

describe("OpenKan engine → .ok/ mirror", () => {
  let root: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "ok-mirror-"));
    const dir = join(root, ".ok");
    await initBoard({ directory: root, client: null, log: async () => undefined });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("engine persist mirrors a single task into .ok/tasks/<id>.json", async () => {
    const t: Task = {
      id: "tsk-mirror1",
      title: "mirror me",
      description: "x",
      column: "doing",
      order: 0,
      sessionId: null,
      agent: "karen",
      model: null,
      status: "running",
      state: "running",
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifact: "",
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" },
      tags: ["smoke"],
      category: "task",
      priority: "normal",
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    };
    const { getBoard } = await import("../kanban/board.ts");
    const board = await getBoard();
    board.tasks.push(t);
    await persist(board);

    const p = okPaths(root);
    assert.ok(existsSync(join(p.tasksDir, "tsk-mirror1.json")), "mirror file exists");

    const got = await readTask(p, "tsk-mirror1");
    assert.ok(got);
    assert.strictEqual(got!.title, "mirror me");
    assert.strictEqual(got!.status, "in_progress");
    assert.strictEqual(got!.owner, "karen");
    assert.deepStrictEqual(got!.scopes, ["smoke"]);
  });

  it("engine persist mirrors column placement into planning status", async () => {
    const t: Task = {
      id: "tsk-mirror2",
      title: "review-lane task",
      description: "",
      column: "review",
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "idle",
      state: "idle",
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifact: "",
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" },
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
    const { getBoard } = await import("../kanban/board.ts");
    const board = await getBoard();
    board.tasks.push(t);
    await persist(board);

    const p = okPaths(root);
    const got = await readTask(p, "tsk-mirror2");
    assert.strictEqual(got!.status, "review");
  });

  it("engine persist mirrors archived → cancelled", async () => {
    const t: Task = {
      id: "tsk-mirror3",
      title: "archived task",
      description: "",
      column: "done",
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "done",
      state: "done",
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifact: "",
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" },
      tags: [],
      category: "task",
      priority: "normal",
      effort: null,
      archived: true,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    };
    const { getBoard } = await import("../kanban/board.ts");
    const board = await getBoard();
    board.tasks.push(t);
    await persist(board);

    const p = okPaths(root);
    const got = await readTask(p, "tsk-mirror3");
    assert.strictEqual(got!.status, "cancelled");
  });
});
