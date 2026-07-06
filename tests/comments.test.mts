// tests/comments.test.mjs — unit tests for kanban/comments.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listComments, addComment, deleteComment, resolveComment } from "../kanban/comments.ts";

describe("comments", () => {
  let tmp: string;
  let taskId: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `comments-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    taskId = `tsk-${Date.now()}`;
    mkdirSync(join(tmp, taskId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  describe("addComment + listComments", () => {
    it("adds a user comment and lists it", () => {
      const c = addComment(taskId, tmp, { blockId: "blk-abc", line: 5, text: "Looks good", author: "user" });
      const all = listComments(taskId, tmp);
      assert.ok(all.some(x => x.id === c.id));
      assert.strictEqual(c.author, "user");
      assert.strictEqual(c.blockId, "blk-abc");
      assert.strictEqual(c.line, 5);
      assert.strictEqual(c.resolved, false);
    });

    it("adds an agent comment", () => {
      const c = addComment(taskId, tmp, { blockId: "blk-xyz", line: 10, text: "Fixed", author: "agent" });
      const all = listComments(taskId, tmp);
      assert.ok(all.some(x => x.id === c.id));
      assert.strictEqual(c.author, "agent");
    });

    it("sorts newest first", async () => {
      // Use a delay to ensure distinct timestamps
      addComment(taskId, tmp, { blockId: "blk-1", line: 1, text: "First", author: "user" });
      await new Promise(r => setTimeout(r, 5));
      addComment(taskId, tmp, { blockId: "blk-2", line: 2, text: "Second", author: "user" });
      const all = listComments(taskId, tmp);
      assert.strictEqual(all[0].text, "Second");
      assert.strictEqual(all[1].text, "First");
    });
  });

  describe("deleteComment", () => {
    it("deletes an existing comment", () => {
      const c = addComment(taskId, tmp, { blockId: "blk-x", line: 1, text: "To delete", author: "user" });
      const ok = deleteComment(taskId, tmp, c.id);
      assert.strictEqual(ok, true);
      const all = listComments(taskId, tmp);
      assert.ok(!all.some(x => x.id === c.id));
    });

    it("returns false for unknown comment", () => {
      const ok = deleteComment(taskId, tmp, "cmt-00000000");
      assert.strictEqual(ok, false);
    });
  });

  describe("resolveComment", () => {
    it("sets resolved=true", () => {
      const c = addComment(taskId, tmp, { blockId: "blk-x", line: 1, text: "Fix this", author: "user" });
      const updated = resolveComment(taskId, tmp, c.id, true);
      assert.ok(updated);
      assert.strictEqual(updated!.resolved, true);
    });

    it("sets resolved=false", () => {
      const c = addComment(taskId, tmp, { blockId: "blk-x", line: 1, text: "Unresolve", author: "user" });
      resolveComment(taskId, tmp, c.id, true);
      const updated = resolveComment(taskId, tmp, c.id, false);
      assert.strictEqual(updated!.resolved, false);
    });

    it("returns null for unknown comment", () => {
      const result = resolveComment(taskId, tmp, "cmt-00000000", true);
      assert.strictEqual(result, null);
    });
  });
});
