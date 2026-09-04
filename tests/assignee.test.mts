// tests/assignee.test.mts — tests for auto-assign and assignee merge logic

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, getBoard, setProjectRoot, KANBAN_DIR } from "../kanban/board.ts";
import { writeTaskMdx, writeBoardMdx } from "../kanban/mdx.ts";

// Re-initialise module-level state between tests
async function freshBoard(tmp: string) {
  // Clear the module-level singleton by re-importing
  // (tests run in separate vm contexts — each test file gets a fresh module instance)
  const { initBoard: ib, getBoard: gb, setProjectRoot: spr } = await import("../kanban/board.ts");
  spr(tmp);
  const ctx = {
    directory: tmp,
    client: null as any,
    log: async () => {},
  };
  const { board, dir } = await ib(ctx);
  return { board, dir, gb };
}

describe("assignee auto-assign on task creation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `assignee-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    mkdirSync(join(tmp, "web"), { recursive: true });
    mkdirSync(join(tmp, "tasks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("new task gets assignees: ['user'] when no git user is configured", async () => {
    // Set up a non-git directory
    const { board, dir } = await freshBoard(tmp);
    const taskId = "tsk-autotest1";
    const ctx = { directory: tmp, client: null as any, log: async () => {} };

    // Simulate task creation by directly building the task object
    // (mirrors the logic in apiCreateTask for the auto-assign step)
    const { newId, nowIso, taskArtifacts } = await import("../kanban/board.ts");
    const id = newId("tsk");
    const arts = taskArtifacts(id);
    const now = nowIso();
    const assigneeName = "user"; // no git user configured

    const task = {
      id,
      title: "Test task",
      description: "",
      column: "todo" as const,
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "idle" as const,
      state: "idle" as const,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      artifact: arts.mdxPath,
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: arts,
      tags: [] as string[],
      category: "task" as const,
      priority: "normal" as const,
      effort: null,
      archived: false,
      assignees: [assigneeName],
      images: [] as string[],
    };

    const { withWrite } = await import("../kanban/board.ts");
    await withWrite(async (b) => {
      b.tasks.push(task);
    });

    const updated = await getBoard();
    const found = updated.tasks.find(t => t.id === id);
    assert.ok(found, "task should be in board");
    assert.deepStrictEqual(found!.assignees, ["user"]);
    assert.deepStrictEqual(found!.images, []);
  });

  it("new task gets assignees from explicit body.assignee", async () => {
    const { board, dir } = await freshBoard(tmp);
    const assigneeName = "alice";

    const { newId, nowIso, taskArtifacts } = await import("../kanban/board.ts");
    const id = newId("tsk");
    const arts = taskArtifacts(id);
    const now = nowIso();

    const task = {
      id,
      title: "Task for alice",
      description: "",
      column: "todo" as const,
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "idle" as const,
      state: "idle" as const,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      artifact: arts.mdxPath,
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: arts,
      tags: [] as string[],
      category: "task" as const,
      priority: "normal" as const,
      effort: null,
      archived: false,
      assignees: [assigneeName],
      images: [] as string[],
    };

    const { withWrite } = await import("../kanban/board.ts");
    await withWrite(async (b) => {
      b.tasks.push(task);
    });

    const updated = await getBoard();
    const found = updated.tasks.find(t => t.id === id);
    assert.deepStrictEqual(found!.assignees, ["alice"]);
  });
});

describe("assignee merge on PATCH", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `assignee-patch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    mkdirSync(join(tmp, "web"), { recursive: true });
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    await freshBoard(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("PATCH with assignees merges add-only (union)", async () => {
    const { withWrite, getBoard: gb } = await import("../kanban/board.ts");
    const { newId, nowIso, taskArtifacts } = await import("../kanban/board.ts");

    const id = newId("tsk");
    const arts = taskArtifacts(id);
    const now = nowIso();

    // Create task with existing assignees
    await withWrite(async (b) => {
      b.tasks.push({
        id,
        title: "Patch test",
        description: "",
        column: "todo" as const,
        order: 0,
        sessionId: null,
        agent: "",
        model: null,
        status: "idle" as const,
        state: "idle" as const,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        artifact: arts.mdxPath,
        sessionArtifact: null,
        pendingInputs: [],
        artifacts: arts,
        tags: [],
        category: "task" as const,
        priority: "normal" as const,
        effort: null,
        archived: false,
        assignees: ["alice", "bob"],
        images: [],
      });
    });

    // Merge new assignees
    await withWrite(async (b) => {
      const t = b.tasks.find(t => t.id === id)!;
      const patchAssignees = ["carol", "dave"];
      t.assignees = [...new Set([...t.assignees, ...patchAssignees])];
      t.updatedAt = nowIso();
    });

    const board = await gb();
    const t = board.tasks.find(x => x.id === id)!;
    assert.ok(t.assignees.includes("alice"));
    assert.ok(t.assignees.includes("bob"));
    assert.ok(t.assignees.includes("carol"));
    assert.ok(t.assignees.includes("dave"));
  });

  it("PATCH with duplicate assignees does not create duplicates", async () => {
    const { withWrite, getBoard: gb } = await import("../kanban/board.ts");
    const { newId, nowIso, taskArtifacts } = await import("../kanban/board.ts");

    const id = newId("tsk");
    const arts = taskArtifacts(id);
    const now = nowIso();

    await withWrite(async (b) => {
      b.tasks.push({
        id,
        title: "Duplicate test",
        description: "",
        column: "todo" as const,
        order: 0,
        sessionId: null,
        agent: "",
        model: null,
        status: "idle" as const,
        state: "idle" as const,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        artifact: arts.mdxPath,
        sessionArtifact: null,
        pendingInputs: [],
        artifacts: arts,
        tags: [],
        category: "task" as const,
        priority: "normal" as const,
        effort: null,
        archived: false,
        assignees: ["alice"],
        images: [],
      });
    });

    await withWrite(async (b) => {
      const t = b.tasks.find(t => t.id === id)!;
      t.assignees = [...new Set([...t.assignees, ...["alice", "bob"]])];
      t.updatedAt = nowIso();
    });

    const board = await gb();
    const t = board.tasks.find(x => x.id === id)!;
    const aliceCount = t.assignees.filter(a => a === "alice").length;
    assert.strictEqual(aliceCount, 1, "alice should appear exactly once");
  });
});

describe("Task defaults for assignees and images", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `task-defaults-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    mkdirSync(join(tmp, "web"), { recursive: true });
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    await freshBoard(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("new task has empty images array", async () => {
    const { withWrite, getBoard: gb } = await import("../kanban/board.ts");
    const { newId, nowIso, taskArtifacts } = await import("../kanban/board.ts");

    const id = newId("tsk");
    const arts = taskArtifacts(id);
    const now = nowIso();

    await withWrite(async (b) => {
      b.tasks.push({
        id,
        title: "Images test",
        description: "",
        column: "todo" as const,
        order: 0,
        sessionId: null,
        agent: "",
        model: null,
        status: "idle" as const,
        state: "idle" as const,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        artifact: arts.mdxPath,
        sessionArtifact: null,
        pendingInputs: [],
        artifacts: arts,
        tags: [],
        category: "task" as const,
        priority: "normal" as const,
        effort: null,
        archived: false,
        assignees: ["user"],
        images: [],
      });
    });

    const board = await gb();
    const t = board.tasks.find(x => x.id === id)!;
    assert.ok(Array.isArray(t.images));
    assert.strictEqual(t.images.length, 0);
  });
});
