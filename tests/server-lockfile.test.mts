// tests/server-lockfile.test.mts — lockfile and pidfile behavior tests.

//
// Tests the atomic pid-based lock mechanism, --force takeover, stale pidfile
// reclamation, foreign process rejection, and background-mode pidfile format.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const CLI_ARGS = ["--experimental-strip-types", join(PROJECT_ROOT, "bin", "ok.ts")];

const detachedPids = new Set<number>();
let currentChild: ChildProcess | null = null;

function cleanupHandler(signal: string): void {
  for (const pid of detachedPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  detachedPids.clear();
  if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
    try { currentChild.kill("SIGKILL"); } catch { /* already gone */ }
  }
  if (signal === "SIGINT" || signal === "SIGTERM") {
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  }
}

process.on("SIGINT", cleanupHandler);
process.on("SIGTERM", cleanupHandler);

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ok-lockfile-"));
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
  assert.equal(r.status, 0, `init failed: stderr=${r.stderr} stdout=${r.stdout}`);
}

function spawnCli(args: string[], cwd: string, env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [...CLI_ARGS, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", XDG_CONFIG_HOME: cwd, ...env },
  });
}

// Spawn a CLI and capture stdout/stderr/exit as a single promise so the test
// can assert against the failure message before the stdio streams close.
// Returns once the child exits (or the timeout elapses).
interface SpawnResult { code: number | null; stdout: string; stderr: string; }
function spawnCliCapture(args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(process.execPath, [...CLI_ARGS, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", XDG_CONFIG_HOME: cwd, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ code: child.exitCode, stdout, stderr });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readPidFile(projectRoot: string): { pid: number; port: number; parentPid: number | null } | null {
  const pidFile = join(projectRoot, ".ok", "server.pid");
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const pid = parseInt(parts[0], 10);
  const port = parseInt(parts[1], 10);
  const parentPid = parts.length >= 3 && parts[2] ? parseInt(parts[2], 10) : null;
  if (Number.isFinite(pid) && Number.isFinite(port)) {
    return { pid, port, parentPid };
  }
  return null;
}

test("second ok serve fails fast when server is already running", async (t) => {
  const projectRoot = tmpDir();
  let pid: number | null = null;
  const port = 43000 + Math.floor(Math.random() * 1000);

  t.after(() => {
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      waitForExit(pid!, 3000);
    }
    rmTmp(projectRoot);
  });

  initProject(projectRoot);

  // Start first server
  const child1 = spawnCli(["serve", "--mode=background", "--no-open", `--port=${port}`], projectRoot);
  const serverUp = await waitForHttp(port, 8000);
  assert.equal(serverUp, true, "first server should start");

  pid = (() => {
    const pf = readPidFile(projectRoot);
    return pf?.pid ?? null;
  })();
  if (pid) detachedPids.add(pid);

  // Try to start second server without --force - should fail fast.
  // Use spawnCliCapture so we get the full stderr buffer before the parent
  // process exits (its stdio pipes close too quickly to attach a listener
  // after spawn).
  const second = await spawnCliCapture(
    ["serve", "--mode=background", "--no-open", `--port=${port}`],
    projectRoot,
    8000,
  );

  assert.notEqual(second.code, 0, `second ok serve should exit non-zero; got code=${second.code} stdout=${second.stdout} stderr=${second.stderr}`);
  assert.match(
    second.stderr + second.stdout,
    /already running|port.*in use/i,
    `Expected error about already running, got: stderr=${second.stderr} stdout=${second.stdout}`,
  );
});

test("--force takes over from existing server", async (t) => {
  const projectRoot = tmpDir();
  let pid1: number | null = null;
  let pid2: number | null = null;
  const port = 44000 + Math.floor(Math.random() * 1000);

  t.after(() => {
    if (pid1 && isPidAlive(pid1)) {
      try { process.kill(pid1, "SIGTERM"); } catch { /* already gone */ }
      waitForExit(pid1!, 3000);
    }
    if (pid2 && isPidAlive(pid2)) {
      try { process.kill(pid2, "SIGTERM"); } catch { /* already gone */ }
      waitForExit(pid2!, 3000);
    }
    rmTmp(projectRoot);
  });

  initProject(projectRoot);

  // Start first server
  const child1 = spawnCli(["serve", "--mode=background", "--no-open", `--port=${port}`], projectRoot);
  const serverUp1 = await waitForHttp(port, 8000);
  assert.equal(serverUp1, true, "first server should start");

  pid1 = (() => {
    const pf = readPidFile(projectRoot);
    return pf?.pid ?? null;
  })();
  if (pid1) detachedPids.add(pid1);

  // Wait for first server to be fully up
  await new Promise((r) => setTimeout(r, 500));

  // Start second server with --force
  const child2 = spawnCliCapture(["serve", "--mode=background", "--no-open", `--port=${port}`, "--force"], projectRoot, 10000);
  const serverUp2 = await waitForHttp(port, 8000);
  await child2;
  assert.equal(serverUp2, true, "second server with --force should start");

  pid2 = (() => {
    const pf = readPidFile(projectRoot);
    return pf?.pid ?? null;
  })();
  if (pid2) detachedPids.add(pid2);

  // pid1 should be dead now
  if (pid1) {
    const p1Alive = isPidAlive(pid1);
    assert.equal(p1Alive, false, "old PID should be dead after --force takeover");
  }
});

test("stale pidfile is reclaimed without --force", async (t) => {
  const projectRoot = tmpDir();
  const port = 45000 + Math.floor(Math.random() * 1000);

  t.after(() => {
    rmTmp(projectRoot);
  });

  initProject(projectRoot);

  // Write a stale pidfile with a dead PID (use PID 1 which definitely exists but is not our server)
  const pidFile = join(projectRoot, ".ok", "server.pid");
  writeFileSync(pidFile, `1:${port}:`, "utf-8");  // PID 1 is init, not our server

  // Start server - should reclaim the stale pidfile
  const child = spawnCli(["serve", "--mode=background", "--no-open", `--port=${port}`], projectRoot);
  const serverUp = await waitForHttp(port, 8000);
  assert.equal(serverUp, true, "server should start and reclaim stale pidfile");

  const pf = readPidFile(projectRoot);
  assert.ok(pf !== null, "pidfile should exist");
  assert.ok(pf!.pid !== 1, "pidfile should have new PID, not stale PID 1");

  const pid = pf?.pid;
  if (pid) {
    detachedPids.add(pid);
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    waitForExit(pid, 3000);
  }
  child.kill("SIGKILL");
});

test("pidfile contains pid:port:parent format in background mode", async (t) => {
  const projectRoot = tmpDir();
  let pid: number | null = null;
  const port = 46000 + Math.floor(Math.random() * 1000);

  t.after(() => {
    if (pid && isPidAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      waitForExit(pid!, 3000);
    }
    rmTmp(projectRoot);
  });

  initProject(projectRoot);

  // Start in background mode
  const child = spawnCli(["serve", "--mode=background", "--no-open", `--port=${port}`], projectRoot);
  const serverUp = await waitForHttp(port, 8000);
  assert.equal(serverUp, true, "server should start");

  // Read the pidfile and verify format
  const pf = readPidFile(projectRoot);
  assert.ok(pf !== null, "pidfile should exist");
  assert.ok(Number.isFinite(pf!.pid), "pid should be a number");
  assert.ok(Number.isFinite(pf!.port), "port should be a number");
  assert.equal(pf!.port, port, "port should match");
  assert.ok(pf!.parentPid !== null, "parentPid should be set in background mode");

  pid = pf?.pid ?? null;
  if (pid) detachedPids.add(pid);
});
