import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureBoardForProject, getBoard, initBoard, taskArtifacts, withWrite } from "../kanban/board.ts";

const context = (directory: string) => ({ directory, client: null, log: async () => undefined });

test("switching projects reloads the in-memory board instead of retaining prior tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "openkan-project-switch-"));
  const first = join(root, "first");
  const second = join(root, "second");
  try {
    await initBoard(context(first));
    await withWrite(async (board) => {
      board.tasks.push({
        id: "tsk-first", title: "First project task", description: "",
        column: "todo", order: 0, sessionId: null, agent: "", model: null,
        status: "idle", state: "idle", lastError: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        artifact: "tasks/tsk-first/task.mdx", sessionArtifact: null,
        pendingInputs: [], artifacts: taskArtifacts("tsk-first"), tags: [], category: "task",
        priority: "normal", effort: null, archived: false, assignees: [], images: [],
        parentId: null, subtaskIds: [],
      });
    });

    const secondBoard = await ensureBoardForProject(context(second));
    assert.equal(secondBoard.board.tasks.length, 0);

    const firstBoard = await ensureBoardForProject(context(first));
    assert.deepEqual(firstBoard.board.tasks.map((task) => task.title), ["First project task"]);
    assert.equal((await getBoard()).tasks[0]?.id, "tsk-first");
  } finally {
    // Restore the repository board because this module shares the process-wide
    // board cache with the rest of the test suite.
    await initBoard(context(process.cwd()));
    rmSync(root, { recursive: true, force: true });
  }
});
