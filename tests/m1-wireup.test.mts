// tests/m1-wireup.test.mts — M1 wire-up: runImport + POST /api/import

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, getBoard } from "../kanban/board.ts";
import { runImport, stableImportId, computeSourceHash, slugFromRaw, type CheckboxHit } from "../kanban/import.ts";
import { apiImport } from "../kanban/server.ts";
import { setKanbanDir } from "../kanban/board.ts";

// M4 acceptance contract: re-importing the same source creates duplicate tasks
// (idempotent reimport is M5 — not wired up in this task)
describe("runImport", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("scans 3 unchecked + 1 checked checkbox → creates 3 Backlog tasks with imp- IDs, source, sourceHash", async () => {
    // Fixture: 3 unchecked, 1 checked
    writeFileSync(join(tmp, "docs", "notes.md"), [
      "- [ ] Fix the login bug",
      "- [x] Already done item",
      "- [ ] Add user profile page",
      "- [ ] Update README with new commands",
    ].join("\n"), "utf-8");

    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    const result = await runImport(ctx, {});

    // Should create 3 tasks (skip done item)
    assert.strictEqual(result.imported.length, 3, `Expected 3 tasks, got ${result.imported.length}: ${JSON.stringify(result.imported)}`);

    const board = await getBoard();
    const backlog = board.tasks.filter((t) => t.column === "backlog");
    assert.strictEqual(backlog.length, 3);

    // All IDs start with imp-
    for (const id of result.imported) {
      assert.ok(id.startsWith("imp-"), `ID ${id} should start with imp-`);
    }

    // Check source fields on each task
    for (const task of backlog) {
      assert.ok(task.source, "task should have source field");
      assert.strictEqual(task.source!.path, "docs/notes.md");
      assert.ok(task.source!.line >= 1, `source.line should be >= 1, got ${task.source!.line}`);
      assert.ok(task.source!.slug.length > 0, "source.slug should be non-empty");
      assert.ok(task.sourceHash, "sourceHash should be set");
      assert.strictEqual(typeof task.sourceHash, "string");
      assert.strictEqual(task.sourceHash.length, 16, "sourceHash should be 16 hex chars");
    }

    // sourceHash must match computeSourceHash of the fixture file
    const fileContent = readFileSync(join(tmp, "docs", "notes.md"), "utf-8");
    const expectedHash = computeSourceHash(fileContent);
    for (const task of backlog) {
      assert.strictEqual(task.sourceHash, expectedHash, `sourceHash for '${task.title}' should match fixture hash`);
    }

    // order should be sequential starting from existing backlog tasks
    const orders = backlog.map((t) => t.order).sort((a, b) => a - b);
    assert.deepStrictEqual(orders, [0, 1, 2], "order should be 0,1,2");
  });

  it("second pass without source edits creates a duplicate task (M4 acceptance — M5 deduplication not wired)", async () => {
    // Fixture
    writeFileSync(join(tmp, "docs", "notes.md"), [
      "- [ ] Fix the login bug",
    ].join("\n"), "utf-8");

    const ctx = { directory: tmp, client: null as any, log: async () => {} };

    const r1 = await runImport(ctx, {});
    assert.strictEqual(r1.imported.length, 1, "first pass should create 1 task");

    const r2 = await runImport(ctx, {});
    assert.strictEqual(r2.imported.length, 1, "second pass should also create 1 task");

    // stableImportId is content-based → same ID both passes
    assert.strictEqual(r1.imported[0], r2.imported[0], "re-import should produce the same ID (stable ID)");

    const board = await getBoard();
    const backlog = board.tasks.filter((t) => t.column === "backlog");
    assert.strictEqual(backlog.length, 2, "two tasks should exist after two passes (M4: duplicates allowed)");

    // M4 acceptance contract: we RECORD that this is the expected M4 behaviour.
    // M5 (idempotent reimport / skip-existing) is not wired up in this task.
  });

  it("stableImportId is deterministic and path/line/slug specific", () => {
    const hit1: CheckboxHit = { path: "docs/a.md", line: 5, raw: "Fix the bug", done: false };
    const hit2: CheckboxHit = { path: "docs/a.md", line: 6, raw: "Fix the bug", done: false };
    const hit3: CheckboxHit = { path: "docs/a.md", line: 5, raw: "Fix the bug again", done: false };
    const hit4: CheckboxHit = { path: "docs/b.md", line: 5, raw: "Fix the bug", done: false };

    const id1 = stableImportId(hit1);
    const id2 = stableImportId(hit2);
    const id3 = stableImportId(hit3);
    const id4 = stableImportId(hit4);

    assert.notStrictEqual(id1, id2, "different lines → different ID");
    assert.notStrictEqual(id1, id3, "different slug → different ID");
    assert.notStrictEqual(id1, id4, "different path → different ID");

    // Same hit twice → same ID
    assert.strictEqual(stableImportId(hit1), stableImportId(hit1));
  });

  it("slugFromRaw produces URL-safe slugs", () => {
    assert.strictEqual(slugFromRaw("Fix the login bug!"), "fix-the-login-bug");
    assert.strictEqual(slugFromRaw("Add  @#$% special chars"), "add-special-chars");
    assert.strictEqual(slugFromRaw("  trim whitespace  "), "trim-whitespace");
    assert.strictEqual(slugFromRaw(""), "untitled");
    assert.strictEqual(slugFromRaw("a".repeat(50)), "a".repeat(32), "slug truncated to 32 chars");
  });

  it("computeSourceHash is stable 16-char hex", () => {
    const h = computeSourceHash("hello world");
    assert.strictEqual(h.length, 16);
    assert.ok(/^[a-f0-9]+$/.test(h), "should be hex");
    assert.strictEqual(computeSourceHash("hello world"), computeSourceHash("hello world"));
    assert.notStrictEqual(computeSourceHash("hello world"), computeSourceHash("hello world!"));
  });
});

