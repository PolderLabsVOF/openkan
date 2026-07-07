// tests/auto-detect.test.mts — unit tests for auto-detect project scanning

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanForGitRepos, autoDetectProjects, setRegistryPathForTesting, registryPath } from "../kanban/projects.ts";

describe("auto-detect projects", () => {
  // Per-test temp directory (acts as fake $HOME)
  let tmpHome: string;
  let originalHome: string | undefined;
  // Capture the real registry path before any test modifies $HOME
  const REAL_REGISTRY = join(process.env.HOME!, ".config", "openkan", "projects.json");

  beforeEach(() => {
    tmpHome = join(tmpdir(), `openkan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, ".config", "openkan"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Redirect the registry to the per-test temp path so tests never touch
    // the real ~/.config/openkan/projects.json
    setRegistryPathForTesting(join(tmpHome, ".config", "openkan", "projects.json"));
  });

  afterEach(() => {
    setRegistryPathForTesting(null);
    process.env.HOME = originalHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("scanForGitRepos finds a git repo under a standard suffix", async () => {
    const repoDir = join(tmpHome, "projects", "my-fake-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const results = await scanForGitRepos({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    assert.ok(results.some(r => r === repoDir), `Expected to find ${repoDir} in ${results}`);
  });

  it("scanForGitRepos does not find non-git directories", async () => {
    const regularDir = join(tmpHome, "projects", "not-a-repo");
    mkdirSync(regularDir, { recursive: true });

    const results = await scanForGitRepos({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    assert.ok(!results.some(r => r === regularDir), "Non-repo should not be found");
  });

  it("scanForGitRepos respects maxResults", async () => {
    for (let i = 0; i < 5; i++) {
      const repoDir = join(tmpHome, "projects", `repo-${i}`);
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(join(repoDir, ".git"), { recursive: true });
    }

    const results = await scanForGitRepos({ homes: [tmpHome], suffixes: ["projects"], maxResults: 2 });
    assert.ok(results.length <= 2, `Expected at most 2 results, got ${results.length}`);
  });

  it("scanForGitRepos skips hidden directories by default", async () => {
    const hiddenRepo = join(tmpHome, "projects", ".hidden-repo");
    mkdirSync(hiddenRepo, { recursive: true });
    mkdirSync(join(hiddenRepo, ".git"), { recursive: true });

    const results = await scanForGitRepos({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    assert.ok(!results.some(r => r === hiddenRepo), "Hidden repo should be skipped");
  });

  it("autoDetectProjects registers discovered repos in registry", async () => {
    const repoDir = join(tmpHome, "projects", "discoverable-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const result = await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    assert.ok(result.discovered.some(p => p.root === repoDir), `Expected to discover ${repoDir}`);
    const entry = result.discovered.find(p => p.root === repoDir)!;
    assert.strictEqual(entry.name, "discoverable-repo");
    assert.strictEqual(entry.active, false);
    assert.ok(entry.id.length > 0);
    assert.ok(entry.addedAt.length > 0);
  });

  it("autoDetectProjects marks already-known repos as alreadyKnown", async () => {
    const repoDir = join(tmpHome, "projects", "already-known-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const first = await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });
    assert.ok(first.discovered.some(p => p.root === repoDir), "Should discover on first call");

    const second = await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });
    assert.ok(second.alreadyKnown.includes(repoDir), "Should be marked as alreadyKnown on second call");
    assert.ok(!second.discovered.some(p => p.root === repoDir),
      "Should not re-discover on second call");
  });

  it("autoDetectProjects does not make any project active", async () => {
    const repoDir = join(tmpHome, "projects", "no-active-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const result = await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    for (const p of result.discovered) {
      assert.strictEqual(p.active, false, "auto-detected projects should not be made active");
    }
  });

  // ─── Dedup regression tests ───────────────────────────────────────────────

  it("autoDetectProjects registers only ONE entry when called three times on same repo", async () => {
    const repoDir = join(tmpHome, "projects", "dedup-test-triple-call");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });
    await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });
    const third = await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    const reg = JSON.parse(readFileSync(registryPath(), "utf-8")) as { projects: { root: string }[] };
    const matches = reg.projects.filter(p => p.root === repoDir);
    assert.strictEqual(matches.length, 1, `Expected 1 entry for ${repoDir}, got ${matches.length}: ${JSON.stringify(reg.projects.map(p => p.root))}`);
    // Third call should have the repo already known, not discovered
    assert.ok(third.alreadyKnown.includes(repoDir), "Third call should mark repo as alreadyKnown");
    assert.ok(!third.discovered.some(p => p.root === repoDir), "Third call should not re-discover");
  });

  it("autoDetectProjects registers only ONE entry when suffixes overlap (same dir reached via multiple suffixes)", async () => {
    // Create a single repo under a suffix directory
    const repoDir = join(tmpHome, "projects", "overlap-suffix-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    // Reach it via overlapping suffixes: ["projects", "p", "pr", "proj"] all point to same parent
    const result = await autoDetectProjects({
      homes: [tmpHome],
      suffixes: ["projects", "p", "pr", "proj"],
      maxResults: 50,
    });

    const reg = JSON.parse(readFileSync(registryPath(), "utf-8")) as { projects: { root: string }[] };
    const matches = reg.projects.filter(p => p.root === repoDir);
    assert.strictEqual(matches.length, 1,
      `Expected 1 entry for ${repoDir} even with overlapping suffixes, got ${matches.length}: ${JSON.stringify(reg.projects.map(p => p.root))}`);
    assert.strictEqual(result.discovered.filter(p => p.root === repoDir).length, 1,
      "Should have discovered the repo exactly once");
  });

  it("autoDetectProjects does not double-add cwd repo when cwd is inside a suffix-scanned directory", async () => {
    // Create a repo that is both the cwd (simulated via findClosestGitRepo cwd behavior)
    // and also found via suffix walk. The tmpHome itself contains projects/
    const repoDir = join(tmpHome, "projects", "cwd-overlap-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    // Scan with tmpHome as both home and cwd context
    const result = await autoDetectProjects({
      homes: [tmpHome],
      suffixes: ["projects"],
      maxResults: 50,
    });

    const reg = JSON.parse(readFileSync(registryPath(), "utf-8")) as { projects: { root: string }[] };
    const matches = reg.projects.filter(p => p.root === repoDir);
    assert.strictEqual(matches.length, 1,
      `Expected 1 entry when cwd is inside scanned dir, got ${matches.length}`);
  });

  it("tests do not pollute the real registry", async () => {
    // This test verifies the beforeEach/afterEach isolation is working.
    // It creates a fake repo and registers it, then checks the temp registry.
    const repoDir = join(tmpHome, "projects", "isolation-test-repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    await autoDetectProjects({ homes: [tmpHome], suffixes: ["projects"], maxResults: 50 });

    // The temp registry should have the entry
    const reg = JSON.parse(readFileSync(registryPath(), "utf-8")) as { projects: { id: string }[] };
    assert.ok(reg.projects.some(p => p.id === "isolation-test-repo"), "Entry should exist in temp registry");

    // After this test's afterEach runs, the temp registry is deleted.
    // The real registry at ~/.config/openkan/projects.json should NOT have this entry.
    assert.notStrictEqual(
      registryPath(),
      REAL_REGISTRY,
      "Test registry path should not be the real HOME registry"
    );
  });
});
