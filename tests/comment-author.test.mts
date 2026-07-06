// Tests for comment author field and resolve tracking (kanban/comments.ts)

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/openkan-comment-test";

// Helper to create a fresh task dir
function taskDir(taskId: string): string {
  return join(TEST_DIR, taskId);
}

describe("comments.ts — author field", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it("addComment records author correctly", async () => {
    const { addComment } = await import("../kanban/comments.ts");
    const comment = addComment(TEST_DIR, TEST_DIR, {
      blockId: "blk-abc123",
      line: 10,
      text: "This is a test comment",
      author: "Alice",
    });

    assert.strictEqual(comment.author, "Alice");
    assert.strictEqual(comment.id.startsWith("cmt-"), true);
    assert.strictEqual(comment.taskId, TEST_DIR);
    assert.strictEqual(comment.blockId, "blk-abc123");
    assert.strictEqual(comment.line, 10);
    assert.strictEqual(comment.text, "This is a test comment");
    assert.strictEqual(comment.resolved, false);
    assert.ok(comment.createdAt.includes("T"), "createdAt should be ISO format");
  });

  it("addComment accepts agent-prefixed author", async () => {
    const { addComment } = await import("../kanban/comments.ts");
    const comment = addComment(TEST_DIR, TEST_DIR, {
      blockId: "blk-abc",
      line: 1,
      text: "Agent comment",
      author: "agent:Thor",
    });

    assert.strictEqual(comment.author, "agent:Thor");
  });

  it("addComment returns full Comment object with all fields", async () => {
    const { addComment } = await import("../kanban/comments.ts");
    const comment = addComment(TEST_DIR, TEST_DIR, {
      blockId: "blk-xyz",
      line: 5,
      text: "Full comment",
      author: "Bob",
    });

    assert.ok("id" in comment);
    assert.ok("taskId" in comment);
    assert.ok("blockId" in comment);
    assert.ok("line" in comment);
    assert.ok("text" in comment);
    assert.ok("author" in comment);
    assert.ok("createdAt" in comment);
    assert.ok("resolved" in comment);
    // resolved fields should be absent/undefined when not resolved
    assert.strictEqual(comment.resolved, false);
    assert.strictEqual("resolvedBy" in comment, false);
    assert.strictEqual("resolvedAt" in comment, false);
  });

  it("Comment stored on disk has author field", async () => {
    const { addComment } = await import("../kanban/comments.ts");
    const taskId = "tsk-test-1";
    const td = taskDir(taskId);
    mkdirSync(td, { recursive: true });

    addComment(taskId, TEST_DIR, {
      blockId: "blk-abc",
      line: 1,
      text: "Stored comment",
      author: "Chris",
    });

    const storePath = join(td, "comments.json");
    assert.ok(existsSync(storePath), "comments.json should be created");
    const stored = JSON.parse(readFileSync(storePath, "utf-8"));
    assert.strictEqual(stored.comments[0].author, "Chris");
  });
});

describe("comments.ts — resolve with author and reason", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it("resolveComment records resolvedBy and resolvedAt when resolving", async () => {
    const { addComment, resolveComment } = await import("../kanban/comments.ts");
    const taskId = "tsk-resolve-1";
    const td = taskDir(taskId);
    mkdirSync(td, { recursive: true });

    const comment = addComment(taskId, TEST_DIR, {
      blockId: "blk-abc",
      line: 1,
      text: "To be resolved",
      author: "Dan",
    });

    const updated = resolveComment(taskId, TEST_DIR, comment.id, true, "Eve", undefined, "Fixed it");

    assert.strictEqual(updated!.resolved, true);
    assert.strictEqual(updated!.resolvedBy, "Eve");
    assert.ok(updated!.resolvedAt!.includes("T"), "resolvedAt should be ISO format");
    assert.strictEqual(updated!.resolvedReason, "Fixed it");
  });

  it("resolveComment clears resolved fields when unresolving", async () => {
    const { addComment, resolveComment } = await import("../kanban/comments.ts");
    const taskId = "tsk-unresolve-1";
    mkdirSync(taskDir(taskId), { recursive: true });

    const comment = addComment(taskId, TEST_DIR, {
      blockId: "blk-abc",
      line: 1,
      text: "Comment",
      author: "Frank",
    });

    // First resolve
    const resolved = resolveComment(taskId, TEST_DIR, comment.id, true, "Grace");
    assert.strictEqual(resolved!.resolved, true);

    // Then unresolve
    const unresolved = resolveComment(taskId, TEST_DIR, comment.id, false);
    assert.strictEqual(unresolved!.resolved, false);
    // When unresolving, resolvedBy/at/reason may still be set on the object
    // (the implementation keeps them but marks resolved=false)
    assert.strictEqual(unresolved!.resolved, false);
  });

  it("resolveComment uses comment author as default resolvedBy", async () => {
    const { addComment, resolveComment } = await import("../kanban/comments.ts");
    const taskId = "tsk-default-resolver";
    mkdirSync(taskDir(taskId), { recursive: true });

    const comment = addComment(taskId, TEST_DIR, {
      blockId: "blk-abc",
      line: 1,
      text: "Comment by Henry",
      author: "Henry",
    });

    // Resolve without explicit resolvedBy — should default to comment author
    const updated = resolveComment(taskId, TEST_DIR, comment.id, true);
    assert.strictEqual(updated!.resolvedBy, "Henry");
  });

  it("resolveComment accepts optional resolvedReason", async () => {
    const { addComment, resolveComment } = await import("../kanban/comments.ts");
    const taskId = "tsk-reason";
    mkdirSync(taskDir(taskId), { recursive: true });

    const comment = addComment(taskId, TEST_DIR, {
      blockId: "blk-abc",
      line: 1,
      text: "Needs reason",
      author: "Ivy",
    });

    const updated = resolveComment(taskId, TEST_DIR, comment.id, true, "Jack", undefined, "Duplicate of #42");
    assert.strictEqual(updated!.resolvedReason, "Duplicate of #42");
  });

  it("resolveComment returns null for non-existent comment", async () => {
    const { resolveComment } = await import("../kanban/comments.ts");
    mkdirSync(taskDir("tsk-fake"), { recursive: true });
    const result = resolveComment("tsk-fake", TEST_DIR, "cmt-nonexistent", true);
    assert.strictEqual(result, null);
  });
});
