// ok/commands/serve.ts — server lifecycle commands and shared CLI helpers.
//
// Houses the helpers (`parseArgs`, `loadConfig`, `saveConfig`,
// `printInstalledVersion`, `configPath`, `printHelp`, `parseMode`,
// `StartMode`, `OPENKAN_ROOT`, `OPENKAN_WEB`) that were at the top of
// the legacy `bin/openkan.ts`, plus the dispatcher cases for `start`,
// `serve`, `stop`, `status`, `open`. Every other command module imports
// these helpers through this file.

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BoardContext } from "../../kanban/board.ts";
import { startOrAttach, getServer } from "../../kanban/server.ts";
import { addProject, setActiveProject } from "../../kanban/projects.ts";
import { initBoard, setProjectRoot } from "../../kanban/board.ts";
import { ensureDir } from "../../kanban/io.ts";
import { createTray, defaultIconDir, TrayUnavailableError } from "../../bin/tray.ts";

/**
 * Background mode and the tray-unavailable fallback both run the HTTP server
 * in the CLI process itself. When the user picks background (or tray init
 * fails), the terminal returns — but the process must NOT exit, otherwise the
 * HTTP listener dies and the pidfile points at a dead PID.
 *
 * Detach from the controlling terminal so the user sees the prompt back,
 * put the process into its own process group (so a parent shell exit doesn't
 * deliver SIGHUP), and ignore SIGHUP for the same reason. SIGTERM (sent by
 * `ok stop`) and SIGINT (Ctrl+C in foreground) fall through to Node's
 * default handlers, which exit cleanly. We do NOT install a custom SIGTERM
 * handler here because `cmdStop` already has the in-process graceful-stop
 * path (getServer().stop()) when run from a separate CLI invocation, and
 * direct SIGTERM is fine for the daemon case.
 */
export function detachForBackground(): void {
  // Detach from TTY so the terminal returns to the user.
  if (process.stdin.isTTY) {
    try { process.stdin.unref(); } catch { /* best effort */ }
  }
  if (process.stdout.isTTY) {
    try { process.stdout.unref(); } catch { /* best effort */ }
  }
  if (process.stderr.isTTY) {
    try { process.stderr.unref(); } catch { /* best effort */ }
  }
  // Put the process in its own group so a parent shell exit (which sends
  // SIGHUP to the foreground process group) does not propagate to us.
  // `process.setpgid` is not in the bundled @types/node typings yet, so
  // cast through `any`; Node.js exposes it at runtime.
  try { (process as any).setpgid?.(0, 0); } catch { /* not supported on Windows */ }
  // Survive SIGHUP if it does arrive (CI without setpgid, weird shells).
  process.on("SIGHUP", () => { /* stay alive */ });
}

// Resolve the openkan repo's web/ folder so the static UI is served no matter
// where the user invokes the CLI from. `import.meta.url` → bin/ok.ts → `../web`
// is the bundled UI.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const OPENKAN_ROOT = resolve(__dirname, "..", "..");
export const OPENKAN_WEB = join(OPENKAN_ROOT, "web");
export const OPENKAN_BIN = join(OPENKAN_ROOT, "bin");

// ─── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  port: number;
  host: string;
  defaultAgent: string;
  defaultModel: string | null;
  import: { include: string[]; exclude: string[] };
  sandbox: { tsxMaxBytes: number };
}

export const DEFAULT_CONFIG: Config = {
  port: 7777,
  host: "127.0.0.1",
  defaultAgent: "",
  defaultModel: null,
  import: { include: [], exclude: [] },
  sandbox: { tsxMaxBytes: 32768 },
};

