// tests/bulk.test.mts — unit tests for kanban/bulk.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "node:os";
import { initBoard, withWrite, setProjectRoot, getBoard, type Task } from "../kanban/board.ts";
import { applyBulk } from "../kanban/bulk.ts";
import { readEvents } from "../kanban/changelog.ts";
import { writeTaskMdx } from "../kanban/mdx.ts";

describe("applyBulk", () => {
  let tmp: string;

  async function setupBoard() {
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    const ctx = {
      directory: tmp,
      client: null as any,
      log: async () => {},
    };
    await initBoard(ctx);
    setProjectRoot(tmp);

    const now = new Date().toISOString();
    const tasks: Task[] = [
      { id: "tsk-b1", title: "Task B1", description: "", column: "todo", order: 0, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: now, updatedAt: now, artifact: "tasks/tsk-b1/task.mdx", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "tasks/tsk-b1/task.mdx", commentsPath: "tasks/tsk-b1/comments.json", inputsPath: "tasks/tsk-b1/inputs.json", statePath: "tasks/tsk-b1/state.json" }, tags: ["frontend"], category: "frontend", priority: "normal", effort: null, archived: false, assignees: ["alice"], images: [] } as Task,
      { id: "tsk-b2", title: "Task B2", description: "", column: "todo", order: 1, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: now, updatedAt: now, artifact: "tasks/tsk-b2/task.mdx", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "tasks/tsk-b2/task.mdx", commentsPath: "tasks/tsk-b2/comments.json", inputsPath: "tasks/tsk-b2/inputs.json", statePath: "tasks/tsk-b2/state.json" }, tags: [], category: "backend", priority: "low", effort: null, archived: false, assignees: [], images: [] } as Task,
      { id: "tsk-b3", title: "Task B3", description: "", column: "backlog", order: 0, sessionId: null, agent: "", model: null, status: "idle", state: "idle", lastError: null, createdAt: now, updatedAt: now, artifact: "tasks/tsk-b3/task.mdx", sessionArtifact: null, source: undefined, pendingInputs: [], artifacts: { mdxPath: "tasks/tsk-b3/task.mdx", commentsPath: "tasks/tsk-b3/comments.json", inputsPath: "tasks/tsk-b3/inputs.json", statePath: "tasks/tsk-b3/state.json" }, tags: ["bug"], category: "task", priority: "high", effort: null, archived: false, assignees: ["bob"], images: [] } as Task,
    ];
    await withWrite(async (board) => {
      board.tasks.push(...tasks);
    });

    // Write MDX files for each task
    const board = await getBoard();
    for (const t of tasks) {
      mkdirSync(join(tmp, ".ok", "tasks", t.id), { recursive: true });
      await writeTaskMdx(t, join(tmp, ".ok"), board);
    }

    return ctx;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `bulk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("bulk move 3 tasks to doing column — all 3 there", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "move", taskIds: ["tsk-b1", "tsk-b2", "tsk-b3"], column: "doing" });
    assert.strictEqual(result.summary.moved, 3);
    assert.strictEqual(result.skipped.length, 0);

    const updated = await getBoard();
    for (const id of ["tsk-b1", "tsk-b2", "tsk-b3"]) {
      const t = updated.tasks.find(x => x.id === id);
      assert.ok(t, `Task ${id} should exist`);
      assert.strictEqual(t!.column, "doing", `Task ${id} should be in doing`);
    }
  });

  it("bulk set-priority on 2 tasks — both updated", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "set-priority", taskIds: ["tsk-b1", "tsk-b2"], priority: "urgent" });
    assert.strictEqual(result.summary.tagged, 2); // set-priority counts as tagged

    const updated = await getBoard();
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b1")!.priority, "urgent");
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b2")!.priority, "urgent");
  });

  it("bulk add-tags merges (preserves existing)", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "add-tags", taskIds: ["tsk-b1"], tags: ["perf", "security"] });
    assert.strictEqual(result.summary.tagged, 1);

    const updated = await getBoard();
    const tags = updated.tasks.find(x => x.id === "tsk-b1")!.tags;
    assert.ok(tags.includes("frontend"), "existing tag should be preserved");
    assert.ok(tags.includes("perf"), "new tag should be added");
    assert.ok(tags.includes("security"), "new tag should be added");
  });

  it("bulk delete removes the task and its per-task dir", async () => {
    await setupBoard();
    const board = await getBoard();
    const taskDir = join(tmp, ".ok", "tasks", "tsk-b2");

    const result = await applyBulk(board, { kind: "delete", taskIds: ["tsk-b2"] });
    assert.strictEqual(result.summary.deleted, 1);

    const updated = await getBoard();
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b2"), undefined, "task should be removed from board");
    assert.ok(!existsSync(taskDir), "task directory should be deleted");
  });

  it("atomic: one kanban.bulk changelog event regardless of batch size", async () => {
    await setupBoard();
    const board = await getBoard();

    await applyBulk(board, { kind: "move", taskIds: ["tsk-b1", "tsk-b2", "tsk-b3"], column: "review" });

    const { events } = readEvents(join(tmp, ".ok"));
    const bulkEvents = events.filter(e => e.kind === "kanban.bulk");
    assert.strictEqual(bulkEvents.length, 1, "should be exactly one kanban.bulk event");
    const payload = bulkEvents[0].payload as { applied: any[] };
    assert.strictEqual(payload.applied.length, 3, "event should record all 3 applied operations");
  });

  it("skipped tasks reported with reasons", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "move", taskIds: ["tsk-b1", "tsk-nonexistent"], column: "doing" });
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].taskId, "tsk-nonexistent");
    assert.ok(result.skipped[0].reason.includes("not found"), `Expected 'not found' in reason, got: ${result.skipped[0].reason}`);
  });

  it("bulk set-category updates category", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "set-category", taskIds: ["tsk-b1"], category: "infra" });
    assert.strictEqual(result.summary.tagged, 1);

    const updated = await getBoard();
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b1")!.category, "infra");
  });

  it("bulk archive sets archived=true", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "archive", taskIds: ["tsk-b1", "tsk-b2"] });
    assert.strictEqual(result.summary.archived, 2);

    const updated = await getBoard();
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b1")!.archived, true);
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b2")!.archived, true);
  });

  it("bulk restore sets archived=false", async () => {
    await setupBoard();
    const board = await getBoard();

    // First archive
    await applyBulk(board, { kind: "archive", taskIds: ["tsk-b1"] });
    // Then restore
    const result = await applyBulk(board, { kind: "restore", taskIds: ["tsk-b1"] });
    assert.strictEqual(result.summary.archived, 1);

    const updated = await getBoard();
    assert.strictEqual(updated.tasks.find(x => x.id === "tsk-b1")!.archived, false);
  });

  it("bulk remove-tag removes the tag", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "remove-tag", taskIds: ["tsk-b3"], tag: "bug" });
    assert.strictEqual(result.summary.tagged, 1);

    const updated = await getBoard();
    assert.ok(!updated.tasks.find(x => x.id === "tsk-b3")!.tags.includes("bug"), "bug tag should be removed");
  });

  it("bulk assign adds assignee", async () => {
    await setupBoard();
    const board = await getBoard();

    const result = await applyBulk(board, { kind: "assign", taskIds: ["tsk-b2"], assignee: "diana" });
    assert.strictEqual(result.summary.tagged, 1);

    const updated = await getBoard();
    const assignees = updated.tasks.find(x => x.id === "tsk-b2")!.assignees;
    assert.ok(assignees.includes("diana"), "diana should be added to assignees");
  });
});
