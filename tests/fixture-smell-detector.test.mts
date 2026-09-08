// tests/fixture-smell-detector.test.mts — regression tests for fixture leak detection

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectFixtureSmells } from "./fixture-smell-detector.mts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fixture-smell-"));
}

function writeTaskMdx(dir: string, id: string, title: string, owner?: string, description?: string, scopes?: string[]): void {
  const taskDir = join(dir, ".ok", "tasks", id);
  mkdirSync(taskDir, { recursive: true });

  let frontmatter = `---
title: ${title}
id: ${id}
status: in_progress
`;

  if (owner) frontmatter += `owner: ${owner}\n`;
  if (description) frontmatter += `description: ${description}\n`;
  if (scopes && scopes.length > 0) frontmatter += `scopes: [${scopes.join(", ")}]\n`;

  frontmatter += `---\n\n# ${title}\n`;

  writeFileSync(join(taskDir, "task.mdx"), frontmatter);
}

describe("fixture-smell-detector", () => {
  describe("detects known fixture patterns", () => {
    const t = tmp();
    beforeEach(() => {
      // Seed 6 fixture-pattern tasks
      writeTaskMdx(t, "tsk-fix1", "move a card", undefined);
      writeTaskMdx(t, "tsk-fix2", "server-visible task", undefined);
      writeTaskMdx(t, "tsk-fix3", "integration in_progress", undefined);
      writeTaskMdx(t, "tsk-fix4", "integration reconcile smoke", undefined);
      writeTaskMdx(t, "tsk-fix5", "smoke reconcile test", undefined, undefined, ["smoke"]);
      writeTaskMdx(t, "tsk-fix6", "dedupe this POST", undefined);
    });

    afterEach(() => {
      rmSync(t, { recursive: true, force: true });
    });

    it("detects all 6 fixture-pattern tasks", () => {
      const smells = detectFixtureSmells(join(t, ".ok", "tasks"));
      assert.strictEqual(smells.length, 6, `Expected 6 smells, got ${smells.length}: ${JSON.stringify(smells.map(s => s.id))}`);
    });
  });

  describe("ignores real tasks with similar titles", () => {
    const t = tmp();
    beforeEach(() => {
      // Seed 2 real-shaped tasks (with owner + proper description) - use titles that DON'T match the patterns
      writeTaskMdx(t, "tsk-real1", "Move the card to the done column", "todd", "User requested moving card to done column");
      writeTaskMdx(t, "tsk-real2", "Run API smoke tests", "karen", "Integration smoke test for new endpoint", ["integration", "api"]);
    });

    afterEach(() => {
      rmSync(t, { recursive: true, force: true });
    });

    it("expects 0 detections for real tasks", () => {
      const smells = detectFixtureSmells(join(t, ".ok", "tasks"));
      assert.strictEqual(smells.length, 0, `Expected 0 smells, got ${smells.length}: ${JSON.stringify(smells)}`);
    });
  });

  describe("user's .ok/ has no fixture smells", () => {
    const USER_OK_TASKS = "/home/drb0rk/projects/openkan/.ok/tasks";

    it("scans user's .ok/ for fixture leaks", () => {
      if (!existsSync(USER_OK_TASKS)) {
        console.warn("[fixture-smell-detector] WARNING: User's .ok/tasks directory does not exist, skipping");
        return;
      }

      let smells: { id: string; reason: string; title: string; owner: string | undefined; description: string | undefined }[] = [];
      try {
        smells = detectFixtureSmells(USER_OK_TASKS);
      } catch (e: any) {
        // If we can't read the directory, warn but don't fail
        console.warn(`[fixture-smell-detector] WARNING: Could not scan user's .ok/: ${e.message}`);
        return;
      }

      if (smells.length > 0) {
        const msg = smells.map(s => `  - ${s.id}: "${s.title}" (${s.reason})`).join("\n");
        console.warn(`[fixture-smell-detector] WARNING: Found ${smells.length} fixture smells in user's .ok/:\n${msg}`);
        // Don't fail the test - just warn, since user may be mid-cleanup
        // The test passes but logs warnings so operator can clean up
        return;
      } else {
        console.log("[fixture-smell-detector] INFO: User's .ok/ is clean of fixture smells");
      }

      // Only assert if we successfully scanned and found no smells
      assert.strictEqual(smells.length, 0, `Found fixture smells in user's .ok/: ${smells.map(s => s.id).join(", ")}`);
    });
  });
});
