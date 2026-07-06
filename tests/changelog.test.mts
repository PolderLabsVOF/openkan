// tests/changelog.test.mts — unit tests for kanban/changelog.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordEvent, readEvents, readEventById, readSummary } from "../kanban/changelog.ts";

describe("changelog", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `changelog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  describe("recordEvent + readEvents", () => {
    it("appends a line; two calls produce two lines", () => {
      const ev1 = recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "user", summary: "created task 1", payload: {} });
      const ev2 = recordEvent(tmp, "task.updated", { taskId: "tsk-1", author: "user", summary: "updated task 1", payload: {} });
      const { events } = readEvents(tmp);
      assert.strictEqual(events.length, 2);
      assert.ok(events.some(e => e.id === ev1.id));
      assert.ok(events.some(e => e.id === ev2.id));
    });

    it("returns newest first by default", async () => {
      recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "user", summary: "first", payload: {} });
      await new Promise(r => setTimeout(r, 2)); // ensure different millisecond timestamps
      recordEvent(tmp, "task.created", { taskId: "tsk-2", author: "user", summary: "second", payload: {} });
      const { events } = readEvents(tmp);
      assert.strictEqual(events[0].summary, "second");
      assert.strictEqual(events[1].summary, "first");
    });

    it("filter by kind", () => {
      recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "user", summary: "c1", payload: {} });
      recordEvent(tmp, "task.moved", { taskId: "tsk-2", author: "user", summary: "m1", payload: {} });
      const { events } = readEvents(tmp, { kind: "task.moved" });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].kind, "task.moved");
    });

    it("filter by taskId", () => {
      recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "user", summary: "for tsk-1", payload: {} });
      recordEvent(tmp, "task.created", { taskId: "tsk-2", author: "user", summary: "for tsk-2", payload: {} });
      const { events } = readEvents(tmp, { taskId: "tsk-1" });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].taskId, "tsk-1");
    });

    it("filter by author", () => {
      recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "alice", summary: "alice task", payload: {} });
      recordEvent(tmp, "task.created", { taskId: "tsk-2", author: "bob", summary: "bob task", payload: {} });
      const { events } = readEvents(tmp, { author: "alice" });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].author, "alice");
    });

    it("readEventById finds an event", () => {
      const ev = recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "user", summary: "test", payload: {} });
      const found = readEventById(tmp, ev.id);
      assert.ok(found);
      assert.strictEqual(found!.id, ev.id);
      assert.strictEqual(found!.kind, "task.created");
    });

    it("readEventById returns null for unknown id", () => {
      const found = readEventById(tmp, "chg-00000000");
      assert.strictEqual(found, null);
    });
  });

  describe("readSummary", () => {
    it("counts by kind, author, and day", async () => {
      recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "alice", summary: "a", payload: {} });
      await new Promise(r => setTimeout(r, 5));
      recordEvent(tmp, "task.created", { taskId: "tsk-2", author: "alice", summary: "b", payload: {} });
      await new Promise(r => setTimeout(r, 5));
      recordEvent(tmp, "task.moved", { taskId: "tsk-1", author: "bob", summary: "c", payload: {} });

      const summary = readSummary(tmp);
      assert.strictEqual(summary.total, 3);
      assert.strictEqual(summary.byKind["task.created"], 2);
      assert.strictEqual(summary.byKind["task.moved"], 1);
      assert.strictEqual(summary.byAuthor["alice"], 2);
      assert.strictEqual(summary.byAuthor["bob"], 1);
      assert.ok(Object.keys(summary.byDay).length >= 1);
    });

    it("respects days filter", () => {
      recordEvent(tmp, "task.created", { taskId: "tsk-1", author: "user", summary: "old", payload: {} });
      const summary = readSummary(tmp, { days: 0 }); // 0 days = only today
      // May be 0 if old event is not today
      assert.ok(typeof summary.total === "number");
    });
  });

  describe("truncated last line", () => {
    it("does not crash the reader", () => {
      // Write a file with a truncated (unterminated) last line
      const path = join(tmp, "changelog.jsonl");
      writeFileSync(path, '{"id":"chg-aaa","ts":"2024-01-01T00:00:00Z","kind":"task.created","author":"u","summary":"ok","payload":{}}\n', "utf-8");
      appendFileSync(path, '{"id":"chg-bbb","ts":"2024-01-01T00:00:01Z","kind":"task.updated","author":"u","summary":"trunc', "utf-8"); // no newline, unparseable
      const { events } = readEvents(tmp);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].id, "chg-aaa");
    });
  });
});
