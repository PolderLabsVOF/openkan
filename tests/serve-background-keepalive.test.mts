// tests/serve-background-keepalive.test.mts — regression gate for the
// detach-daemon fix: when `ok serve --mode=background` (or `ok start
// --mode=tray` whose tray subsystem is unavailable) is invoked, the CLI must
// not stay attached to the controlling terminal. The previous v0.5.0 fix
// (`detachForBackground()` + `await new Promise(() => {})`) only unref'd
// stdio, which leaves the HTTP listener's event-loop handle alive and the
// process still owns stdio — the user's shell prompt never returns.
//
// The current implementation spawns a detached child process running the
// same serve code in foreground mode, then exits the parent with code 0 so
// the terminal returns. The child owns the HTTP listener; the pidfile
// points at the child PID so `ok stop` SIGTERMs the right process.
//
// Each test spawns the CLI in its own tmpdir so the real `.ok/` workspace is
// not touched.

import { test, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI_ARGS = ["--experimental-strip-types", join(PROJECT_ROOT, "bin", "ok.ts")];

// Module-scoped set to track detached child PIDs across all tests for cleanup.
// This ensures that even if npm test is interrupted (SIGTERM/SIGINT), all
// spawned children are properly cleaned up.
const detachedPids = new Set<number>();
// Track the current in-test child process handle for cleanup.
let currentChild: ChildProcess | null = null;

// Signal handlers to clean up detached children when npm test is interrupted.
// This prevents orphan processes from accumulating across test runs.
function cleanupHandler(signal: string): void {
  for (const pid of detachedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  detachedPids.clear();
  if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
    try { currentChild.kill("SIGKILL"); } catch { /* already gone */ }
  }
  // Re-raise the signal so Node's default handler runs
  if (signal === "SIGINT" || signal === "SIGTERM") {
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  }
}

process.on("SIGINT", cleanupHandler);
process.on("SIGTERM", cleanupHandler);
process.on("beforeExit", () => {
  for (const pid of detachedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  detachedPids.clear();
  if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
    try { currentChild.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ok-serve-bg-"));
}

function rmTmp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForHttp(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status < 500) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function initProject(dir: string): void {
  const r = spawnSync(process.execPath, [...CLI_ARGS, "init"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1" },
    timeout: 10_000,
  });
  assert.equal(
    r.status,
    0,
    `init failed: stderr=${r.stderr} stdout=${r.stdout}`,
  );
}

function spawnCli(args: string[], cwd: string, env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [...CLI_ARGS, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", XDG_CONFIG_HOME: cwd, ...env },
  });
}

function readPidFile(projectRoot: string): number | null {
  const pidFile = join(projectRoot, ".ok", "server.pid");
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const [pidStr] = raw.split(":");
  const pid = parseInt(pidStr, 10);
  return Number.isFinite(pid) ? pid : null;
}

test("ok serve --mode=background spawns a detached child and exits 0", async (t) => {
  const projectRoot = tmpDir();
  let child: ChildProcess | null = null;
  let pid: number | null = null;
  const port = 41000 + Math.floor(Math.random() * 1000);

  t.after(() => {
    if (currentChild === child) currentChild = null;
    if (pid) detachedPids.delete(pid);
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    rmTmp(projectRoot);
  });

  try {
    initProject(projectRoot);

    child = spawnCli(
      ["serve", "--mode=background", "--no-open", `--port=${port}`],
      projectRoot,
    );
    currentChild = child;

    // 1. Wait for the HTTP server to come up (up to 8s — the parent spawns
    //    a detached child, then polls the port until it responds).
    const serverUp = await waitForHttp(port, 8000);
    assert.equal(
      serverUp,
      true,
      `server did not respond within 8s on port ${port}`,
    );

    // 2. The key invariant: the parent CLI exits with code 0 so the user's
    //    terminal returns. The detached child now owns the HTTP listener.
    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      if (child!.exitCode !== null || child!.signalCode !== null) {
        resolve({ code: child!.exitCode, signal: child!.signalCode });
        return;
      }
      child!.on("exit", (code, signal) => resolve({ code, signal }));
      setTimeout(() => resolve({ code: child!.exitCode, signal: child!.signalCode }), 5000);
    });
    assert.equal(
      exitInfo.code,
      0,
      `parent CLI did not exit cleanly (code=${exitInfo.code} signal=${exitInfo.signal}). ` +
        `Background-mode CLI must exit 0 after spawning the detached child.`,
    );
    assert.equal(exitInfo.signal, null, `parent CLI was killed by signal=${exitInfo.signal}`);

    // 3. After parent exit: HTTP server still responding, pidfile points at
    //    the detached child PID (not the parent's PID).
    const stillUp = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status < 500).catch(() => false);
    assert.equal(
      stillUp,
      true,
      `server stopped responding after parent CLI exited (the bug we are fixing)`,
    );

    pid = readPidFile(projectRoot);
    assert.ok(pid !== null, `pidfile not written: ${join(projectRoot, ".ok", "server.pid")}`);
    // Register the detached child PID for cleanup on process signals.
    if (pid) detachedPids.add(pid);
    assert.equal(
      isPidAlive(pid!),
      true,
      `pidfile points at dead PID ${pid} — detached child died after parent exit`,
    );
    assert.notEqual(
      pid!,
      child.pid,
      `pidfile still points at the parent PID ${child.pid}; expected the detached child PID`,
    );
  } finally {
    // 4. Clean up: SIGTERM the detached child PID and wait for it to exit.
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      await waitForExit(pid!, 3000);
    }
  }
});

