// tests/changelog-fix.test.mts — tests for reset=true in readEvents /api/changelog

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initBoard, setProjectRoot, type Task } from "../kanban/board.ts";
import { apiGetChangelog } from "../kanban/server.ts";
import { recordEvent, readEvents } from "../kanban/changelog.ts";

describe("changelog reset parameter", () => {
  let tmp: string;
  let ctx: any;

  beforeEach(async () => {
    tmp = join(tmpdir(), `changelog-reset-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmp, ".ok", "tasks"), { recursive: true });
    ctx = { directory: tmp, client: null as any, log: async () => {} };
    await initBoard(ctx);
    setProjectRoot(tmp);

    // Record 5 events
    for (let i = 1; i <= 5; i++) {
      recordEvent(join(tmp, ".ok"), "task.created", {
        taskId: `tsk-${i}`,
        author: "user",
        summary: `created task ${i}`,
        payload: {},
      });
    }
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  it("readEvents({ reset: true }) ignores offset and returns from start", async () => {
    // First, get all events with offset=0, no reset
    const { events: allEvents, total } = readEvents(join(tmp, ".ok"), { offset: 0 });
    assert.strictEqual(total, 5);

    // With offset=2 (no reset), should skip first 2
    const { events: page2 } = readEvents(join(tmp, ".ok"), { offset: 2 });
    assert.strictEqual(page2.length, 3);
    assert.strictEqual(page2[0].summary, "created task 3"); // task 5, 4, 3

    // With reset=true AND offset=2, should ignore offset and return all 5
    const { events: resetPage2 } = readEvents(join(tmp, ".ok"), { offset: 2, reset: true });
    assert.strictEqual(resetPage2.length, 5);
    assert.strictEqual(resetPage2[0].summary, "created task 5");
  });

  it("readEvents({ reset: true }) returns all events with limit applied", async () => {
    const { events, total } = readEvents(join(tmp, ".ok"), { reset: true, limit: 3 });
    assert.strictEqual(total, 5); // total is still 5 (unpaged)
    assert.strictEqual(events.length, 3); // but only 3 returned
    assert.strictEqual(events[0].summary, "created task 5");
  });

  it("GET /api/changelog?reset=true returns all events regardless of offset", async () => {
    // First request with offset=3 (no reset)
    const req1 = new Request("http://localhost/api/changelog?offset=3", { method: "GET" });
    const res1 = await apiGetChangelog(req1);
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json();
    assert.strictEqual(body1.events.length, 2); // only 2 remaining

    // Second request with reset=true and offset=3
    const req2 = new Request("http://localhost/api/changelog?reset=true&offset=3", { method: "GET" });
    const res2 = await apiGetChangelog(req2);
    assert.strictEqual(res2.status, 200);
    const body2 = await res2.json();
    assert.strictEqual(body2.events.length, 5); // all 5 returned
    assert.strictEqual(body2.total, 5);
  });

  it("GET /api/changelog includes Cache-Control: no-cache, no-transform header", async () => {
    const req = new Request("http://localhost/api/changelog", { method: "GET" });
    const res = await apiGetChangelog(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("Cache-Control"), "no-cache, no-transform");
  });
});
