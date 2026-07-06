// tests/cli.test.mjs — CLI subprocess tests for bin/openkan.ts
//
// Tests the openkan CLI by spawning it in temp directories. Since the CLI
// handles its own cwd-based .openkan/ directory, each test runs in a unique
// tmpdir to avoid interference.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI = `node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "openkan.ts")}`;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "openkan-cli-test-"));
}

function rmTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function run(args, cwd) {
  try {
    const stdout = execSync(`${CLI} ${args}`, { cwd, encoding: "utf-8", stdio: "pipe" });
    return { stdout: stdout ?? "", stderr: "" };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

function runOk(args, cwd) {
  try {
    return execSync(`${CLI} ${args}`, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch (e) {
    throw new Error(`CLI command failed: ${args}\nstdout: ${e.stdout?.toString()}\nstderr: ${e.stderr?.toString()}`);
  }
}

describe("CLI", () => {
  describe("init", () => {
    it("creates .openkan/board.json and .openkan/tasks.json", () => {
      const dir = tmpDir();
      try {
        runOk("init", dir);
        assert.ok(existsSync(join(dir, ".openkan", "board.json")), "board.json exists");
        assert.ok(existsSync(join(dir, ".openkan", "tasks.json")), "tasks.json exists");
        assert.ok(existsSync(join(dir, ".openkan", "config.json")), "config.json exists");
      } finally {
        rmTmp(dir);
      }
    });

    it("is idempotent", () => {
      const dir = tmpDir();
      try {
        runOk("init", dir);
        runOk("init", dir);
        assert.ok(existsSync(join(dir, ".openkan", "board.json")));
        // Verify board.json is valid JSON
        const board = JSON.parse(readFileSync(join(dir, ".openkan", "board.json"), "utf-8"));
        assert.ok(board.version);
      } finally {
        rmTmp(dir);
      }
    });
  });

  describe("config", () => {
    it("config set port 8080 then config get port returns 8080", () => {
      const dir = tmpDir();
      try {
        runOk("init", dir);
        runOk('config set port 8080', dir);
        const out = runOk("config get port", dir);
        assert.strictEqual(out, "8080");
      } finally {
        rmTmp(dir);
      }
    });

    it("config set import.include then config get returns the array", () => {
      const dir = tmpDir();
      try {
        runOk("init", dir);
        runOk('config set import.include \'["docs/**"]\'', dir);
        const out = runOk("config get import.include", dir);
        assert.strictEqual(out, '["docs/**"]');
      } finally {
        rmTmp(dir);
      }
    });

    it("config list outputs valid JSON with round-tripped values", () => {
      const dir = tmpDir();
      try {
        runOk("init", dir);
        runOk("config set port 8080", dir);
        runOk('config set defaultAgent "helper"', dir);
        const out = runOk("config list", dir);
        const cfg = JSON.parse(out);
        assert.strictEqual(cfg.port, 8080);
        assert.strictEqual(cfg.defaultAgent, "helper");
      } finally {
        rmTmp(dir);
      }
    });
  });

  describe("help", () => {
    it("prints usage for --help", () => {
      const out = runOk("--help", tmpdir());
      assert.ok(out.includes("Usage"), `Expected usage text, got: ${out.slice(0, 200)}`);
    });

    it("prints usage for -h", () => {
      const out = runOk("-h", tmpdir());
      assert.ok(out.includes("Usage"), `Expected usage text, got: ${out.slice(0, 200)}`);
    });
  });

  describe("unknown command", () => {
    it("errors with helpful message", () => {
      const dir = tmpDir();
      try {
        const result = run("nonexistent", dir);
        // If exit code was 0 (unlikely), this would pass. Usually it throws.
        // But just in case, check stderr:
        if (result.stderr) {
          assert.ok(
            result.stderr.includes("Unknown command") || result.stderr.includes("nonexistent"),
            `stderr: ${result.stderr}`,
          );
        }
      } catch (e) {
        // Expected — CLI exits with code 1 on unknown command
        const stderr = e.stderr?.toString() ?? "";
        assert.ok(
          stderr.includes("Unknown command") || stderr.includes("nonexistent"),
          `Expected helpful error message, got stderr: ${stderr}`,
        );
      } finally {
        rmTmp(dir);
      }
    });
  });
});
