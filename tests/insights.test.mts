// tests/insights.test.mts — unit tests for kanban/insights.ts
//
// Verifies the velocity aggregator:
// - Empty / missing changelog → zero-filled arrays of length 30
// - 30-day window truncates events older than 30 days
// - Mixed event kinds aggregate per day and per column
// - JSONL parse error in one line does not abort the whole computation

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordEvent } from "../kanban/changelog.ts";
import { computeVelocity } from "../kanban/insights.ts";

describe("insights — computeVelocity", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `insights-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("returns zero-filled arrays when changelog is missing", () => {
    const v = computeVelocity(tmp, 30);
    assert.strictEqual(v.days.length, 30);
    assert.strictEqual(v.backlog.length, 30);
    assert.strictEqual(v.todo.length, 30);
    assert.strictEqual(v.doing.length, 30);
    assert.strictEqual(v.review.length, 30);
    assert.strictEqual(v.done.length, 30);
    assert.strictEqual(v.windowDays, 30);
    // Every bucket must be zero.
    for (const arr of [v.backlog, v.todo, v.doing, v.review, v.done]) {
      for (const n of arr) assert.strictEqual(n, 0);
    }
    // Day labels must be oldest-first consecutive local dates.
    assert.ok(v.days[0]! < v.days[29]!, "days[0] must be earlier than days[29]");
  });

  it("returns zero-filled arrays when changelog exists but has no task events", () => {
    writeFileSync(
      join(tmp, "changelog.jsonl"),
      JSON.stringify({
        id: "chg-aaa",
        ts: new Date().toISOString(),
        kind: "agent.started",
        author: "system",
        summary: "agent started",
        payload: {},
      }) + "\n",
      "utf-8",
    );
    const v = computeVelocity(tmp, 30);
    assert.strictEqual(v.backlog.reduce((a, b) => a + b, 0), 0);
    assert.strictEqual(v.done.reduce((a, b) => a + b, 0), 0);
  });

  it("buckets a today task.created event into the right column", () => {
    const today = new Date();
    recordEvent(tmp, "task.created", {
      taskId: "tsk-1",
      author: "user",
      summary: "created 'foo'",
      payload: { column: "todo" },
    });
    const v = computeVelocity(tmp, 30);
    const total = v.todo.reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 1, "task.created into todo should add 1 to todo");
    assert.strictEqual(v.backlog.reduce((a, b) => a + b, 0), 0);
    assert.strictEqual(v.doing.reduce((a, b) => a + b, 0), 0);
    assert.strictEqual(v.review.reduce((a, b) => a + b, 0), 0);
    assert.strictEqual(v.done.reduce((a, b) => a + b, 0), 0);
    // The bucket must be the last day in the window.
    assert.strictEqual(v.todo[v.todo.length - 1], 1);
    // Sanity: the timestamp today matches todayLocal.
    assert.strictEqual(v.days[v.days.length - 1], today.toLocaleDateString("en-CA"));
  });

  it("buckets task.moved events across multiple days and columns", () => {
    // Manually write events at specific days to control bucketing.
    const day1 = new Date();
    day1.setDate(day1.getDate() - 5);
    const day2 = new Date();
    day2.setDate(day2.getDate() - 2);

    writeFileSync(join(tmp, "changelog.jsonl"), [
      JSON.stringify({
        id: "chg-1",
        ts: day1.toISOString(),
        kind: "task.created",
        author: "user",
        taskId: "tsk-A",
        summary: "created 'A'",
        payload: { column: "backlog" },
      }),
      JSON.stringify({
        id: "chg-2",
        ts: day1.toISOString(),
        kind: "task.moved",
        author: "user",
        taskId: "tsk-A",
        summary: "moved 'A' to todo",
        payload: { from: "todo" }, // existing quirk: payload.from is destination
      }),
      JSON.stringify({
        id: "chg-3",
        ts: day1.toISOString(),
        kind: "task.moved",
        author: "user",
        taskId: "tsk-A",
        summary: "moved 'A' to doing",
        payload: { from: "doing" },
      }),
      JSON.stringify({
        id: "chg-4",
        ts: day2.toISOString(),
        kind: "task.moved",
        author: "user",
        taskId: "tsk-A",
        summary: "moved 'A' to review",
        payload: { from: "review" },
      }),
      JSON.stringify({
        id: "chg-5",
        ts: day2.toISOString(),
        kind: "task.moved",
        author: "user",
        taskId: "tsk-A",
        summary: "moved 'A' to done",
        payload: { from: "done" },
      }),
    ].join("\n") + "\n", "utf-8");

    const v = computeVelocity(tmp, 30);
    // The total moves-into counts:
    // day-5: backlog +1, todo +1, doing +1 (then -1 from backlog, -1 from todo → net 0,0,1)
    // day-2: review +1, done +1 (with -1 from doing and -1 from review → net 0,1)
    const backlogTotal = v.backlog.reduce((a, b) => a + b, 0);
    const todoTotal = v.todo.reduce((a, b) => a + b, 0);
    const doingTotal = v.doing.reduce((a, b) => a + b, 0);
    const reviewTotal = v.review.reduce((a, b) => a + b, 0);
    const doneTotal = v.done.reduce((a, b) => a + b, 0);
    assert.strictEqual(backlogTotal, 0, "backlog net (created-in then moved-out)");
    assert.strictEqual(todoTotal, 0, "todo net (moved-in then moved-out)");
    assert.strictEqual(doingTotal, 0, "doing net (moved-in then moved-out)");
    assert.strictEqual(reviewTotal, 0, "review net (moved-in then moved-out)");
    assert.strictEqual(doneTotal, 1, "done net (only final destination)");
  });

  it("ignores events older than the window", () => {
    const old = new Date();
    old.setDate(old.getDate() - 60);
    writeFileSync(join(tmp, "changelog.jsonl"), [
      JSON.stringify({
        id: "chg-old",
        ts: old.toISOString(),
        kind: "task.created",
        author: "user",
        taskId: "tsk-old",
        summary: "old",
        payload: { column: "todo" },
      }),
    ].join("\n") + "\n", "utf-8");
    const v = computeVelocity(tmp, 30);
    assert.strictEqual(v.todo.reduce((a, b) => a + b, 0), 0);
    assert.strictEqual(v.backlog.reduce((a, b) => a + b, 0), 0);
  });

  it("does not abort when a JSONL line is corrupt", () => {
    // Write 5 valid lines then inject a corrupt line in the middle.
    const today = new Date().toISOString();
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        id: `chg-${i}`,
        ts: today,
        kind: "task.created",
        author: "user",
        taskId: `tsk-${i}`,
        summary: `created ${i}`,
        payload: { column: "backlog" },
      }));
    }
    const path = join(tmp, "changelog.jsonl");
    writeFileSync(path, lines[0] + "\n", "utf-8");
    appendFileSync(path, "{not valid json\n", "utf-8"); // corrupt
    appendFileSync(path, lines.slice(1).join("\n") + "\n", "utf-8");

    const v = computeVelocity(tmp, 30);
    const backlogTotal = v.backlog.reduce((a, b) => a + b, 0);
    assert.strictEqual(backlogTotal, 5, "all 5 valid task.created events should bucket into backlog");
  });

  it("respects the requested days window length", () => {
    const v7 = computeVelocity(tmp, 7);
    assert.strictEqual(v7.days.length, 7);
    assert.strictEqual(v7.backlog.length, 7);
    assert.strictEqual(v7.windowDays, 7);

    const v1 = computeVelocity(tmp, 1);
    assert.strictEqual(v1.days.length, 1);

    const v365 = computeVelocity(tmp, 365);
    assert.strictEqual(v365.days.length, 365);
  });

  it("handles task.moved without prior history gracefully", () => {
    // A move with no preceding created event: no move-out, just move-in.
    writeFileSync(join(tmp, "changelog.jsonl"), [
      JSON.stringify({
        id: "chg-only",
        ts: new Date().toISOString(),
        kind: "task.moved",
        author: "user",
        taskId: "tsk-orphan",
        summary: "moved 'orphan' to review",
        payload: { from: "review" },
      }),
    ].join("\n") + "\n", "utf-8");
    const v = computeVelocity(tmp, 30);
    assert.strictEqual(v.review.reduce((a, b) => a + b, 0), 1);
    // No negative buckets anywhere.
    for (const arr of [v.backlog, v.todo, v.doing, v.review, v.done]) {
      for (const n of arr) assert.ok(n >= 0, "no negative buckets");
    }
  });
});
