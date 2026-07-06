// tests/inputs.test.mjs — unit tests for kanban/inputs.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listInputs, getPendingInput, addInput, respondInput, cancelInput } from "../kanban/inputs.ts";

describe("inputs", () => {
  let tmp: string;
  let taskId: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `inputs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    taskId = `tsk-${Date.now()}`;
    mkdirSync(join(tmp, taskId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  describe("addInput + listInputs", () => {
    it("adds an ask input and lists it", () => {
      const inp = addInput(taskId, tmp, { type: "ask", question: "What color?" });
      const all = listInputs(taskId, tmp);
      assert.ok(all.some(i => i.id === inp.id), "input should be in list");
      assert.strictEqual(inp.type, "ask");
      assert.strictEqual(inp.question, "What color?");
      assert.strictEqual(inp.status, "pending");
      assert.strictEqual(inp.taskId, taskId);
    });

    it("adds a choice input with options", () => {
      const options = [{ id: "a", label: "Red" }, { id: "b", label: "Blue" }];
      const inp = addInput(taskId, tmp, { type: "choice", question: "Pick one", options });
      const all = listInputs(taskId, tmp);
      assert.ok(all.some(i => i.id === inp.id));
      assert.deepStrictEqual(inp.options, options);
    });
  });

  describe("getPendingInput", () => {
    it("returns the pending input", () => {
      const inp1 = addInput(taskId, tmp, { type: "ask", question: "Q1" });
      const inp2 = addInput(taskId, tmp, { type: "ask", question: "Q2" });
      const pending = getPendingInput(taskId, tmp);
      // Either of the pending inputs is fine — verify it's one of ours
      assert.ok(pending?.id === inp1.id || pending?.id === inp2.id, "should return one of the pending inputs");
      assert.strictEqual(pending?.status, "pending");
    });

    it("returns null when no pending input", () => {
      const inp = addInput(taskId, tmp, { type: "ask", question: "Q1" });
      respondInput(taskId, tmp, inp.id, { value: "answer" });
      assert.strictEqual(getPendingInput(taskId, tmp), null);
    });
  });

  describe("respondInput", () => {
    it("flips status to responded and sets respondedAt", () => {
      const inp = addInput(taskId, tmp, { type: "ask", question: "What?" });
      const updated = respondInput(taskId, tmp, inp.id, { value: "answer text" });
      assert.strictEqual(updated.status, "responded");
      assert.strictEqual(updated.response, "answer text");
      assert.ok(updated.respondedAt);
    });

    it("records optionId for choice inputs", () => {
      const options = [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }];
      const inp = addInput(taskId, tmp, { type: "choice", question: "Color?", options });
      const updated = respondInput(taskId, tmp, inp.id, { optionId: "red" });
      assert.strictEqual(updated.responseOptionId, "red");
      assert.strictEqual(updated.status, "responded");
    });

    it("throws for unknown inputId", () => {
      assert.throws(() => respondInput(taskId, tmp, "inp-000000000000", { value: "x" }),
        /not found/);
    });
  });

  describe("cancelInput", () => {
    it("marks input as cancelled", () => {
      const inp = addInput(taskId, tmp, { type: "ask", question: "Cancel me?" });
      const updated = cancelInput(taskId, tmp, inp.id);
      assert.strictEqual(updated.status, "cancelled");
    });
  });
});
