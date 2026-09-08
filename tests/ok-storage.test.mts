// tests/ok-storage.test.mts — round-trip storage and atomic semantics.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  paths,
  initIfMissing,
  readTask, writeTask, listTasks,
  readTaskV2, writeTaskV2, listTasksV2,
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
    // Phase 1 dual-write: writeTask stores the v2 form. The v1 TaskPriority
    // "p1" is mapped to v2 Priority "high" by convertTaskV1ToV2.
    assert.strictEqual(got!.priority, "high");
  });

  it("writes a v2 task into its task directory", async () => {
    const task = {
      ...makeTask("tsk-v2000001"),
      schema: "ok.task.v2" as const,
      description: "",
      column: "todo" as const,
      order: 0,
      sessionId: null,
      agent: "",
      model: null,
      state: "idle" as const,
      lastError: null,
      artifact: "tasks/tsk-v2000001/task.mdx",
      sessionArtifact: null,
      pendingInputs: [],
      artifacts: { mdxPath: "tasks/tsk-v2000001/task.mdx", commentsPath: "tasks/tsk-v2000001/comments.json", inputsPath: "tasks/tsk-v2000001/inputs.json", statePath: "tasks/tsk-v2000001/state.json" },
      tags: [],
      category: "task" as const,
      priority: "normal" as const,
      effort: null,
      archived: false,
      assignees: [],
      images: [],
      parentId: null,
      subtaskIds: [],
    };
    await writeTaskV2(p, task);
    assert.ok(existsSync(join(p.tasksDir, task.id, "task.json")));
    assert.deepStrictEqual(await readTaskV2(p, task.id), task);
  });

  it("lists all v2 tasks", async () => {
    const tasks = await listTasksV2(p);
    assert.ok(tasks.find((x) => x.id === "tsk-v2000001"));
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
    // Phase 8+: v2 directory format
    const badDir = join(p.tasksDir, "tsk-malformed");
    mkdirSync(badDir, { recursive: true });
    const bad = join(badDir, "task.json");
    writeFileSync(bad, "{ not valid json", "utf-8");
    await assert.rejects(() => readTask(p, "tsk-malformed"));
    rmSync(badDir, { recursive: true, force: true });
  });

  it("readJson throws on shape mismatch", async () => {
    // Phase 8+: v2 directory format
    const badDir = join(p.tasksDir, "tsk-wrongshape");
    mkdirSync(badDir, { recursive: true });
    const bad = join(badDir, "task.json");
    writeFileSync(bad, JSON.stringify({ schema: "wrong.schema" }), "utf-8");
    await assert.rejects(() => readTask(p, "tsk-wrongshape"));
    rmSync(badDir, { recursive: true, force: true });
  });

  // ─── Phase 8: v2-only write ─────────────────────────────────────────

  it("writeTask writes v2 directory only (not flat file)", async () => {
    const id = "tsk-v2onlywrite01";
    await writeTask(p, makeTask(id, { title: "v2 only" }));
    const flat = join(p.tasksDir, `${id}.json`);
    const dirFile = join(p.tasksDir, id, "task.json");
    assert.strictEqual(existsSync(flat), false, "v1 flat file NOT written");
    assert.ok(existsSync(dirFile), "v2 directory task.json written");
    const v2Raw = JSON.parse(readFileSync(dirFile, "utf-8"));
    assert.strictEqual(v2Raw.schema, "ok.task.v2");
    assert.strictEqual(v2Raw.title, "v2 only");
  });

  // ─── Phase 8: v2-only read ──────────────────────────────────────────

  it("readTask reads v2 directory only, ignores v1 flat file", async () => {
    const id = "tsk-v2only01";
    await writeTask(p, makeTask(id, { title: "v2 only" }));
    // Overwrite the flat file with a sentinel that would fail validation
    // if read. v2-only read must skip the flat file entirely.
    const flat = join(p.tasksDir, `${id}.json`);
    writeFileSync(flat, JSON.stringify({ schema: "wrong.schema" }), "utf-8");
    const got = await readTask(p, id);
    assert.ok(got, "v2 directory is read");
    assert.strictEqual(got!.title, "v2 only");
  });

  it("readTask returns undefined when v2 directory is missing", async () => {
    const id = "tsk-nov2dir01";
    // Write only the v1 flat file (no directory form).
    const flat = join(p.tasksDir, `${id}.json`);
    const task = makeTask(id, { title: "v1 only" });
    writeFileSync(flat, JSON.stringify(task), "utf-8");
    const got = await readTask(p, id);
    // Phase 8: v2-only read returns undefined when no v2 exists
    assert.strictEqual(got, undefined);
  });

  it("listTasks returns only v2 directory tasks, filters orphaned v1", async () => {
    // Create a v2 task (should appear in list)
    await writeTask(p, makeTask("tsk-v2list01", { title: "v2 task" }));
    // Create a v1-only task (should NOT appear in list - it's orphaned)
    const v1OnlyPath = join(p.tasksDir, "tsk-v1only01.json");
    writeFileSync(v1OnlyPath, JSON.stringify(makeTask("tsk-v1only01", { title: "v1 only" })), "utf-8");

    const all = await listTasks(p);
    const v2Task = all.find((t) => t.id === "tsk-v2list01");
    const v1Only = all.find((t) => t.id === "tsk-v1only01");
    assert.ok(v2Task, "v2 task appears in list");
    assert.strictEqual(v1Only, undefined, "v1-only task is filtered out");
    // No duplicates by id.
    const ids = all.map((t) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids");
  });
});
