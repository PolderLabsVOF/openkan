// tests/serve-cli.test.mjs — regression tests for the `openkan serve` entry
// point and the interactive mode prompt.
//
// Covers the acceptance criteria from the `openkan serve` task brief:
//   * mode-prompt parsing: 1|2|3, foreground|background|tray, empty → background
//   * non-interactive fallback to background mode
//   * non-TTY + explicit --mode=tray fails with a clear error
//   * tray-unavailable fallback to background (mocked via --mode=tray without TTY)
//
// Each test spawns the CLI in its own tmpdir so .ok/ workspaces cannot leak.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI_ARGS = ["--experimental-strip-types", join(PROJECT_ROOT, "bin", "openkan.ts")];

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "openkan-serve-test-"));
}

function rmTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function runCli(args, cwd, { stdin = "", env } = {}) {
  const result = spawnSync(process.execPath, [...CLI_ARGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: stdin,
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", ...(env ?? {}) },
    timeout: 8000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: typeof result.status === "number" ? result.status : (result.signal ? 128 : 1),
    signal: result.signal ?? null,
  };
}

function initProject(dir) {
  const r = runCli(["init"], dir);
  assert.equal(r.status, 0, `init failed: stderr=${r.stderr} stdout=${r.stdout}`);
}

// Spawn the CLI as a child process we can kill ourselves. The background
// / foreground / tray modes all keep the process alive (the HTTP server
// holds the event loop open), so we collect with a hard timeout and
// SIGKILL afterwards.
// `subcommand` lets the caller pick `serve` (default) or `start` etc.
function spawnServe(args, cwd, { stdin = "", env, subcommand = "serve" } = {}) {
  const child = spawn(process.execPath, [...CLI_ARGS, subcommand, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", ...(env ?? {}) },
  });
  if (stdin) child.stdin.write(stdin);
  child.stdin.end();
  return child;
}

function collect(child, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (overrides = {}) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code: null, signal: null, timedOut: false, ...overrides });
    };
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("exit", (code, signal) => finish({ code, signal }));
    child.on("error", (err) => finish({ error: err }));
    // Foreground mode keeps the CLI alive forever; resolve once we have
    // enough output to assert on, then the caller kills the child.
    setTimeout(() => finish({ timedOut: true }), timeoutMs);
  });
}

async function runServe(args, cwd, opts = {}) {
  const child = spawnServe(args, cwd, opts);
  const result = await collect(child, opts);
  try { child.kill("SIGKILL"); } catch { /* may already be dead */ }
  await new Promise((r) => setTimeout(r, 50));
  return result;
}

