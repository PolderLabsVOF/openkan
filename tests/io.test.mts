// tests/io.test.mjs — unit tests for kanban/io.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic, ensureDir, cleanupStaleTmp, removeDir } from "../kanban/io.ts";

describe("io", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `io-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    removeDir(tmp);
  });

  describe("writeFileAtomic", () => {
    it("round-trips a text file correctly", () => {
      const file = join(tmp, "test.txt");
      writeFileAtomic(file, "hello world");
      const content = readFileSync(file, "utf-8");
      assert.strictEqual(content, "hello world");
    });

    it("overwrites existing file", () => {
      const file = join(tmp, "test.txt");
      writeFileSync(file, "old", "utf-8");
      writeFileAtomic(file, "new");
      const content = readFileSync(file, "utf-8");
      assert.strictEqual(content, "new");
    });

    it("round-trips a binary buffer", () => {
      const file = join(tmp, "bin.dat");
      const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      writeFileAtomic(file, buf);
      const read = readFileSync(file);
      assert.deepStrictEqual(read, buf);
    });
  });

  describe("ensureDir", () => {
    it("creates a nested directory", () => {
      const dir = join(tmp, "a", "b", "c");
      ensureDir(dir);
      assert.ok(statSync(dir).isDirectory());
    });

    it("is idempotent", () => {
      const dir = join(tmp, "a", "b");
      ensureDir(dir);
      ensureDir(dir);
      assert.ok(statSync(dir).isDirectory());
    });
  });

  describe("cleanupStaleTmp", () => {
    it("removes only .tmp files older than maxAgeMs", async () => {
      const old = join(tmp, "old.tmp");
      const recent = join(tmp, "recent.tmp");
      const notTmp = join(tmp, "file.txt");

      writeFileSync(old, "old");
      writeFileSync(recent, "recent");
      writeFileSync(notTmp, "txt");

      // Make old file appear 2 hours old
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(old, twoHoursAgo / 1000, twoHoursAgo / 1000);

      cleanupStaleTmp(tmp, 60 * 60 * 1000); // 1 hour max age

      assert.ok(!existsSync(old), "old tmp should be removed");
      assert.ok(existsSync(recent), "recent tmp should remain");
      assert.ok(existsSync(notTmp), "non-tmp file should remain");
    });

    it("ignores missing directory", () => {
      cleanupStaleTmp(join(tmp, "nonexistent"));
      // No throw
    });
  });

  describe("removeDir", () => {
    it("removes a directory and its contents", () => {
      const dir = join(tmp, "to-remove");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "file.txt"), "hello");
      removeDir(dir);
      assert.ok(!existsSync(dir));
    });

    it("ignores missing directory", () => {
      removeDir(join(tmp, "nonexistent"));
      // No throw
    });

    it("removes a file", () => {
      const file = join(tmp, "file.txt");
      writeFileSync(file, "hello");
      removeDir(file);
      assert.ok(!existsSync(file));
    });
  });
});
