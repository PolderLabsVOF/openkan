// tests/projects-xdg.test.mts — XDG_CONFIG_HOME tests.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// Import the functions we need to test
import { setRegistryPathForTesting, addProject, listProjects, registryPath, cleanupRegistry } from "../kanban/projects.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ok-xdg-"));
}

function rmTmp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test("XDG_CONFIG_HOME is honored in registry path", () => {
  const testDir = tmpDir();
  const xdgDir = join(testDir, "xdg-config");
  const openkanDir = join(xdgDir, "openkan");
  
  try {
    // Set XDG_CONFIG_HOME
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
    
    // Clear any test override
    setRegistryPathForTesting(null);
    
    // The registry path should be under XDG_CONFIG_HOME
    const path = registryPath();
    assert.ok(path.startsWith(xdgDir), `Registry should be under XDG_CONFIG_HOME, got: ${path}`);
    
    // Add a project - should go to XDG location
    const projectRoot = join(testDir, "my-project");
    mkdirSync(projectRoot);
    addProject({ name: "My Project", root: projectRoot });
    
    // Verify the registry was created in the XDG location
    const regPath = registryPath();
    assert.ok(existsSync(regPath), `Registry should exist at ${regPath}`);
    
    // Verify we can list the project
    const projects = listProjects();
    assert.equal(projects.length, 1, "Should have 1 project");
    assert.equal(projects[0].name, "My Project", "Project name should match");
    
    // Restore original XDG_CONFIG_HOME
    if (originalXdg) {
      process.env.XDG_CONFIG_HOME = originalXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    
  } finally {
    setRegistryPathForTesting(null);
    rmTmp(testDir);
  }
});

test("testing registry path overrides XDG_CONFIG_HOME", () => {
  const testDir = tmpDir();
  const xdgDir = join(testDir, "xdg-config");
  const testRegistryPath = join(testDir, "test-registry.json");
  
  try {
    // Set XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = xdgDir;
    
    // Override with test path
    setRegistryPathForTesting(testRegistryPath);
    
    // The registry path should be the test override
    const path = registryPath();
    assert.equal(path, testRegistryPath, "Test registry path should override XDG_CONFIG_HOME");
    
    // Add a project - should go to test location
    const projectRoot = join(testDir, "my-project");
    mkdirSync(projectRoot);
    addProject({ name: "Test Project", root: projectRoot });
    
    // Verify the registry was created in the test location
    assert.ok(existsSync(testRegistryPath), `Registry should exist at test path`);
    
    // Verify we can list the project
    const projects = listProjects();
    assert.equal(projects.length, 1, "Should have 1 project");
    
  } finally {
    setRegistryPathForTesting(null);
    rmTmp(testDir);
  }
});