describe("POST /api/import", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `import-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, "tasks"), { recursive: true });
    mkdirSync(join(tmp, "docs"), { recursive: true });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);
    // Point KANBAN_DIR at our temp board so apiImport reads the right config
    setKanbanDir(tmp);
  });

  afterEach(() => {
    setKanbanDir("");
    rmSync(tmp, { force: true, recursive: true });
  });

  async function apiImportReq(body: unknown): Promise<Response> {
    const req = new Request("http://localhost/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ctx = { directory: tmp, client: null as any, log: async () => {} };
    return apiImport(ctx, req);
  }

  it("POST /api/import creates tasks matching runImport output", async () => {
    writeFileSync(join(tmp, "docs", "notes.md"), [
      "- [ ] Fix the login bug",
      "- [ ] Add user profile page",
    ].join("\n"), "utf-8");

    const res = await apiImportReq({ include: ["docs/**"], exclude: [] });
    if (res.status !== 201) {
      const text = await res.text();
      assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${text}`);
      return;
    }
    const data = await res.json();
    assert.ok(data.ok, "response should have ok: true");
    assert.strictEqual(data.imported.length, 2, `Expected 2 imported tasks, got ${data.imported.length}`);

    // IDs start with imp-
    for (const id of data.imported) {
      assert.ok(id.startsWith("imp-"), `ID ${id} should start with imp-`);
    }

    // Verify via board state
    const board = await getBoard();
    const backlog = board.tasks.filter((t) => t.column === "backlog");
    assert.strictEqual(backlog.length, 2);

    for (const task of backlog) {
      assert.ok(task.source, `task ${task.id} should have source`);
      assert.strictEqual(task.source!.path, "docs/notes.md");
      assert.ok(task.sourceHash, "sourceHash should be set");
    }
  });

  it("POST /api/import without body uses default include patterns", async () => {
    // Fixture using default include: docs/**, *.md, *.mdx
    writeFileSync(join(tmp, "README.md"), [
      "- [ ] A readme task",
    ].join("\n"), "utf-8");

    const res = await apiImportReq({});
    if (res.status !== 201) {
      const text = await res.text();
      assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${text}`);
      return;
    }
    const data = await res.json();
    assert.strictEqual(data.imported.length, 1, "should pick up README.md via default *.md include");
  });
});