// Agent-facing REST capability map. `ok api` exposes this entire surface
// without requiring a different shell script for each dashboard feature.
export const AGENT_CAPABILITIES = Object.freeze({
  board: ["GET /api/board", "GET /api/tasks-index", "GET /api/tasks/:id", "POST /api/tasks", "PATCH /api/tasks/:id", "DELETE /api/tasks/:id", "POST /api/tasks/bulk", "POST /api/organize", "POST /api/import"],
  taskContext: ["GET|POST /api/tasks/:id/comments", "POST /api/tasks/:id/ask", "POST /api/tasks/:id/respond", "GET /api/tasks/:id/subtasks", "GET|POST /api/tasks/:id/images", "POST /api/tasks/:id/start", "POST /api/tasks/:id/abort"],
  planning: ["ok task|plan|prd|goal …", "ok progress --json", "ok doctor", "GET /api/goals", "PATCH /api/goals/:prdId/:goalId"],
  docs: ["GET /api/docs", "GET|PUT|DELETE /api/docs/:path", "POST /api/docs/render", "POST /api/docs/generate"],
  chat: ["POST /api/chat/send", "GET /api/chat/sessions", "GET /api/chat/sessions/:id", "POST /api/chat/sessions/:id/abort"],
  agents: ["GET /api/claude/snapshot", "GET /api/claude/agents|skills|commands|hooks|teams|workflows", "GET /api/claude/activity", "GET /api/claude/model-router"],
  projects: ["GET|POST /api/projects", "PATCH /api/projects/:id/active", "POST /api/projects/auto-detect", "DELETE /api/projects/:id", "ok project clean"],
  insight: ["GET /api/search", "GET /api/tags", "GET /api/changelog", "GET /api/changelog/summary", "GET /api/insights/velocity", "GET /api/contributors"],
  config: ["GET|PATCH /api/settings", "GET /api/config-sections", "PATCH /api/config-sections/:sectionId", "ok config list|get|set"],
});

export function configPath(): string {
  return join(process.cwd(), ".ok", "openkan.json");
}

// Resolve the running package's package.json so version/installed-from stays
// accurate even when bin/ok.mjs is the entrypoint and the .ts/.js lives
// one or two levels below the package root (src vs dist).
export function installedPackageJson(): { name: string; version: string } | null {
  // Walk up from this module to the filesystem root instead of probing a fixed
  // two levels: the compiled layout (dist/ok/commands) and installed layouts
  // sit deeper than the source tree, so a bounded list missed package.json and
  // `--version` printed "version unavailable".
  const candidates: string[] = [];
  for (let dir = __dirname; ; dir = dirname(dir)) {
    candidates.push(dir);
    if (dirname(dir) === dir) break;
  }
  candidates.push(OPENKAN_ROOT);
  for (const dir of candidates) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof parsed?.name === "string" && typeof parsed?.version === "string") {
          return { name: parsed.name, version: parsed.version };
        }
      } catch { /* fall through to next candidate */ }
    }
  }
  return null;
}

export function printInstalledVersion(): void {
  const pkg = installedPackageJson();
  if (!pkg) {
    console.log("ok: version unavailable (no package.json found above the entrypoint)\n");
    return;
  }
  console.log(`${pkg.name} ${pkg.version}\n`);
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export function saveConfig(cfg: Config): void {
  ensureDir(join(process.cwd(), ".ok"));
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

// ─── Arg parser ───────────────────────────────────────────────────────────────

export interface ParsedArgs {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] ?? "";
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      i++;
      continue;
    }
    // Flag: --flag or --flag=value or --flag value
    const flagMatch = arg.match(/^--([^=]+)(=(.*))?$/);
    if (!flagMatch) { i++; continue; }
    const key = flagMatch[1];
    if (flagMatch[2] !== undefined) {
      flags[key] = flagMatch[3];
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
    i++;
  }
  return { cmd, positionals, flags };
}

// ─── Help printer ─────────────────────────────────────────────────────────────