test("ok start --mode=tray keeps the HTTP server up (working tray or fallback)", async (t) => {
  // Two terminal branches land here depending on the host environment:
  //   a) libappindicator IS available + node-systray works → cmdStartTray
  //      succeeds and blocks on `await new Promise(() => {})`. Parent stays
  //      alive in-process.
  //   b) tray subsystem unavailable (libappindicator missing, node-systray
  //      not installed) → cmdStartTray's catch block fires the fallback
  //      warning. The fallback path still uses `detachForBackground()` +
  //      `await new Promise(...)` (out of scope for this PR — see handback).
  //
  // The invariant we verify here is the SAME in both branches: after the
  // tray-mode CLI logs its "OpenKan server at …" line, the HTTP listener
  // keeps responding AND the pidfile points at a live PID, so `ok stop`
  // can shut the server down cleanly. Parent-alive vs parent-exited depends
  // on which branch was taken, so this test does not assert that.
  const projectRoot = tmpDir();
  let child: ChildProcess | null = null;
  let pid: number | null = null;
  let stdout = "";
  let stderr = "";
  const port = 42000 + Math.floor(Math.random() * 1000);

  t.after(() => {
    if (currentChild === child) currentChild = null;
    if (pid) detachedPids.delete(pid);
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    rmTmp(projectRoot);
  });

  try {
    initProject(projectRoot);

    child = spawnCli(
      ["start", "--mode=tray", "--no-open", `--port=${port}`],
      projectRoot,
    );
    currentChild = child;
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    // 1. Wait for the server start line (always printed before tray init).
    const startDeadline = Date.now() + 5000;
    while (Date.now() < startDeadline) {
      const combined = stdout + stderr;
      if (/OpenKan server at|Kanban server started/.test(combined)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const combined = stdout + stderr;
    assert.match(
      combined,
      /OpenKan server at|Kanban server started/,
      `server did not start: stdout=${stdout} stderr=${stderr}`,
    );

    // 2. Wait for the HTTP server to come up (5s budget).
    const serverUp = await waitForHttp(port, 5000);
    assert.equal(
      serverUp,
      true,
      `server did not respond within 5s on port ${port}: stdout=${stdout} stderr=${stderr}`,
    );

    // 3. The key regression check: after a 1s wait the HTTP server STILL
    //    responds. Pre-fix, the tray-unavailable fallback returned cleanly
    //    and the in-process HTTP listener died; the fix blocks the fallback
    //    so the listener survives.
    await new Promise((r) => setTimeout(r, 1000));

    const fallbackHappened = /Falling back to background|system tray (unavailable|init failed)/.test(
      stdout + stderr,
    );
    const stillUp = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status < 500).catch(() => false);
    assert.equal(
      stillUp,
      true,
      `server died after tray mode (fallback=${fallbackHappened}) — this is exactly the bug we are fixing. ` +
        `stdout=${stdout} stderr=${stderr}`,
    );

    // 4. pidfile points at a live PID — `ok stop` will SIGTERM that PID and
    //    Node's default handler exits cleanly.
    pid = readPidFile(projectRoot);
    assert.ok(pid !== null, `pidfile not written: ${join(projectRoot, ".ok", "server.pid")}`);
    if (pid) detachedPids.add(pid);
    assert.equal(isPidAlive(pid!), true, `pidfile points at dead PID ${pid}`);
  } finally {
    if (pid) detachedPids.delete(pid);
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      await waitForExit(pid!, 3000);
    }
  }
});

// Smoke test: verify that signal handlers for cleanup are registered.
// This ensures that if npm test is interrupted, orphan processes are cleaned up.
test("signal handlers are registered for cleanup", () => {
  const handlers = process.listeners("SIGINT");
  const hasCleanupHandler = handlers.some((h) => h.name === "cleanupHandler");
  assert.equal(hasCleanupHandler, true, "SIGINT handler should be registered");
});
