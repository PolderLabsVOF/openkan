// tests/ok-index.test.mts — index rebuild produces accurate pointer.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initIfMissing, paths, writeTask, writePlan, writePrd, rebuildIndex, readIndex } from "../ok/storage.ts";
import { nowIso } from "../ok/ids.ts";

describe("ok index", () => {
  let root: string;

  before(async () => { root = mkdtempSync(join(tmpdir(), "ok-idx-")); await initIfMissing(root); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it("rebuildIndex reflects added tasks/plans/prds", async () => {
    const p = paths(root);
    await writeTask(p, {
      schema: "ok.task.v1", id: "tsk-idx0001", title: "t1", status: "pending",
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    await writePlan(p, {
      schema: "ok.plan.v1", id: "pln-idx0001", title: "p1", summary: "s",
      status: "draft", tasks: [], acceptance: [],
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    await writePrd(p, {
      schema: "ok.prd.v1", id: "prd-idx0001", title: "r1", vision: "v",
      goals: [], nonGoals: [], successMetrics: [], milestones: [], risks: [],
      plans: [], owners: [], status: "draft",
      createdAt: nowIso(), updatedAt: nowIso(),
    });
    const idx = await rebuildIndex(p);
    assert.strictEqual(idx.tasks.length, 1);
    assert.strictEqual(idx.plans.length, 1);
    assert.strictEqual(idx.prds.length, 1);
    assert.strictEqual(idx.tasks[0].id, "tsk-idx0001");
    assert.strictEqual(idx.plans[0].id, "pln-idx0001");
    assert.strictEqual(idx.prds[0].id, "prd-idx0001");
  });

  it("rebuildIndex is sorted by updatedAt desc", async () => {
    const p = paths(root);
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2024-01-01T00:00:00.000Z";
    const t2 = "2025-01-01T00:00:00.000Z";
    await writeTask(p, {
      schema: "ok.task.v1", id: "tsk-old0001", title: "old", status: "pending",
      createdAt: t0, updatedAt: t0,
    });
    await writeTask(p, {
      schema: "ok.task.v1", id: "tsk-mid0001", title: "mid", status: "pending",
      createdAt: t1, updatedAt: t1,
    });
    await writeTask(p, {
      schema: "ok.task.v1", id: "tsk-new0001", title: "new", status: "pending",
      createdAt: t2, updatedAt: t2,
    });
    const idx = await rebuildIndex(p);
    const order = idx.tasks.map((t) => t.id);
    assert.ok(order.indexOf("tsk-new0001") < order.indexOf("tsk-mid0001"));
    assert.ok(order.indexOf("tsk-mid0001") < order.indexOf("tsk-old0001"));
  });

  it("readIndex returns undefined when no index exists", async () => {
    const p = paths(root);
    rmSync(p.indexFile, { force: true });
    const idx = await readIndex(p);
    assert.strictEqual(idx, undefined);
  });
});
