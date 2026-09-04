// tests/search.test.mts — unit tests for kanban/search.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "node:os";
import { initBoard, withWrite, setProjectRoot, type Task } from "../kanban/board.ts";
import { search } from "../kanban/search.ts";
import { writeTaskMdx } from "../kanban/mdx.ts";

describe("search", () => {
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
    return ctx;
  }

  async function createTask(id: string, fields: Partial<Task> & { title: string; description?: string }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title: fields.title,
      description: fields.description ?? "",
      column: fields.column ?? "todo",
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      status: "idle",
      state: "idle",
      lastError: null,
      createdAt: now,
      updatedAt: now,
      artifact: `tasks/${id}/task.mdx`,
      sessionArtifact: null,
      source: undefined,
      pendingInputs: [],
      artifacts: {
        mdxPath: `tasks/${id}/task.mdx`,
        commentsPath: `tasks/${id}/comments.json`,
        inputsPath: `tasks/${id}/inputs.json`,
        statePath: `tasks/${id}/state.json`,
      },
      tags: fields.tags ?? [],
      category: (fields.category as Task["category"]) ?? "task",
      priority: (fields.priority as Task["priority"]) ?? "normal",
      effort: null,
      archived: fields.archived ?? false,
      assignees: fields.assignees ?? [],
      images: [],
    };

    await withWrite(async (board) => {
      board.tasks.push(task);
    });

    // Write the task MDX for content search tests
    const board = await import("../kanban/board.ts").then(m => m.getBoard());
    const taskDir = join(tmp, ".ok", "tasks", id);
    mkdirSync(taskDir, { recursive: true });
    await writeTaskMdx(task, join(tmp, ".ok"), board);

    return task;
  }

  beforeEach(async () => {
    tmp = join(tmpdir(), `search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("matches by title substring (case-insensitive)", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Fix login bug" });
    await createTask("tsk-2", { title: "Add signup flow" });

    const result = await search({ kanbanDir: join(tmp, ".ok"), query: "login" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
    assert.ok(result.results[0].matchIn.includes("title"));
  });

  it("matches by description", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Task one", description: "Something about authentication" });
    await createTask("tsk-2", { title: "Task two", description: "Unrelated content" });

    const result = await search({ kanbanDir: join(tmp, ".ok"), query: "authentication" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
    assert.ok(result.results[0].matchIn.includes("description"));
  });

  it("matches by tag", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Task one", tags: ["frontend", "bug"] });
    await createTask("tsk-2", { title: "Task two", tags: ["backend"] });

    const result = await search({ kanbanDir: join(tmp, ".ok"), query: "bug" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
    assert.ok(result.results[0].matchIn.includes("tags"));
  });

  it("matches by assignee", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Task one", assignees: ["alice"] });
    await createTask("tsk-2", { title: "Task two", assignees: ["bob"] });

    const result = await search({ kanbanDir: join(tmp, ".ok"), query: "alice" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
    assert.ok(result.results[0].matchIn.includes("assignees"));
  });

  it("matches by MDX content (substring inside the file)", async () => {
    await setupBoard();
    // The task description is stored in both the task object and the MDX file.
    // writeTaskMdx writes the description into the MDX, so searching for
    // text that appears in the description should match.
    await createTask("tsk-1", { title: "Task one", description: "Handle edge case X in parser" });

    const result = await search({ kanbanDir: join(tmp, ".ok"), query: "edge case" });
    assert.strictEqual(result.total, 1);
    assert.ok(result.results[0].matchIn.includes("content") || result.results[0].matchIn.includes("description"));
  });

  it("filters by column", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Backlog task", column: "backlog" });
    await createTask("tsk-2", { title: "Doing task", column: "doing" });

    const result = await search({ kanbanDir: join(tmp, ".ok"), column: "doing" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-2");
  });

  it("filters by tags (AND — must include all)", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Task one", tags: ["frontend", "bug"] });
    await createTask("tsk-2", { title: "Task two", tags: ["frontend"] });
    await createTask("tsk-3", { title: "Task three", tags: ["bug"] });

    const result = await search({ kanbanDir: join(tmp, ".ok"), tags: ["frontend", "bug"] });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
  });

  it("filters by priority", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Low prio", priority: "low" });
    await createTask("tsk-2", { title: "High prio", priority: "high" });

    const result = await search({ kanbanDir: join(tmp, ".ok"), priority: "high" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-2");
  });

  it("includeArchived=false hides archived tasks", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Active task" });
    await createTask("tsk-2", { title: "Archived task", archived: true });

    const result = await search({ kanbanDir: join(tmp, ".ok"), archived: false });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
  });

  it("includeArchived=true includes archived tasks", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Active task" });
    await createTask("tsk-2", { title: "Archived task", archived: true });

    const result = await search({ kanbanDir: join(tmp, ".ok"), archived: true });
    assert.strictEqual(result.total, 2);
  });

  it("pagination via limit and offset", async () => {
    await setupBoard();
    for (let i = 0; i < 5; i++) {
      await createTask(`tsk-${i}`, { title: `Task ${i}` });
    }

    const page1 = await search({ kanbanDir: join(tmp, ".ok"), limit: 2, offset: 0 });
    assert.strictEqual(page1.total, 5);
    assert.strictEqual(page1.results.length, 2);

    const page2 = await search({ kanbanDir: join(tmp, ".ok"), limit: 2, offset: 2 });
    assert.strictEqual(page2.results.length, 2);
    assert.notStrictEqual(page1.results[0].id, page2.results[0].id);
  });

  it("reports matchIn fields correctly", async () => {
    await setupBoard();
    await createTask("tsk-1", {
      title: "Fix authentication bug",
      description: "Fix the auth flow",
      tags: ["bug"],
      assignees: ["alice"],
    });

    const result = await search({ kanbanDir: join(tmp, ".ok"), query: "fix" });
    assert.strictEqual(result.total, 1);
    const task = result.results[0];
    assert.ok(task.matchIn.includes("title"), `Expected 'title' in matchIn, got ${JSON.stringify(task.matchIn)}`);
  });

  it("no query returns all non-archived tasks", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "One" });
    await createTask("tsk-2", { title: "Two" });

    const result = await search({ kanbanDir: join(tmp, ".kanban") });
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.results[0].matchIn.length, 0); // no query = no matchIn
  });

  it("filters by assignee name", async () => {
    await setupBoard();
    await createTask("tsk-1", { title: "Task one", assignees: ["alice", "bob"] });
    await createTask("tsk-2", { title: "Task two", assignees: ["charlie"] });

    const result = await search({ kanbanDir: join(tmp, ".ok"), assignee: "bob" });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.results[0].id, "tsk-1");
  });
});
