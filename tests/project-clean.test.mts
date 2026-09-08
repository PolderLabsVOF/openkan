// tests/project-clean.test.mts — project clean subcommand tests.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// Import the functions we need to test
import { setRegistryPathForTesting, loadRegistry, saveRegistry, addProject, listProjects, canonicalRoot, cleanupRegistry, registryPath } from "../kanban/projects.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ok-projclean-"));
}

function rmTmp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test("dry-run shows but does not remove", () => {
  const testDir = tmpDir();
  
  try {
    // Set up test registry
    const registryFile = join(testDir, "projects.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    
    // Add one stale + one valid + one active
    const staleRoot = join(testDir, "stale-project");
    const validRoot = join(testDir, "valid-project");
    const activeRoot = join(testDir, "active-project");
    
    mkdirSync(staleRoot);
    mkdirSync(validRoot);
    mkdirSync(activeRoot);
    
    const reg = {
      projects: [
        { id: "stale", name: "Stale", root: staleRoot, addedAt: new Date().toISOString(), active: false },
        { id: "valid", name: "Valid", root: validRoot, addedAt: new Date().toISOString(), active: false },
        { id: "active", name: "Active", root: activeRoot, addedAt: new Date().toISOString(), active: true },
      ]
    };
    
    // Remove the stale root to make it truly stale
    rmSync(staleRoot, { recursive: true, force: true });
    
    writeFileSync(registryFile, JSON.stringify(reg, null, 2));
    
    // Use the test registry
    setRegistryPathForTesting(registryFile);
    
    // Run cleanup with dry-run (default)
    const result = cleanupRegistry({ pruneMissing: true, verbose: false, persist: false });
    
    // Should identify 1 stale but not remove
    assert.equal(result.pruned, 1, "Should detect 1 stale entry");
    
    // Registry should be unchanged
    const after = loadRegistry();
    assert.equal(after.projects.length, 3, "Dry-run should not modify registry");
    
  } finally {
    setRegistryPathForTesting(null);
    rmTmp(testDir);
  }
});

test("--apply removes stale", () => {
  const testDir = tmpDir();
  
  try {
    // Set up test registry
    const registryFile = join(testDir, "projects.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    
    // Add one stale + one valid + one active
    const staleRoot = join(testDir, "stale-project");
    const validRoot = join(testDir, "valid-project");
    const activeRoot = join(testDir, "active-project");
    
    mkdirSync(staleRoot);
    mkdirSync(validRoot);
    mkdirSync(activeRoot);
    
    const reg = {
      projects: [
        { id: "stale", name: "Stale", root: staleRoot, addedAt: new Date().toISOString(), active: false },
        { id: "valid", name: "Valid", root: validRoot, addedAt: new Date().toISOString(), active: false },
        { id: "active", name: "Active", root: activeRoot, addedAt: new Date().toISOString(), active: true },
      ]
    };
    
    // Remove the stale root to make it truly stale
    rmSync(staleRoot, { recursive: true, force: true });
    
    writeFileSync(registryFile, JSON.stringify(reg, null, 2));
    
    // Use the test registry
    setRegistryPathForTesting(registryFile);
    
    // Run cleanup with --apply
    const result = cleanupRegistry({ pruneMissing: true, verbose: false, persist: true });
    
    // Should remove 1 stale
    assert.equal(result.pruned, 1, "Should remove 1 stale entry");
    
    // Registry should have only valid + active
    const after = loadRegistry();
    assert.equal(after.projects.length, 2, "Should have 2 entries after pruning");
    assert.ok(after.projects.some(p => p.id === "valid"), "Valid should remain");
    assert.ok(after.projects.some(p => p.id === "active"), "Active should remain");
    assert.ok(!after.projects.some(p => p.id === "stale"), "Stale should be removed");
    
  } finally {
    setRegistryPathForTesting(null);
    rmTmp(testDir);
  }
});

test("--all removes non-active", () => {
  const testDir = tmpDir();
  
  try {
    // Set up test registry
    const registryFile = join(testDir, "projects.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    
    // Add two non-active valid + one active
    const project1Root = join(testDir, "project1");
    const project2Root = join(testDir, "project2");
    const activeRoot = join(testDir, "active-project");
    
    mkdirSync(project1Root);
    mkdirSync(project2Root);
    mkdirSync(activeRoot);
    
    const reg = {
      projects: [
        { id: "proj1", name: "Project 1", root: project1Root, addedAt: new Date().toISOString(), active: false },
        { id: "proj2", name: "Project 2", root: project2Root, addedAt: new Date().toISOString(), active: false },
        { id: "active", name: "Active", root: activeRoot, addedAt: new Date().toISOString(), active: true },
      ]
    };
    
    writeFileSync(registryFile, JSON.stringify(reg, null, 2));
    
    // Use the test registry
    setRegistryPathForTesting(registryFile);
    
    // Run cleanup with --all --apply
    const result = cleanupRegistry({ pruneMissing: true, pruneInactive: true, verbose: false, persist: true });
    
    // Should remove 2 non-active
    assert.equal(result.pruned, 2, "Should remove 2 non-active entries");
    
    // Registry should have only active
    const after = loadRegistry();
    assert.equal(after.projects.length, 1, "Should have 1 entry after --all");
    assert.ok(after.projects.some(p => p.id === "active"), "Active should remain");
    
  } finally {
    setRegistryPathForTesting(null);
    rmTmp(testDir);
  }
});