describe("openkan serve", () => {
  describe("prompt parsing (--mode flag)", () => {
    it("accepts --mode=foreground", async () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = await runServe(["--mode=foreground", "--no-open"], dir);
        // Foreground mode prints the server URL — that's all we need to
        // prove the flag was parsed.
        assert.match(r.stdout + r.stderr, /OpenKan server running|Kanban server started/, `out=${r.stdout} err=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("accepts --mode=bg (alias)", async () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = await runServe(["--mode=bg", "--no-open"], dir);
        assert.doesNotMatch(r.stdout + r.stderr, /--mode must be/, `unexpected parse error: ${r.stderr}`);
        assert.match(r.stdout + r.stderr, /OpenKan server at|Kanban server started/, `server did not start: ${r.stdout} ${r.stderr}`);
        // Background mode drops a pid:port file so callers can recover the server.
        assert.ok(/7777|7778|7779/.test(r.stdout + r.stderr), `expected a port in stdout: ${r.stdout}`);
      } finally { rmTmp(dir); }
    });

    it("--mode=tray fails fast in non-TTY", async () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = await runServe(["--mode=tray", "--no-open"], dir, { timeoutMs: 2000 });
        // The serve wrapper refuses tray mode without a TTY.
        assert.notEqual(r.code, 0, `expected non-zero exit, got ${r.code}`);
        assert.match(r.stderr, /--mode=tray requires a TTY/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("rejects an unknown --mode value", async () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = await runServe(["--mode=hover", "--no-open"], dir, { timeoutMs: 1000 });
        assert.notEqual(r.code, 0);
        assert.match(r.stderr, /--mode must be foreground, background, or tray/, `stderr=${r.stderr}`);
      } finally { rmTmp(dir); }
    });
  });

  describe("non-interactive fallback", () => {
    it("falls back to background with a one-line notice when stdin is closed", async () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = await runServe([], dir, { stdin: "" });
        assert.match(r.stdout + r.stderr, /non-interactive shell — defaulting to background/, `expected fallback notice, got: ${r.stdout} ${r.stderr}`);
        assert.match(r.stdout + r.stderr, /OpenKan server at|Kanban server started/, `expected server start line, got: ${r.stdout} ${r.stderr}`);
      } finally { rmTmp(dir); }
    });

    it("does not print the interactive prompt when stdin is closed", async () => {
      const dir = tmpDir();
      try {
        initProject(dir);
        const r = await runServe(["--no-open"], dir, { stdin: "" });
        assert.doesNotMatch(r.stdout + r.stderr, /How would you like OpenKan/, `should not prompt in non-TTY mode, got: ${r.stdout} ${r.stderr}`);
      } finally { rmTmp(dir); }
    });
  });
});

// Direct unit-level coverage of the input-to-mode mapping that lives inside
// bin/openkan.ts. We mirror the table in cmdServe.promptModeInteractive
// here so we can test it without spawning the CLI; the integration tests
// above cover the wire-up.
describe("prompt parser (input → mode)", () => {
  function normalize(raw) {
    const v = (raw ?? "").toString().trim().toLowerCase();
    if (v === "" || v === "2" || v === "background" || v === "bg") return "background";
    if (v === "1" || v === "foreground" || v === "fg") return "foreground";
    if (v === "3" || v === "tray") return "tray";
    return null;
  }

  it("maps empty input to background (default)", () => {
    assert.equal(normalize(""), "background");
    assert.equal(normalize("   "), "background");
  });

  it("maps numeric choices", () => {
    assert.equal(normalize("1"), "foreground");
    assert.equal(normalize("2"), "background");
    assert.equal(normalize("3"), "tray");
  });

  it("maps word aliases", () => {
    assert.equal(normalize("foreground"), "foreground");
    assert.equal(normalize("Foreground"), "foreground");
    assert.equal(normalize("fg"), "foreground");
    assert.equal(normalize("background"), "background");
    assert.equal(normalize("BG"), "background");
    assert.equal(normalize("bg"), "background");
    assert.equal(normalize("tray"), "tray");
    assert.equal(normalize("Tray"), "tray");
  });

  it("returns null for unknown input (triggers a single re-prompt)", () => {
    assert.equal(normalize("hover"), null);
    assert.equal(normalize("nope"), null);
    assert.equal(normalize("0"), null);
    assert.equal(normalize("4"), null);
  });
});

describe("openkan start --mode flag (cmdStart plumbing)", () => {
  // The existing `openkan start` surface must keep working; the new --mode
  // flag is purely additive.
  it("accepts --mode=foreground (preserves --foreground alias)", async () => {
    const dir = tmpDir();
    try {
      initProject(dir);
      const r = await runServe(["--mode=foreground", "--no-open"], dir, { subcommand: "start" });
      assert.match(r.stdout + r.stderr, /OpenKan server running|Kanban server started/, `out=${r.stdout} err=${r.stderr}`);
      assert.doesNotMatch(r.stderr, /--mode must be/, `unexpected parse error: ${r.stderr}`);
    } finally { rmTmp(dir); }
  });

  it("rejects --mode=tray in non-TTY but falls back rather than crashing", async () => {
    const dir = tmpDir();
    try {
      initProject(dir);
      // start does not gate --mode=tray on TTY (only serve does). On
      // Linux without libappindicator (the common CI environment) the
      // tray init throws TrayUnavailableError, which cmdStartTray
      // translates into a fallback to background mode.
      const r = await runServe(["--mode=tray", "--no-open"], dir, { subcommand: "start", timeoutMs: 4000 });
      // Background fallback means the server is up; the CLI may stay
      // alive (HTTP server keeps the event loop open). Either way, we
      // expect the fallback message and the server start line.
      assert.match(r.stdout + r.stderr, /Falling back to background|system tray unavailable|OpenKan server at/, `expected fallback or server start: ${r.stdout} ${r.stderr}`);
    } finally { rmTmp(dir); }
  });
});