const HELP_MESSAGES: Record<string, string> = {
  init: "init                             Create .ok/ directory (idempotent)",
  start: "start [--port N] [--host H] [--no-open] [--no-auto-detect] [--foreground] [--mode foreground|background|tray] [--project /abs/path] [--force]  Start the server",
  serve: "serve [--mode foreground|background|tray] [--port N] [--host H] [--no-open] [--force] [--cleanup-orphans] [--yes]  Start the server and ask how to run it",
  import: "import [--path DIR] [--include PATTERN] [--exclude PATTERN]  Import checkboxes as tasks",
  stop: "stop                             Stop the running server",
  status: "status                          Show server status, port, pid, uptime",
  open: "open                             Open the kanban UI in browser",
  update: "update [--check] [--yes] [--version <v>]  Upgrade to the latest @polderlabs/openkan from npm",
  config: "config list|get <key>|set <key> <value>  Manage config",
  logs: "logs [--tail N] [--follow]       Print server logs",
  api: "api <path> [--method M] [--data JSON|--data-file FILE]  Call any local OpenKan REST feature",
  agent: "agent install|capabilities|context|call|start|abort  Agent-first command/control bridge",
  task: "task add|list|show|update|claim|heartbeat|complete|cancel|release  Durable offline tasks (same as ok task)",
  board: "board list|show|add|move|comment   Dashboard tasks (requires local server and matching project)",
  project: "project list|use <id>|clean      Inspect/select the dashboard project, or clean stale entries",
  plan: "plan add|list|show|update         Plans and phases (same as ok plan)",
  prd: "prd add|list|show|update           Long-horizon scope (same as ok prd)",
  goal: "goal list|add|show|update          Goals within PRDs; goal update <prd> <goal> --status met",
  progress: "progress [--prd ID] [--json]       Task, goal, plan and PRD rollups without a server",
  skill: "skill install [--agent codex|claude|all] [--target DIR] [--force]  Install command-first agent guidance",
  doctor: "doctor                            Validate the .ok/ planning store",
  index: "index                            Rebuild .ok/index.json from filesystem",
  "migrate-from-openkan": "migrate-from-openkan [--path DIR] [root] [--list]  One-shot import of legacy .openkan/ workspace",
  reset: "reset [--hard]                  Reset .ok/ (--hard also wipes tasks/sessions)",
  help: "help [command]                  Print usage; `ok help <command>` shows the per-command line",
};

export function printHelp(cmd?: string): void {
  if (cmd && HELP_MESSAGES[cmd]) {
    console.log(`ok ${HELP_MESSAGES[cmd]}\n`);
  } else {
    console.log("Usage: ok <command> [args...]\n\n");
    Object.values(HELP_MESSAGES).forEach((m) => console.log(`  ${m}\n`));
    console.log("\nFlags: --flag=value or --flag value, can appear before or after positionals.\n");
    console.log("Task subcommands:");
    console.log("  ok task add <title> [--status pending|in_progress|review|done|cancelled] [--owner X] [--priority p0|p1|p2|p3] [--plan pln-...] [--prd prd-...] [--scope a,b] [--deps t1,t2] [--description ...] [--acceptance a,b]");
    console.log("  ok task list [--status ...] [--owner X] [--plan pln-...] [--prd prd-...] [--json]");
    console.log("  ok task show <id> [--json]");
    console.log("  ok task update <id> [--status ...] [--owner ...] [--priority ...] [--evidence ...] [--acceptance a,b] [--description ...]");
    console.log("\nMigrate:");
    console.log("  ok migrate-from-openkan [--path DIR] [root] [--list]   # --path DIR is the legacy workspace root");
    console.log("\nVersion: `ok -v` or `ok --version` prints the installed package name and version.\n");
  }
}

// ─── Start modes ──────────────────────────────────────────────────────────────

// Valid server modes. `foreground` keeps the CLI process alive; `background`
// returns immediately and lets the HTTP server keep the process alive via
// its listeners; `tray` keeps the CLI alive AND surfaces a tray icon so the
// user can close the terminal without losing the server.
export type StartMode = "foreground" | "background" | "tray";

export function parseMode(raw: unknown): StartMode {
  const v = typeof raw === "string" ? raw.toLowerCase() : "";
  if (v === "" || v === "background" || v === "bg" || v === "2") return "background";
  if (v === "foreground" || v === "fg" || v === "1") return "foreground";
  if (v === "tray" || v === "3") return "tray";
  throw new Error(`ok: --mode must be foreground, background, or tray (got: ${String(raw)})`);
}

function normalizeInput(raw: string): StartMode | null {
  const v = raw.toLowerCase();
  if (v === "1" || v === "foreground" || v === "fg") return "foreground";
  if (v === "2" || v === "background" || v === "bg") return "background";
  if (v === "3" || v === "tray") return "tray";
  return null;
}

async function promptModeInteractive(): Promise<StartMode> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Show the prompt and read once. Re-prompt exactly once on invalid input,
  // then fall through to the default so a misclick never hangs the CLI.
  const ask = (): Promise<string> => new Promise((resolve) => {
    rl.question("Choice [1/2/3]: ", (answer) => resolve(answer.trim()));
  });
  console.error("How would you like OpenKan to run?\n");
  console.error("  1. Stay interactive (foreground — Ctrl+C to stop)\n");
  console.error("  2. Continue in background (terminal returns; server keeps running)\n");
  console.error("  3. Hide to tray (system tray icon; terminal returns)\n");
  let raw = await ask();
  if (raw === "") raw = "2"; // default to background
  const first = normalizeInput(raw);
  if (first === null) {
    console.error(`Unrecognised choice: "${raw}". `);
    raw = await ask();
    if (raw === "") raw = "2";
  }
  rl.close();
  const normalized = normalizeInput(raw);
  return normalized ?? "background";
}

