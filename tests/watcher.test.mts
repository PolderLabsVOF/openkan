// tests/watcher.test.mts — unit tests for kanban/watcher.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watch } from "../kanban/watcher.ts";

describe("watcher", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  // ─── Basic delivery ─────────────────────────────────────────────────────────

  it("delivers an event when a file is created", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "board.json"), '{"version":1}', "utf-8");
      const ev = await firstEvent(w.events, 500);
      assert.ok(ev, "expected at least one event");
      // fs.watch on Linux may emit "rename" for new files; accept both.
      assert.ok(ev.kind === "change" || ev.kind === "rename",
        `expected change or rename, got ${ev.kind}`);
      assert.ok(ev.path.endsWith("board.json"), `expected board.json in path, got ${ev.path}`);
      assert.strictEqual(ev.absPath, join(tmp, "board.json"));
      assert.ok(ev.ts, "ts should be set");
    } finally {
      w.close();
    }
  });

  it("delivers a rename event when a file is created (macOS may use rename)", async () => {
    const w = watch({ root: tmp });
    try {
      const path = join(tmp, "new-file.txt");
      writeFileSync(path, "hello", "utf-8");
      const ev = await firstEvent(w.events, 500);
      assert.ok(ev, "expected at least one event");
      // Both "change" and "rename" are acceptable
      assert.ok(ev.kind === "change" || ev.kind === "rename",
        `expected change or rename, got ${ev.kind}`);
    } finally {
      w.close();
    }
  });

  it("delivers events for subdirectory files", async () => {
    const subdir = join(tmp, "tasks", "tsk-001");
    mkdirSync(subdir, { recursive: true });
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(subdir, "task.mdx"), "# Task\n", "utf-8");
      const ev = await firstEvent(w.events, 500);
      assert.ok(ev, "expected at least one event");
      assert.ok(ev.path.includes("tasks"), `expected tasks in path, got ${ev.path}`);
    } finally {
      w.close();
    }
  });

  // ─── Filtering ──────────────────────────────────────────────────────────────

  it("suppresses server.lock", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "server.lock"), "7777", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "server.lock should be filtered");
      assert.strictEqual(w.stats.filtered, 1);
    } finally {
      w.close();
    }
  });

  it("suppresses server.pid", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "server.pid"), "12345", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "server.pid should be filtered");
    } finally {
      w.close();
    }
  });

  it("suppresses server.log", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "server.log"), "starting...\n", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "server.log should be filtered");
    } finally {
      w.close();
    }
  });

  it("suppresses changelog.jsonl", async () => {
    const w = watch({ root: tmp });
    try {
      appendFileSync(join(tmp, "changelog.jsonl"), '{"id":"1"}\n', "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "changelog.jsonl should be filtered");
    } finally {
      w.close();
    }
  });

  it("suppresses node_modules paths", async () => {
    const nm = join(tmp, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(nm, "index.js"), "module.exports = 1", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "node_modules files should be filtered");
    } finally {
      w.close();
    }
  });

  it("suppresses .tmp files", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "data.tmp"), "temp", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, ".tmp files should be filtered");
    } finally {
      w.close();
    }
  });

  it("applies custom ignore function", async () => {
    const w = watch({
      root: tmp,
      ignore: (p) => p.endsWith("secret.txt"),
    });
    try {
      writeFileSync(join(tmp, "secret.txt"), "s3cret", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "custom ignored file should not deliver event");
    } finally {
      w.close();
    }
  });

  it("custom ignore does not affect default ignores", async () => {
    const w = watch({
      root: tmp,
      ignore: (p) => p.endsWith("other.bin"),
    });
    try {
      writeFileSync(join(tmp, "server.lock"), "7777", "utf-8");
      const ev = await firstEvent(w.events, 300);
      assert.strictEqual(ev, null, "server.lock should still be filtered by default");
    } finally {
      w.close();
    }
  });

  // ─── Non-existent root ─────────────────────────────────────────────────────

  it("does not crash when watching a non-existent directory", async () => {
    const nonExistent = join(tmpdir(), `nonexistent-${Date.now()}`);
    const w = watch({ root: nonExistent });
    // Should return a working handle — no crash
    w.close(); // clean up
  });

  // ─── Close mid-event ───────────────────────────────────────────────────────

  it("delivers no events after close", async () => {
    const w = watch({ root: tmp });
    w.close();
    // After close, writeFileSync should not cause issues
    writeFileSync(join(tmp, "after-close.txt"), "data", "utf-8");
    // Wait a short time and confirm no event is delivered
    const ev = await firstEvent(w.events, 200);
    assert.strictEqual(ev, null, "no event should be delivered after close");
  });

  it("close() is idempotent", () => {
    const w = watch({ root: tmp });
    w.close();
    w.close(); // should not throw
  });

  // ─── Debounce ──────────────────────────────────────────────────────────────

  it("two writes within debounce window produce one event", async () => {
    const w = watch({ root: tmp, debounceMs: 100 });
    try {
      const file = join(tmp, "board.json");
      writeFileSync(file, '{"v":1}', "utf-8");
      // Second write immediately after
      writeFileSync(file, '{"v":2}', "utf-8");
      const ev = await firstEvent(w.events, 400);
      assert.ok(ev, "expected at least one event");
      // Should deliver exactly one event (the first, or the last — deterministic)
      // Wait to confirm no second event arrives
      const ev2 = await firstEvent(w.events, 400);
      assert.strictEqual(ev2, null, "should be exactly one event due to debounce");
    } finally {
      w.close();
    }
  });

  it("two writes with delay between them produce two events", async () => {
    const w = watch({ root: tmp, debounceMs: 80 });
    try {
      writeFileSync(join(tmp, "file1.txt"), "a", "utf-8");
      await new Promise(r => setTimeout(r, 150)); // longer than debounce
      writeFileSync(join(tmp, "file2.txt"), "b", "utf-8");
      // Wait for both events to arrive (debounce coalesces within each write burst)
      await new Promise(r => setTimeout(r, 300));
      // Now collect them
      const ev1 = await firstEvent(w.events, 100);
      const ev2 = await firstEvent(w.events, 100);
      assert.ok(ev1, "expected first event");
      assert.ok(ev2, "expected second event");
      assert.notStrictEqual(ev1.path, ev2.path);
    } finally {
      w.close();
    }
  });

  // ─── Stats ─────────────────────────────────────────────────────────────────

  it("stats.started increments for all raw events", async () => {
    const w = watch({ root: tmp, debounceMs: 50 });
    try {
      writeFileSync(join(tmp, "a.txt"), "a", "utf-8");
      writeFileSync(join(tmp, "b.txt"), "b", "utf-8");
      await firstEvent(w.events, 400);
      assert.ok(w.stats.started >= 2, `expected started >= 2, got ${w.stats.started}`);
    } finally {
      w.close();
    }
  });

  it("stats.delivered increments per debounced event", async () => {
    const w = watch({ root: tmp, debounceMs: 50 });
    try {
      const file = join(tmp, "board.json");
      writeFileSync(file, '{"v":1}', "utf-8");
      writeFileSync(file, '{"v":2}', "utf-8");
      await firstEvent(w.events, 400);
      assert.strictEqual(w.stats.delivered, 1, "debounced writes should produce one delivered event");
    } finally {
      w.close();
    }
  });

  it("stats.filtered increments per ignored file", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "server.lock"), "1", "utf-8");
      writeFileSync(join(tmp, "server.pid"), "2", "utf-8");
      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(w.stats.filtered, 2, "expected 2 filtered events");
    } finally {
      w.close();
    }
  });

  it("stats are available immediately after watch() call", () => {
    const w = watch({ root: tmp });
    assert.strictEqual(w.stats.started, 0);
    assert.strictEqual(w.stats.delivered, 0);
    assert.strictEqual(w.stats.filtered, 0);
    w.close();
  });

  // ─── Event shape ───────────────────────────────────────────────────────────

  it("event path is relative to root", async () => {
    const subdir = join(tmp, "tasks", "tsk-001");
    mkdirSync(subdir, { recursive: true });
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(subdir, "task.mdx"), "# Hi\n", "utf-8");
      const ev = await firstEvent(w.events, 500);
      assert.ok(ev, "expected an event");
      assert.ok(!ev.path.startsWith("/"), "path should be relative");
      assert.ok(ev.path.includes("tasks"), "path should contain tasks");
      assert.strictEqual(ev.absPath, join(subdir, "task.mdx"));
    } finally {
      w.close();
    }
  });

  it("event ts is ISO format", async () => {
    const w = watch({ root: tmp });
    try {
      writeFileSync(join(tmp, "file.txt"), "data", "utf-8");
      const ev = await firstEvent(w.events, 500);
      assert.ok(ev, "expected an event");
      assert.ok(!isNaN(Date.parse(ev.ts)), `ts should be valid ISO: ${ev.ts}`);
    } finally {
      w.close();
    }
  });

  // ─── Multiple files ───────────────────────────────────────────────────────

  it("delivers separate events for separate files", async () => {
    const w = watch({ root: tmp, debounceMs: 50 });
    try {
      writeFileSync(join(tmp, "file1.txt"), "a", "utf-8");
      await new Promise(r => setTimeout(r, 120));
      writeFileSync(join(tmp, "file2.txt"), "b", "utf-8");
      // Wait for both events to arrive
      await new Promise(r => setTimeout(r, 250));
      const ev1 = await firstEvent(w.events, 100);
      const ev2 = await firstEvent(w.events, 100);
      assert.ok(ev1, "expected first event");
      assert.ok(ev2, "expected second event");
      assert.notStrictEqual(ev1.path, ev2.path);
    } finally {
      w.close();
    }
  });

  // ─── Helper ─────────────────────────────────────────────────────────────────

  /** Wait up to `timeoutMs` for the next event from an AsyncIterable. */
  async function firstEvent(
    events: AsyncIterable<{ kind: string; path: string; absPath: string; ts: string }>,
    timeoutMs: number,
  ): Promise<{ kind: string; path: string; absPath: string; ts: string } | null> {
    const timeout = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs),
    );
    try {
      const result = await Promise.race([
        (async () => {
          for await (const ev of events) return ev;
          return null;
        })(),
        timeout,
      ]);
      return result ?? null;
    } catch {
      return null;
    }
  }
});
