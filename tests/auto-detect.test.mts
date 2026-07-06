// tests/auto-detect.test.mts — unit tests for auto-detect project scanning

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanForGitRepos, autoDetectProjects } from "../kanban/projects.ts";

describe("auto-detect projects", () => {
  // Temp directory for test repos
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `openkan-auto-detect-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("scanForGitRepos finds a git repo under a standard suffix", async () => {
    // Create a fake git repo at tmp/projects/my-fake-repo
    const repoDir = join(tmp, "projects", "my-fake-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const results = await scanForGitRepos({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });

    // Should find the repo (cwdRepo may also be present)
    assert.ok(results.some(r => r === repoDir), `Expected to find ${repoDir} in ${results}`);
  });

  it("scanForGitRepos does not find non-git directories", async () => {
    // Create a regular directory without .git at tmp/projects/not-a-repo
    const regularDir = join(tmp, "projects", "not-a-repo");
    mkdirSync(regularDir, { recursive: true });

    const results = await scanForGitRepos({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });

    assert.ok(!results.some(r => r === regularDir), "Non-repo should not be found");
  });

  it("scanForGitRepos respects maxResults", async () => {
    // Create multiple fake repos under tmp/projects/
    for (let i = 0; i < 5; i++) {
      const repoDir = join(tmp, "projects", `repo-${i}`);
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(join(repoDir, ".git"), { recursive: true });
    }

    const results = await scanForGitRepos({ homes: [tmp], suffixes: ["projects"], maxResults: 2 });
    assert.ok(results.length <= 2, `Expected at most 2 results, got ${results.length}`);
  });

  it("scanForGitRepos skips hidden directories by default", async () => {
    // Create a hidden repo at tmp/projects/.hidden-repo
    const hiddenRepo = join(tmp, "projects", ".hidden-repo");
    mkdirSync(hiddenRepo, { recursive: true });
    mkdirSync(join(hiddenRepo, ".git"), { recursive: true });

    const results = await scanForGitRepos({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });

    assert.ok(!results.some(r => r === hiddenRepo), "Hidden repo should be skipped");
  });

  it("autoDetectProjects registers discovered repos in registry", async () => {
    // Create a fake git repo at tmp/projects/discoverable-repo
    const repoDir = join(tmp, "projects", "discoverable-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const result = await autoDetectProjects({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });

    assert.ok(result.discovered.some(p => p.root === repoDir), `Expected to discover ${repoDir}`);
    // The discovered entry should have required fields
    const entry = result.discovered.find(p => p.root === repoDir)!;
    assert.strictEqual(entry.name, "discoverable-repo");
    assert.strictEqual(entry.active, false); // Never made active by auto-detect
    assert.ok(entry.id.length > 0);
    assert.ok(entry.addedAt.length > 0);
  });

  it("autoDetectProjects marks already-known repos as alreadyKnown", async () => {
    // Create a fake git repo at tmp/projects/already-known-repo
    const repoDir = join(tmp, "projects", "already-known-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    // First call — discovers it
    const first = await autoDetectProjects({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });
    assert.ok(first.discovered.some(p => p.root === repoDir), "Should discover on first call");

    // Second call — should be alreadyKnown
    const second = await autoDetectProjects({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });
    assert.ok(second.alreadyKnown.includes(repoDir), "Should be marked as alreadyKnown on second call");
    assert.ok(!second.discovered.some(p => p.root === repoDir),
      "Should not re-discover on second call");
  });

  it("autoDetectProjects does not make any project active", async () => {
    const repoDir = join(tmp, "projects", "no-active-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const result = await autoDetectProjects({ homes: [tmp], suffixes: ["projects"], maxResults: 50 });

    // No discovered project should be active
    for (const p of result.discovered) {
      assert.strictEqual(p.active, false, "auto-detected projects should not be made active");
    }
  });
});