// ─── URL opener ───────────────────────────────────────────────────────────────

function openUrl(url: string): void {
  const openCmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(openCmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    console.error(`ok: could not open browser: ${e}\n`);
  }
}

// Spawn a detached child process running the same CLI entrypoint in foreground
// mode, so the HTTP listener stays alive after the parent exits. The child
// inherits the Node runtime flags (e.g. --experimental-strip-types) from the
// parent's process.execArgv so it runs under the same TS loader.
//
// We use detached: true so the child becomes its own process group leader and
// survives the parent's exit (no SIGHUP propagation). stdio: "ignore" frees the
// terminal — without it the child would still own the parent's stdio FDs and
// the user's prompt would not return. On Windows, windowsHide: true is needed
// to suppress the new console window that `detached: true` creates.
function spawnBackgroundChild(opts: {
  host: string;
  port: number;
  noOpen: boolean;
  noAutoDetect: boolean;
  projectRoot: string | null;
}): number {
  const scriptPath = process.argv[1] ?? join(OPENKAN_ROOT, "bin", "ok.ts");
  const childArgs: string[] = [
    ...process.execArgv,
    scriptPath,
    "serve",
    "--mode=foreground",
    `--port=${opts.port}`,
    `--host=${opts.host}`,
    "--no-open",
  ];
  if (opts.noAutoDetect) childArgs.push("--no-auto-detect");
  if (opts.projectRoot) childArgs.push(`--project=${opts.projectRoot}`);

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error("ok serve: failed to spawn background child (no PID returned)");
  }
  return child.pid;
}

// Poll the HTTP server until it responds (any non-5xx status) or the timeout
// elapses. We use `fetch` against the configured URL; a connection refused or
// a 5xx means "still starting" and we retry.
async function waitForHttpUp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Pre-flight: read `.ok/server.pid` and decide whether an existing server is
// already serving on the target port. Returns:
//
//   { existing: false }                                    — pidfile missing, stale, or dead PID
//   { existing: true, pid, port }                         — live server, do not collide
//   { existing: true, pid, port, tookOver: true }         — --force SIGTERMed the live one
//
// When `force === false` and an existing server is alive, this returns
// existing: true so the caller can error out fast. When `force === true`
// and the existing PID is alive, this SIGTERMs it (and waits up to 3s for
// graceful shutdown) before returning. The caller is then expected to spawn
// its own child which will bind the port cleanly.
async function preflightExistingServer(
  pidFile: string,
  wantedPort: number,
  force: boolean,
): Promise<{ existing: boolean; pid?: number; port?: number; tookOver?: boolean }> {
  if (!existsSync(pidFile)) return { existing: false };
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf-8").trim();
  } catch {
    return { existing: false };
  }
  const parts = raw.split(":");
  const pid = parseInt(parts[0], 10);
  const pidPort = parts.length >= 2 && parts[1] ? parseInt(parts[1], 10) : NaN;
  const port = Number.isFinite(pidPort) ? pidPort : wantedPort;
  if (!Number.isFinite(pid)) return { existing: false };
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    // Stale pidfile — clear it so the child's acquireLock doesn't trip on it.
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(pidFile);
    } catch { /* ignore */ }
    return { existing: false };
  }
  if (!force) {
    return { existing: true, pid, port };
  }
  // --force: take over. SIGTERM, then SIGKILL after a short grace window.
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    let stillAlive = false;
    try { process.kill(pid, 0); stillAlive = true; } catch { stillAlive = false; }
    if (!stillAlive) break;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  // Best-effort unlink so the child's acquireLock sees an empty directory.
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(pidFile);
  } catch { /* ignore */ }
  return { existing: true, pid, port, tookOver: true };
}

// ─── cmdStart / cmdServe / cmdStartTray ────────────────────────────────────────

