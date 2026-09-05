// tests/cli-qa-fixes.test.mjs — regression tests for the six CLI QA findings
// fixed in bin/openkan.ts. Each test corresponds to one task:
//   tsk-Ymfa3vwx — `openkan open` errors when no server is running
//   tsk-pcHKgkao — `openkan reset` refuses to hang in non-TTY mode
//   tsk-GlARiXAI — `openkan goal` prints help on bare invocation
//   tsk-2LXl-ukB — `openkan skill install --target` validates the target
//   tsk-EuhITlx9 — `openkan import` warns on unknown flags
//   tsk-6O5ZUHdq — `openkan agent install` validates positional provider
//
// Each test runs in its own tmpdir so the .ok/ workspace cannot leak
// between cases.

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI = ["node", "--experimental-strip-types", join(PROJECT_ROOT, "bin", "openkan.ts")];

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "openkan-cli-qa-"));
}

function rmTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Run the CLI in `cwd`. Never throws on non-zero exit — the caller inspects
// { stdout, stderr, status } so failure cases are testable. Uses spawnSync
// so both streams are captured even when the process exits 0.
function runCli(args, cwd, { stdin } = {}) {
  const result = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    input: stdin,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: typeof result.status === "number" ? result.status : 1,
  };
}

function initProject(dir) {
  const r = runCli(["init"], dir);
  assert.equal(r.status, 0, `init failed: stderr=${r.stderr} stdout=${r.stdout}`);
}

describe("CLI QA fixes", () => {
  describe("tsk-Ymfa3vwx — `openkan open` errors when no server is running", () => {
    it("exits non-zero with a clear error when server.pid is missing", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["open"], dir);
        assert.notEqual(r.status, 0, "expected non-zero exit");
        assert.match(r.stderr + r.stdout, /no server\.pid|not running/i, `expected server-not-running error, got status=${r.status} out=${r.stdout} err=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("exits non-zero when server.pid points at a dead PID", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        writeFileSync(join(dir, ".ok", "server.pid"), "99999:7777\n");
        const r = runCli(["open"], dir);
        assert.notEqual(r.status, 0, "expected non-zero exit");
        assert.match(r.stderr + r.stdout, /stale|not running/i);
      } finally { rmTmp(dir); }
    });
  });

  describe("tsk-pcHKgkao — `openkan reset` skips prompt in non-TTY mode", () => {
    it("exits non-zero with a clear error when stdin is closed and no flag is provided", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["reset"], dir, { stdin: "" });
        assert.notEqual(r.status, 0, "expected non-zero exit instead of silent hang");
        assert.match(r.stderr, /non-interactive|--yes|--hard/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("proceeds past the prompt when --yes is given in non-TTY mode", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["reset", "--yes"], dir, { stdin: "" });
        // No server.pid means cmdStop prints an error and exits 1; the
        // important thing is that we did NOT print the non-interactive
        // refusal and we did NOT hang waiting on stdin.
        assert.doesNotMatch(r.stderr, /non-interactive/, `unexpected prompt refusal: ${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("proceeds past the prompt when --hard is given in non-TTY mode", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["reset", "--hard"], dir, { stdin: "" });
        assert.doesNotMatch(r.stderr, /non-interactive/, `unexpected prompt refusal: ${r.stderr}`);
      } finally { rmTmp(dir); }
    });
  });

  describe("tsk-GlARiXAI — `openkan goal` prints help on bare invocation", () => {
    it("prints help instead of 'Usage: openkan goal list …' when no subcommand is given", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["goal"], dir);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
        assert.match(r.stdout, /openkan goal/, `expected help line, got ${r.stdout}`);
        assert.doesNotMatch(r.stderr, /Usage: openkan goal/, `should not fall back to usage error, got ${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("prints the same help when --help is given", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["goal", "--help"], dir);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /openkan goal/);
      } finally { rmTmp(dir); }
    });

    it("still dispatches real subcommands (goal list)", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["goal", "list"], dir);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
        assert.match(r.stdout, /no goals/);
      } finally { rmTmp(dir); }
    });
  });

  describe("tsk-2LXl-ukB — `openkan skill install` validates --target", () => {
    it("rejects a target that does not exist", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const target = join(dir, "does-not-exist");
        const r = runCli(["skill", "install", "--target", target], dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /does not exist/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("rejects a target that is a regular file", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const target = join(dir, "a-file");
        writeFileSync(target, "");
        const r = runCli(["skill", "install", "--target", target], dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not a directory/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("rejects a target directory that is not writable", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const target = join(dir, "unwritable");
        mkdirSync(target);
        // Root can bypass chmod, so probe writeability via the test: try
        // and see if the CLI rejects. We tolerate "not writable" OR a
        // successful probe (root) — but the file-must-not-be-silent-create
        // requirement is what matters. Skip when running as root.
        if (process.getuid && process.getuid() === 0) return;
        chmodSync(target, 0o555);
        const r = runCli(["skill", "install", "--target", target], dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not writable/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("succeeds on a writable, empty directory when --force is provided", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const target = join(dir, "skill-target");
        mkdirSync(target);
        const r = runCli(["skill", "install", "--target", target, "--force"], dir);
        assert.equal(r.status, 0, `expected exit 0, got ${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
        assert.match(r.stdout, /Installed openkan skill/);
      } finally { rmTmp(dir); }
    });
  });

  describe("tsk-EuhITlx9 — `openkan import` warns on unknown flags", () => {
    it("warns about a single unknown flag", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["import", "--bogus"], dir);
        // Either stderr or stdout — console.warn writes to stderr.
        assert.match(r.stderr + r.stdout, /warning: unknown flag --bogus/);
      } finally { rmTmp(dir); }
    });

    it("warns when an unknown flag is mixed with known flags", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["import", "--include", "x", "--bogus", "--exclude", "y"], dir);
        assert.match(r.stderr + r.stdout, /warning: unknown flag --bogus/);
      } finally { rmTmp(dir); }
    });

    it("does not warn when no flags are given", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["import"], dir);
        assert.doesNotMatch(r.stderr + r.stdout, /warning: unknown flag/);
      } finally { rmTmp(dir); }
    });
  });

  describe("tsk-6O5ZUHdq — `openkan agent install` validates positional provider", () => {
    it("rejects a positional provider that is not in the allow-list", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["agent", "install", "bogus"], dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Only the Claude provider is currently supported/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("rejects an unknown --provider flag value", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["agent", "install", "--provider", "codex"], dir);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /Only the Claude provider is currently supported/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("still defaults to Claude when no provider is given", () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = runCli(["agent", "install"], dir);
        // The agent install actually mutates global config — we only care
        // that it does not reject the no-arg shape.
        assert.doesNotMatch(r.stderr, /Only the Claude provider is currently supported/);
      } finally { rmTmp(dir); }
    });
  });
});
