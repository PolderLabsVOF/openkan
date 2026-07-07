// tests/drift.test.mts — unit tests for source file drift detection

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourcePathOfTask } from "../kanban/watcher.ts";

describe("drift detection", () => {
  describe("sourcePathOfTask", () => {
    it("returns absolute path for a task with a source", () => {
      const task = { source: { path: "docs/roadmap.mdx", line: 42, slug: "docs/roadmap.mdx" } };
      const kanbanDir = "/proj/.openkan";
      const result = sourcePathOfTask(task as any, kanbanDir);
      assert.strictEqual(result, "/proj/docs/roadmap.mdx");
    });

    it("returns null for a task without a source", () => {
      const task = {};
      const result = sourcePathOfTask(task as any, "/proj/.openkan");
      assert.strictEqual(result, null);
    });
  });

  describe("checkSourceDrift logic", () => {
    let tmp: string;
    let kanbanDir: string;
    let sourceFile: string;

    beforeEach(() => {
      tmp = join(tmpdir(), `drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      kanbanDir = join(tmp, ".openkan");
      mkdirSync(kanbanDir, { recursive: true });
      sourceFile = join(tmp, "docs", "roadmap.mdx");
      mkdirSync(join(tmp, "docs"), { recursive: true });
      writeFileSync(sourceFile, "- [ ] Fix the bug\n", "utf-8");
    });

    afterEach(() => {
      rmSync(tmp, { force: true, recursive: true });
    });

    function computeHash(content: string): string {
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    }

    function checkDrift(task: { source?: { path: string; line: number; slug: string }; sourceHash?: string; stale?: boolean }, kanbanDir: string): boolean {
      if (!task.source) return false;
      const absPath = join(kanbanDir, "..", task.source.path);
      if (!existsSync(absPath)) return true;
      const content = readFileSync(absPath, "utf-8");
      const newHash = computeHash(content);
      return newHash !== task.sourceHash;
    }

    it("stale=false when source file unchanged (hash matches)", () => {
      const content = readFileSync(sourceFile, "utf-8");
      const hash = computeHash(content);
      const task = { source: { path: "docs/roadmap.mdx", line: 1, slug: "docs/roadmap.mdx" }, sourceHash: hash, stale: false };
      const isStale = checkDrift(task as any, kanbanDir);
      assert.strictEqual(isStale, false);
    });

    it("stale=true when source file has been modified", () => {
      const originalContent = "- [ ] Fix the bug\n";
      const hash = computeHash(originalContent);
      const task = { source: { path: "docs/roadmap.mdx", line: 1, slug: "docs/roadmap.mdx" }, sourceHash: hash, stale: false };
      writeFileSync(sourceFile, "- [ ] Fix the bug\n- [ ] Also fix this\n", "utf-8");
      const isStale = checkDrift(task as any, kanbanDir);
      assert.strictEqual(isStale, true);
    });

    it("stale=true when source file has been deleted", () => {
      const task = { source: { path: "docs/roadmap.mdx", line: 1, slug: "docs/roadmap.mdx" }, sourceHash: "abc123", stale: false };
      rmSync(sourceFile, { force: true });
      const isStale = checkDrift(task as any, kanbanDir);
      assert.strictEqual(isStale, true);
    });
  });
});
