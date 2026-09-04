// tests/ok-migrate.test.mts — one-shot import of legacy .openkan/ data.
//
// Note: the project itself has been migrated to .ok/ at the repo root, so
// these tests construct a synthetic legacy workspace in a tmp dir.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateFromOpenkan } from "../ok/migrate.ts";
import { paths, readTask } from "../ok/storage.ts";

describe("ok migrate", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "ok-mig-"));
    // Build a synthetic legacy .openkan/ workspace
    mkdirSync(join(root, ".openkan", "tasks", "legacy01"), { recursive: true });
    writeFileSync(join(root, ".openkan", "tasks.json"), JSON.stringify({
      tasks: [
        {
          id: "legacy01",
          title: "Legacy Task",
          column: "doing",
          order: 0,
          state: "running",
          agent: "alice",
          tags: ["migrated"],
          priority: "urgent",
          mdxPath: "tasks/legacy01/task.mdx",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          archived: false,
        },
        {
          id: "done0001",
          title: "Done legacy",
          column: "done",
          order: 0,
          state: "done",
          agent: "bob",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          archived: false,
        },
      ],
    }));
    writeFileSync(join(root, ".openkan", "tasks", "legacy01", "task.mdx"),
      "---\nid: legacy01\ntitle: Legacy Task\n---\n# legacy body\n");
  });

  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("imports tasks from a legacy .openkan/", async () => {
    const res = await migrateFromOpenkan(root);
    assert.ok(res.imported >= 2);
    assert.strictEqual(res.skipped, 0);

    const p = paths(root);
    const t = await readTask(p, "tsk-legacy01");
    assert.ok(t);
    assert.strictEqual(t!.title, "Legacy Task");
    assert.strictEqual(t!.status, "in_progress");
    assert.strictEqual(t!.owner, "alice");
    assert.ok(t!.description!.includes("legacy body"));
    assert.deepStrictEqual(t!.scopes, ["migrated"]);
    assert.strictEqual(t!.priority, "p0");

    const d = await readTask(p, "tsk-done0001");
    assert.ok(d);
    assert.strictEqual(d!.status, "done");
  });

  it("is idempotent — second run reports 0 imported", async () => {
    const res = await migrateFromOpenkan(root);
    assert.strictEqual(res.imported, 0);
    assert.ok(res.skipped >= 2);
  });

  it("no-op when .openkan/ does not exist", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ok-mig-empty-"));
    try {
      const res = await migrateFromOpenkan(empty);
      assert.strictEqual(res.imported, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
