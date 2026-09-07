// tests/serve-background-keepalive.test.mts — regression gate for the
// v0.5.0 smoke-test bug: when `ok serve` is invoked with `--mode=background`
// (or `--mode=tray` and the tray subsystem is unavailable), the CLI used to
// exit cleanly after writing the pidfile, taking the in-process HTTP listener
// down with it. The pidfile then pointed at a dead PID.
//
// The fix (`detachForBackground()` + `await new Promise(() => {})` in both
// the background branch and the tray-fallback branch of `cmdStart`) keeps
// the CLI process alive so the HTTP server stays up. `ok stop` SIGTERMs it
// and Node's default handler exits cleanly.
//
// Each test spawns the CLI in its own tmpdir so the real `.ok/` workspace is
// not touched.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI_ARGS = ["--experimental-strip-types", join(PROJECT_ROOT, "bin", "ok.ts")];

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
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", ...env },
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

test("ok serve --mode=background keeps the CLI alive after the server starts", async (t) => {
  const projectRoot = tmpDir();
  let child: ChildProcess | null = null;
  let pid: number | null = null;
  const port = 41000 + Math.floor(Math.random() * 1000);

  t.after(() => {
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
      ["serve", "--mode=background", "--no-open", `--port=${port}`, `--project=${projectRoot}`],
      projectRoot,
    );

    // 1. Wait for the HTTP server to come up (up to 5s).
    const serverUp = await waitForHttp(port, 5000);
    assert.equal(
      serverUp,
      true,
      `server did not respond within 5s on port ${port}`,
    );

    // 2. The key bug check: wait 1s, then confirm the CLI is STILL alive.
    //    Before the fix the CLI exited after startOrAttach returned, killing
    //    the in-process HTTP listener. With the fix, `await new Promise(...)`
    //    keeps the event loop open.
    await new Promise((r) => setTimeout(r, 1000));

    assert.equal(
      child.exitCode,
      null,
      `CLI exited unexpectedly (code=${child.exitCode} signal=${child.signalCode}). ` +
        `Background-mode CLI must stay alive after the server starts.`,
    );
    assert.equal(child.signalCode, null, `CLI was killed by signal=${child.signalCode}`);

    const stillUp = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status < 500).catch(() => false);
    assert.equal(
      stillUp,
      true,
      `server stopped responding after CLI returned (the bug we are fixing)`,
    );

    // 3. pidfile points at a live PID.
    pid = readPidFile(projectRoot);
    assert.ok(pid !== null, `pidfile not written: ${join(projectRoot, ".ok", "server.pid")}`);
    assert.equal(
      isPidAlive(pid!),
      true,
      `pidfile points at dead PID ${pid} — server died after start`,
    );
  } finally {
    // 4. Clean up: SIGTERM the daemon PID and wait for it to exit.
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      await waitForExit(pid!, 3000);
    }
  }
});

test("ok start --mode=tray keeps the CLI alive (fallback or working tray, both paths)", async (t) => {
  // Two terminal branches land here depending on the host environment:
  //   a) libappindicator IS available + node-systray works → cmdStartTray
  //      succeeds and blocks on `await new Promise(() => {})`.
  //   b) tray subsystem unavailable (libappindicator missing, node-systray
  //      not installed) → cmdStartTray's catch block fires the fallback
  //      warning. Pre-fix, this branch returned cleanly, killing the
  //      in-process HTTP server. The fix detaches and blocks so the
  //      server survives.
  //
  // The key invariant we want to verify is the SAME in both branches:
  // after the tray-mode CLI logs its "OpenKan server at …" line, the CLI
  // process must stay alive and the HTTP listener must keep responding.
  const projectRoot = tmpDir();
  let child: ChildProcess | null = null;
  let pid: number | null = null;
  let stdout = "";
  let stderr = "";
  const port = 42000 + Math.floor(Math.random() * 1000);

  t.after(() => {
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
      ["start", "--mode=tray", "--no-open", `--port=${port}`, `--project=${projectRoot}`],
      projectRoot,
    );
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

    // 3. The key regression check. Wait 1s, then verify both:
    //      (a) the CLI process has NOT exited, and
    //      (b) the HTTP server STILL responds.
    //    Pre-fix, the tray-unavailable fallback branch returned cleanly,
    //    main() returned, Node saw no pending handles, and the listener
    //    died. With the fix, `detachForBackground()` + `await new Promise(…)`
    //    keep the process alive.
    await new Promise((r) => setTimeout(r, 1000));

    const fallbackHappened = /Falling back to background|system tray (unavailable|init failed)/.test(
      stdout + stderr,
    );
    const cliAlive = child.exitCode === null && child.signalCode === null;
    const stillUp = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status < 500).catch(() => false);

    assert.equal(
      cliAlive,
      true,
      `CLI exited unexpectedly after tray mode (fallback=${fallbackHappened}, ` +
        `code=${child.exitCode}, signal=${child.signalCode}). ` +
        `stdout=${stdout} stderr=${stderr}`,
    );
    assert.equal(
      stillUp,
      true,
      `server died after tray mode (fallback=${fallbackHappened}) — this is exactly the bug we are fixing. ` +
        `stdout=${stdout} stderr=${stderr}`,
    );

    // 4. pidfile is still valid.
    pid = readPidFile(projectRoot);
    assert.ok(pid !== null, `pidfile not written: ${join(projectRoot, ".ok", "server.pid")}`);
    assert.equal(isPidAlive(pid!), true, `pidfile points at dead PID ${pid}`);
  } finally {
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      await waitForExit(pid!, 3000);
    }
  }
});