export async function cmdStart(ctx: BoardContext, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp("start");
    return;
  }
  const host = (args.flags["host"] as string) ?? loadConfig().host;
  const portStr = (args.flags["port"] as string) ?? String(loadConfig().port);
  const port = parseInt(portStr, 10) || DEFAULT_CONFIG.port;
  const noOpen = args.flags["no-open"] === true || args.flags["no-open"] === "true";
  const foreground = args.flags["foreground"] === true || args.flags["foreground"] === "true";
  const noAutoDetect = args.flags["no-auto-detect"] === true || args.flags["no-auto-detect"] === "true";
  const force = args.flags["force"] === true || args.flags["force"] === "true";
  const mode: StartMode = args.flags["mode"] !== undefined
    ? parseMode(args.flags["mode"])
    : (foreground ? "foreground" : "background");
  // --project flag: switch the active project before starting
  const projectFlag = args.flags["project"] as string | undefined;
  if (projectFlag) {
    const projectRoot = projectFlag;
    const id = basename(projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const entry = addProject({ id, name: basename(projectRoot), root: projectRoot });
    setActiveProject(entry.id);
    ctx.directory = projectRoot;
    setProjectRoot(projectRoot);
  }
  // Init board if not already
  await initBoard(ctx);
  // The tray mode hides the terminal — never auto-open the browser because
  // the user already chose to hide. Foreground keeps the existing behaviour
  // (open unless --no-open). Background also auto-opens by default.
  const effectiveNoOpen = noOpen || mode === "tray";
  if (mode === "foreground") {
    // Foreground: bind the port in this process and stay alive so Ctrl+C and
    // SIGTERM hit us directly. The HTTP listener and the keepalive share the
    // same process, which is the simplest model for foreground.
    const result = await startOrAttach(ctx, { host, port, webRoot: OPENKAN_WEB, _autoDetect: !noAutoDetect, force });
    console.log(`OpenKan server running at ${result.url} (pid=${result.pid})\n`);
    // Keep process alive
    await new Promise(() => {});
  } else if (mode === "tray") {
    // Tray: same in-process model as foreground, plus a system tray icon.
    const result = await startOrAttach(ctx, { host, port, webRoot: OPENKAN_WEB, _autoDetect: !noAutoDetect, force });
    return cmdStartTray(ctx, result);
  } else {
    // Background mode: spawn a detached child process running the same serve
    // code in foreground mode, then exit the parent immediately so the user's
    // terminal returns. The child owns the HTTP listener and the pidfile; the
    // pidfile points at the child PID, so `ok stop` correctly SIGTERMs it.
    // We deliberately do NOT call startOrAttach in the parent — the parent
    // never binds the port, so the child can bind it without collision.
    //
    // Preflight: if an existing pidfile points at a live server on this port,
    // fail fast (or take it over when --force was passed). This avoids spawning
    // a detached child that will collide with the live server and pollute the
    // pidfile when its lock-acquire rejects it. The child runs `startOrAttach`
    // which already enforces this, but its stdio is "ignore" so the parent
    // would never see the error — we have to detect the collision here.
    const pidFile = join(ctx.directory, ".ok", "server.pid");
    const preflight = await preflightExistingServer(pidFile, port, force);
    if (preflight.existing) {
      if (force) {
        // Wait for the take-over kill to settle.
        await new Promise((r) => setTimeout(r, 300));
      } else {
        console.error(
          `ok serve: server already running at http://${host}:${preflight.port ?? port} (pid=${preflight.pid}). ` +
          `Stop it with 'ok stop', or pass --force to take over.\n`,
        );
        process.exit(1);
      }
    }
    const childPid = spawnBackgroundChild({ host, port, noOpen, noAutoDetect, projectRoot: projectFlag ?? null });
    const url = `http://${host}:${port}/`;
    const serverUp = await waitForHttpUp(url, 8_000);
    if (!serverUp) {
      // Server did not come up (port busy, missing permissions, etc.). Kill the
      // child and surface the error so the user gets a clear message instead of
      // a silent exit.
      try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      console.error(`ok serve: background child failed to bind — is port ${port} already in use?\n`);
      process.exit(1);
    }
    // The child has written the pidfile (with pid:port:empty). Overwrite with
    // "pid:port:parentPid" format so cmdStop can SIGTERM both parent and child.
    // The child's startOrAttach wrote the pidfile before HTTP bound, so this
    // overwrite happens after that and "wins".
    writeFileSync(pidFile, `${childPid}:${port}:${process.pid}`, "utf-8");
    console.log(`OpenKan server at ${url} (pid=${childPid})\n`);
    if (!effectiveNoOpen) {
      openUrl(url);
    }
    process.exit(0);
  }
}

