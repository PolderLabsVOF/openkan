// tests/ok-storage.test.mts — round-trip storage and atomic semantics.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  paths,
  initIfMissing,
  readTask, writeTask, listTasks,
  readPlan, writePlan, listPlans,
  readPrd, writePrd, listPrds,
  rebuildIndex, readIndex,
  readConfig, writeConfig,
} from "../ok/storage.ts";
import type { Task, Plan, Prd } from "../ok/schemas.ts";
import { nowIso } from "../ok/ids.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ok-storage-"));
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    schema: "ok.task.v1",
    id,
    title: `task ${id}`,
    status: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

function makePlan(id: string, overrides: Partial<Plan> = {}): Plan {
  return {
    schema: "ok.plan.v1",
    id,
    title: `plan ${id}`,
    summary: "test plan",
    status: "draft",
    tasks: [],
    acceptance: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

function makePrd(id: string, overrides: Partial<Prd> = {}): Prd {
  return {
    schema: "ok.prd.v1",
    id,
    title: `prd ${id}`,
    vision: "test vision",
    goals: [],
    nonGoals: [],
    successMetrics: [],
    milestones: [],
    risks: [],
    plans: [],
    owners: [],
    status: "draft",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

describe("ok/storage", () => {
  let root: string;
  let p: ReturnType<typeof paths>;

  before(async () => {
    root = tmp();
    p = await initIfMissing(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("initIfMissing creates the expected layout", async () => {
    assert.ok(existsSync(p.configFile), "config.json created");
    assert.ok(existsSync(p.indexFile), "index.json created");
    assert.ok(existsSync(p.tasksDir), "tasks dir created");
    assert.ok(existsSync(p.plansDir), "plans dir created");
    assert.ok(existsSync(p.prdsDir), "prds dir created");
    assert.ok(existsSync(p.sessionsDir), "sessions dir created");
    assert.ok(existsSync(p.locksDir), "locks dir created");
    const cfg = await readConfig(p);
    assert.ok(cfg);
    assert.strictEqual(cfg!.schema, "ok.config.v1");
    assert.strictEqual(cfg!.version, 1);
  });

  it("initIfMissing is idempotent", async () => {
    const first = (await readConfig(p))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await initIfMissing(root);
    const second = (await readConfig(p))!.updatedAt;
    assert.strictEqual(first, second, "config unchanged on second init");
  });

  it("writes and reads back a Task", async () => {
    const t = makeTask("tsk-rw000001", { title: "round-trip", priority: "p1" });
    await writeTask(p, t);
    const got = await readTask(p, "tsk-rw000001");
    assert.ok(got);
    assert.strictEqual(got!.title, "round-trip");
    assert.strictEqual(got!.priority, "p1");
  });

  it("lists all tasks", async () => {
    const tasks = await listTasks(p);
    assert.ok(tasks.find((x) => x.id === "tsk-rw000001"));
  });

  it("rejects malformed task ids", async () => {
    await assert.rejects(() => readTask(p, "bogus-id"));
  });

  it("writes and reads back a Plan with linked tasks", async () => {
    const plan = makePlan("pln-rw000001", {
      title: "round-trip plan",
      tasks: ["tsk-rw000001"],
      acceptance: ["ship plan storage", "ship doctor"],
    });
    await writePlan(p, plan);
    const got = await readPlan(p, "pln-rw000001");
    assert.ok(got);
    assert.deepStrictEqual(got!.tasks, ["tsk-rw000001"]);
  });

  it("writes and reads back a PRD with goals and milestones", async () => {
    const prd = makePrd("prd-rw000001", {
      title: "round-trip prd",
      goals: [
        { id: "g1", text: "ship", status: "open" },
        { id: "g2", text: "iterate", status: "in_progress" },
      ],
      milestones: [
        { id: "m1", title: "v0.1", dueBy: "2026-12-31T00:00:00Z", status: "open" },
      ],
      risks: [
        { id: "r1", text: "scope creep", severity: "med", mitigation: "weekly triage" },
      ],
    });
    await writePrd(p, prd);
    const got = await readPrd(p, "prd-rw000001");
    assert.ok(got);
    assert.strictEqual(got!.goals.length, 2);
    assert.strictEqual(got!.milestones[0].status, "open");
    assert.strictEqual(got!.risks[0].severity, "med");
  });

  it("rebuildIndex produces a populated index from filesystem", async () => {
    const idx = await rebuildIndex(p);
    assert.strictEqual(idx.schema, "ok.index.v1");
    assert.ok(idx.tasks.find((t) => t.id === "tsk-rw000001"));
    assert.ok(idx.plans.find((pl) => pl.id === "pln-rw000001"));
    assert.ok(idx.prds.find((pr) => pr.id === "prd-rw000001"));
    // Sorted by updatedAt desc
    if (idx.tasks.length >= 2) {
      assert.ok(idx.tasks[0].updatedAt >= idx.tasks[1].updatedAt);
    }
  });

  it("rebuildIndex is idempotent", async () => {
    const a = await rebuildIndex(p);
    const b = await rebuildIndex(p);
    assert.strictEqual(a.tasks.length, b.tasks.length);
    assert.strictEqual(a.plans.length, b.plans.length);
    assert.strictEqual(a.prds.length, b.prds.length);
  });

  it("writeJson is atomic (no .tmp leftover)", async () => {
    await writeTask(p, makeTask("tsk-atomic001"));
    const dir = p.tasksDir;
    const tmpFiles = (await import("node:fs")).readdirSync(dir).filter((f) => f.endsWith(".tmp-"));
    assert.deepStrictEqual(tmpFiles, [], `unexpected tmp files: ${tmpFiles.join(", ")}`);
  });

  it("readJson throws on malformed JSON", async () => {
    const bad = join(p.tasksDir, "tsk-malformed.json");
    writeFileSync(bad, "{ not valid json", "utf-8");
    await assert.rejects(() => readTask(p, "tsk-malformed"));
    rmSync(bad);
  });

  it("readJson throws on shape mismatch", async () => {
    const bad = join(p.tasksDir, "tsk-wrongshape.json");
    writeFileSync(bad, JSON.stringify({ schema: "wrong.schema" }), "utf-8");
    await assert.rejects(() => readTask(p, "tsk-wrongshape"));
    rmSync(bad);
  });
});
