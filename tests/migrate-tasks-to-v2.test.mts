// tests/migrate-tasks-to-v2.test.mts — Phase 3 migration script integration.
//
// Phase 3 of the unified-task-storage plan walks legacy v1 flat files
// (`.ok/tasks/<id>.json`), converts each to v2 via convertTaskV1ToV2,
// and writes the directory form `.ok/tasks/<id>/task.json`. The legacy
// flat file is renamed to `.ok/tasks/<id>/task.v1.json` as a backup so
// the migration is reversible (Phase 9 cleanup removes the backups).
//
// These tests exercise the script against synthetic legacy workspaces
// in tmpdirs so the project's actual `.ok/` is untouched.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateTasksToV2 } from "../scripts/migrate-tasks-to-v2.ts";
import { paths, readTaskV2, writeTask } from "../ok/storage.ts";
import type { Task } from "../ok/schemas.ts";
import { nowIso } from "../ok/ids.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ok-migrate-v2-"));
}

function makeLegacyV1(id: string, overrides: Partial<Task> = {}): Task {
  const now = nowIso();
  return {
    schema: "ok.task.v1",
    id,
    title: `legacy ${id}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    description: "legacy description",
    owner: "alice",
    priority: "p1",
    scopes: ["migrated"],
    ...overrides,
  };
}

describe("migrate-tasks-to-v2 (Phase 3)", () => {
  let root: string;
  let p: ReturnType<typeof paths>;

  before(async () => {
    root = tmp();
    // Seed legacy v1 flat files in a fresh `.ok/tasks/` directory.
    const fs = await import("node:fs");
    const tasksDir = join(root, ".ok", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "tsk-mig0001.json"), JSON.stringify(makeLegacyV1("tsk-mig0001", { title: "first" })));
    writeFileSync(join(tasksDir, "tsk-mig0002.json"), JSON.stringify(makeLegacyV1("tsk-mig0002", { title: "second", priority: "p0" })));
    // And one already-migrated entry: v2 directory exists, no flat file.
    fs.mkdirSync(join(tasksDir, "tsk-migdone"), { recursive: true });
    const now = nowIso();
    writeFileSync(
      join(tasksDir, "tsk-migdone", "task.json"),
      JSON.stringify({
        schema: "ok.task.v2",
        id: "tsk-migdone",
        title: "already migrated",
        description: "",
        column: "todo",
        order: 0,
        sessionId: null,
        agent: "alice",
        model: null,
        status: "pending",
        state: "idle",
        lastError: null,
        createdAt: now,
        updatedAt: now,
        artifact: "",
        sessionArtifact: null,
        artifacts: { mdxPath: "", commentsPath: "", inputsPath: "", statePath: "" },
        pendingInputs: [],
        tags: [],
        category: "task",
        priority: "normal",
        effort: null,
        archived: false,
        assignees: ["alice"],
        images: [],
        parentId: null,
        subtaskIds: [],
      }),
    );
    p = paths(root);
  });

  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("migrates legacy v1 flat files into the v2 directory form", async () => {
    const report = await migrateTasksToV2(root);
    assert.strictEqual(report.scanned, 2, "should have scanned the two v1 flat files");
    assert.strictEqual(report.migrated, 2);
    assert.strictEqual(report.skipped, 0);
    assert.strictEqual(report.errors.length, 0);
  });

  it("writes a v2 task.json in each migrated directory", async () => {
    const v2a = await readTaskV2(p, "tsk-mig0001");
    assert.ok(v2a);
    assert.strictEqual(v2a!.title, "first");
    // v1 priority "p1" maps to v2 priority "high" via convertTaskV1ToV2.
    assert.strictEqual(v2a!.priority, "high");
    // v1 owner "alice" lands in v2 owner (preserved) + assignees[0].
    assert.strictEqual(v2a!.owner, "alice");
    assert.deepStrictEqual(v2a!.assignees, ["alice"]);
    // v1 scopes land in v2 tags.
    assert.deepStrictEqual(v2a!.tags, ["migrated"]);
  });

  it("renames the legacy flat file to task.v1.json inside the new directory", async () => {
    // The original .ok/tasks/tsk-mig0001.json is gone; the backup is
    // .ok/tasks/tsk-mig0001/task.v1.json with the original v1 contents.
    assert.ok(!existsSync(join(root, ".ok", "tasks", "tsk-mig0001.json")), "flat v1 file removed");
    const backup = readFileSync(join(root, ".ok", "tasks", "tsk-mig0001", "task.v1.json"), "utf-8");
    const parsed = JSON.parse(backup);
    assert.strictEqual(parsed.schema, "ok.task.v1");
    assert.strictEqual(parsed.title, "first");
  });

  it("is idempotent — re-running reports zero migrations", async () => {
    const second = await migrateTasksToV2(root);
    assert.strictEqual(second.scanned, 0, "no flat files left after first run");
    assert.strictEqual(second.migrated, 0);
    assert.strictEqual(second.skipped, 0);
  });

  it("does not touch an already-migrated directory (no v2 overwrite)", async () => {
    // tsk-migdone was set up with a v2 file but no flat file, so the
    // scanner should never see it. The v2 file should be untouched.
    const v2 = await readTaskV2(p, "tsk-migdone");
    assert.ok(v2);
    assert.strictEqual(v2!.title, "already migrated");
  });

  it("writes v2 directory only via writeTask (Phase 8 verification)", async () => {
    // Phase 8+: writeTask only writes v2 directory form.
    // The v1 flat file is NOT produced.
    const fresh = makeLegacyV1("tsk-migwrite", { title: "post-mig write" });
    await writeTask(p, fresh);
    assert.strictEqual(existsSync(join(root, ".ok", "tasks", "tsk-migwrite.json")), false, "v1 flat file NOT written");
    assert.ok(existsSync(join(root, ".ok", "tasks", "tsk-migwrite", "task.json")), "v2 directory task.json written");
  });
});