// Start a tray icon for the running in-process server. Falls back to plain
// background mode (with a one-line warning) when the tray subsystem is
// unavailable — Linux without libappindicator, headless CI, etc.
async function cmdStartTray(
  ctx: BoardContext,
  result: { pid: number; port: number; url: string },
): Promise<void> {
  console.log(`OpenKan server at ${result.url} (pid=${result.pid})\n`);
  console.log("Initializing system tray icon…\n");
  const iconDir = defaultIconDir();
  let tray;
  try {
    tray = await createTray({
      url: result.url,
      iconDir,
      initialState: "running",
      onOpen: async () => {
        // Open dashboard in the OS browser. Reuse cmdOpen so we get the same
        // .ok/server.pid liveness checks the CLI uses.
        try {
          await cmdOpen(ctx);
        } catch {
          // cmdOpen already prints errors to stderr; failures here must not
          // crash the tray process.
        }
      },
      onStatus: async () => {
        try {
          await cmdStatus(ctx);
        } catch {
          // cmdStatus exits non-zero on missing pid; we want to keep the
          // tray alive even if the pid file is gone.
        }
      },
      onStop: async () => {
        // Reuse cmdStop so the .ok/server.pid lifecycle stays consistent.
        await cmdStop(ctx).catch(() => {
          // best effort — even if cmdStop fails, exit so the tray does not
          // linger.
        });
        process.exit(0);
      },
    });
  } catch (e) {
    if (e instanceof TrayUnavailableError) {
      console.error(
        `ok serve: system tray unavailable (${e.message}). Falling back to background mode.\n`,
      );
      // Surface the full cause chain. bin/tray.ts already logged a WARN line
      // per failure site, but the error object may still carry a nested
      // `cause` (e.g. ERR_MODULE_NOT_FOUND or an EACCES from the icon read)
      // whose message never made it into e.message. Printing name+stack of
      // every link keeps the fallback from hiding the real failure.
      let cause: unknown = (e as { cause?: unknown }).cause;
      while (cause instanceof Error) {
        console.error(`ok serve:   caused by ${cause.name}: ${cause.message}`);
        cause = (cause as { cause?: unknown }).cause;
      }
    } else {
      console.error(
        `ok serve: system tray init failed (${(e as Error).message}). Falling back to background mode.\n`,
      );
      let cause: unknown = (e as { cause?: unknown }).cause;
      while (cause instanceof Error) {
        console.error(`ok serve:   caused by ${cause.name}: ${cause.message}`);
        cause = (cause as { cause?: unknown }).cause;
      }
    }
    // Background fallback: detach from TTY and keep the process alive so the
    // HTTP listener survives the CLI exit. Same rationale as cmdStart's
    // background branch.
    detachForBackground();
    await new Promise<void>(() => {});
  }
  // The tray process stays alive while the tray subprocess is alive. Block
  // here so cmdStart doesn't return to main(); otherwise main() would exit
  // and we'd take the process down with us.
  await new Promise<void>(() => {
    // never resolves — the tray's onStop / onExit handlers will call
    // process.exit() when the user asks to quit.
  });
}

// Find and clean up orphaned ok serve processes (detached children with PPID=1).
// This is an escape hatch for operators when test runs or other processes leave
// orphan servers running.
async function cmdCleanupOrphans(autoYes: boolean): Promise<void> {
  // Use pgrep to find detached ok serve processes (PPID=1 means orphaned)
  const { spawnSync } = await import("node:child_process");

  // Find processes: bin/ok.ts or bin/ok.mjs serve with PPID=1
  const pgrepResult = spawnSync("pgrep", ["-f", "bin/ok.*serve", "-o", "-P", "1"], { encoding: "utf8" });
  const pids: number[] = [];
  if (pgrepResult.stdout) {
    for (const line of pgrepResult.stdout.trim().split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (Number.isFinite(pid)) pids.push(pid);
    }
  }

  if (pids.length === 0) {
    console.log("No orphaned ok serve processes found.\n");
    return;
  }

  // For each PID, get additional info (start time, cwd)
  interface OrphanInfo { pid: number; startTime: string; cwd: string; }
  const orphans: OrphanInfo[] = [];
  for (const pid of pids) {
    // Get start time
    const psStartResult = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const startTime = psStartResult.stdout.trim() || "unknown";
    // Get cwd
    const psCwdResult = spawnSync("ps", ["-o", "cwd=", "-p", String(pid)], { encoding: "utf8" });
    const cwd = psCwdResult.stdout.trim() || "unknown";
    orphans.push({ pid, startTime, cwd });
  }

  console.log(`Found ${orphans.length} orphaned ok serve process(es):\n`);
  for (const o of orphans) {
    console.log(`  PID: ${o.pid}`);
    console.log(`  Started: ${o.startTime}`);
    console.log(`  CWD: ${o.cwd}`);
    console.log("");
  }

  // Ask for confirmation unless --yes
  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Kill ${orphans.length} process(es)? [y/N] `, (a) => resolve(a.trim().toLowerCase()));
    });
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.\n");
      return;
    }
  }

  // SIGTERM them, wait 2s, then SIGKILL survivors
  console.log("Sending SIGTERM...\n");
  for (const o of orphans) {
    try { process.kill(o.pid, "SIGTERM"); } catch { /* already gone */ }
  }

  // Wait 2 seconds
  await new Promise(r => setTimeout(r, 2000));

  // SIGKILL survivors
  let killed = 0;
  for (const o of orphans) {
    try {
      process.kill(o.pid, 0); // check if still alive
      try { process.kill(o.pid, "SIGKILL"); } catch { /* already gone */ }
      killed++;
    } catch {
      // Process already exited
    }
  }

  console.log(`Cleaned up ${killed} orphaned process(es).\n`);
}

export async function cmdServe(ctx: BoardContext, argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp("serve");
    return;
  }
  const args = parseArgs(["serve", ...argv]);
  const host = (args.flags["host"] as string) ?? loadConfig().host;
  const portStr = (args.flags["port"] as string) ?? String(loadConfig().port);
  const port = parseInt(portStr, 10) || DEFAULT_CONFIG.port;
  const noOpen = args.flags["no-open"] === true || args.flags["no-open"] === "true";
  const noAutoDetect = args.flags["no-auto-detect"] === true || args.flags["no-auto-detect"] === "true";
  const projectFlag = args.flags["project"] as string | undefined;
  const force = args.flags["force"] === true || args.flags["force"] === "true";
  const cleanupOrphans = args.flags["cleanup-orphans"] === true || args.flags["cleanup-orphans"] === "true";
  const yesToAll = args.flags["yes"] === true || args.flags["yes"] === "true";

  // Handle --cleanup-orphans: find and kill orphaned ok serve processes
  if (cleanupOrphans) {
    await cmdCleanupOrphans(yesToAll);
    return;
  }

  let mode: StartMode;
  if (args.flags["mode"] !== undefined) {
    // Explicit --mode always wins. Validate it here so an unknown value
    // gives a clear error rather than silently picking background.
    mode = parseMode(args.flags["mode"]);
    if (mode === "tray" && !process.stdin.isTTY && !process.stdout.isTTY) {
      console.error("ok serve: --mode=tray requires a TTY. Run from a terminal.\n");
      process.exit(1);
    }
  } else if (process.stdin.isTTY) {
    mode = await promptModeInteractive();
  } else {
    // Non-interactive fallback. Skip the prompt and use background so CI,
    // piped scripts, and double-clicked installers always succeed.
    console.log("ok serve: non-interactive shell — defaulting to background mode.\n");
    mode = "background";
  }
  // Delegate to cmdStart with the resolved mode. cmdStart already handles
  // --foreground / --mode plumbing, --no-open, and --project switching.
  const forwarded: string[] = ["start", `--mode=${mode}`];
  if (host !== loadConfig().host) forwarded.push("--host", host);
  if (port !== loadConfig().port) forwarded.push("--port", String(port));
  if (noOpen) forwarded.push("--no-open");
  if (noAutoDetect) forwarded.push("--no-auto-detect");
  if (projectFlag) forwarded.push("--project", projectFlag);
  if (force) forwarded.push("--force");
  await cmdStart(ctx, forwarded);
}

// ─── cmdStop / cmdStatus / cmdOpen ─────────────────────────────────────────────

export async function cmdStop(ctx: BoardContext): Promise<void> {
  const pidFile = join(ctx.directory, ".ok", "server.pid");
  if (!existsSync(pidFile)) {
    console.error("No server.pid found — is the server running?\n");
    process.exit(1);
  }
  const raw = readFileSync(pidFile, "utf-8").trim();
  const parts = raw.split(":");
  const pid = parseInt(parts[0], 10);
  const port = parts.length >= 2 && parts[1] ? parseInt(parts[1], 10) : 7777;
  const parentPid = parts.length >= 3 && parts[2] ? parseInt(parts[2], 10) : null;
  
  if (isNaN(pid)) {
    console.error("Invalid PID in server.pid\n");
    process.exit(1);
  }
  // If the server lives in this very process (foreground CLI / tray mode),
  // self-SIGTERM would skip the graceful HTTP shutdown and the pidfile
  // cleanup. Use the in-process server handle instead — it closes the
  // HTTP server, releases the lock, and removes the pidfile deterministically.
  if (pid === process.pid) {
    const server = getServer();
    if (server && typeof server.stop === "function") {
      await server.stop();
      console.log("Server stopped.\n");
      return;
    }
    // No in-process server reference (e.g. attach-only): fall through to
    // the SIGTERM-self path which Node executes alongside the rest of
    // this function synchronously until the runtime kills us.
  }
  
  // SIGTERM the child process
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // PID may already be dead
  }
  
  // Wait up to 5s for graceful shutdown of child
  let waited = 0;
  while (waited < 5000) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
    } catch {
      break;
    }
  }
  
  // If there's a parent PID (background mode), SIGTERM it too
  if (parentPid !== null && !isNaN(parentPid)) {
    try {
      process.kill(parentPid, "SIGTERM");
    } catch {
      // Parent may already be dead
    }
    // Wait up to 2s for parent to exit
    let parentWaited = 0;
    while (parentWaited < 2000) {
      try {
        process.kill(parentPid, 0);
        await new Promise((r) => setTimeout(r, 200));
        parentWaited += 200;
      } catch {
        break;
      }
    }
    // If parent still alive, SIGKILL
    try {
      process.kill(parentPid, "SIGKILL");
    } catch {
      // Parent already dead
    }
  }
  
  // If child still alive, SIGKILL
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Child already dead
  }
  
  console.log("Server stopped.\n");
}

export async function cmdStatus(ctx: BoardContext): Promise<void> {
  const pidFile = join(ctx.directory, ".ok", "server.pid");
  if (!existsSync(pidFile)) {
    console.error("No server.pid found — is the server running? Start it with `ok start`.\n");
    process.exit(1);
  }
  const raw = readFileSync(pidFile, "utf-8").trim();
  const [pidStr, portStr] = raw.split(":");
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) {
    console.error("Invalid PID in server.pid\n");
    process.exit(1);
  }
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    console.error("Server is not running (stale PID). Start it with `ok start`.\n");
    process.exit(1);
  }
  const cfg = loadConfig();
  const port = portStr ? parseInt(portStr, 10) : cfg.port;
  const host = cfg.host;
  const uptimeMs = Date.now() - (() => {
    try {
      const st = statSync(pidFile);
      return st.mtimeMs;
    } catch { return Date.now(); }
  })();
  const uptimeSec = Math.floor(uptimeMs / 1000);

  console.log(`status: running\n`);
  console.log(`pid: ${pid}\n`);
  console.log(`port: ${port}\n`);
  console.log(`host: ${host}\n`);
  console.log(`uptime: ${uptimeSec}s\n`);
}

export async function cmdOpen(ctx: BoardContext): Promise<void> {
  // Mirror cmdStatus: refuse to open the browser when no server is up so the
  // user gets a clear error instead of staring at a blank tab.
  const pidFile = join(ctx.directory, ".ok", "server.pid");
  if (!existsSync(pidFile)) {
    console.error("No server.pid found — is the server running? Start it with `ok start`.\n");
    process.exit(1);
  }
  const raw = readFileSync(pidFile, "utf-8").trim();
  const [pidStr, portStr] = raw.split(":");
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) {
    console.error("Invalid PID in server.pid\n");
    process.exit(1);
  }
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    console.error("Server is not running (stale PID). Start it with `ok start`.\n");
    process.exit(1);
  }
  const cfg = loadConfig();
  const port = portStr ? parseInt(portStr, 10) : cfg.port;
  const url = `http://${cfg.host}:${port}/`;
  openUrl(url);
}
