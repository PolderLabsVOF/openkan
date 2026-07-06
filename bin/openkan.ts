#!/usr/bin/env node
// OpenKan — standalone CLI entrypoint.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import type { BoardContext } from "../kanban/board.ts";
import { startOrAttach, getServer } from "../kanban/server.ts";
import { addProject, setActiveProject } from "../kanban/projects.ts";
import { initBoard, getBoard, KANBAN_DIR, setProjectRoot } from "../kanban/board.ts";
import { writeTaskMdx, writeBoardMdx } from "../kanban/mdx.ts";

// Resolve the openkan repo's web/ folder so the static UI is served no matter
// where the user invokes the CLI from. `import.meta.url` → bin/openkan.ts →
// `../web` is the bundled UI.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENKAN_ROOT = resolve(__dirname, "..");
const OPENKAN_WEB = join(OPENKAN_ROOT, "web");
import { removeDir, ensureDir } from "../kanban/io.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

interface Config {
  port: number;
  host: string;
  defaultAgent: string;
  defaultModel: string | null;
  import: { include: string[]; exclude: string[] };
  sandbox: { tsxMaxBytes: number };
}

const DEFAULT_CONFIG: Config = {
  port: 7777,
  host: "127.0.0.1",
  defaultAgent: "",
  defaultModel: null,
  import: { include: [], exclude: [] },
  sandbox: { tsxMaxBytes: 32768 },
};

function configPath(): string {
  return join(process.cwd(), ".openkan", "config.json");
}

function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg: Config): void {
  ensureDir(join(process.cwd(), ".openkan"));
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

// ─── Arg parser ───────────────────────────────────────────────────────────────

interface ParsedArgs {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
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

// ─── Subcommand: init ─────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  const dir = join(process.cwd(), ".openkan");
  ensureDir(dir);

  const boardFile = join(dir, "board.json");
  if (!existsSync(boardFile)) {
    writeFileSync(boardFile, JSON.stringify({ version: 1, columns: [{ id: "backlog", title: "Backlog" }, { id: "todo", title: "To Do" }, { id: "doing", title: "In Progress" }, { id: "review", title: "Review" }, { id: "done", title: "Done" }], tasks: [], sessions: {} }, null, 2), "utf-8");
  }

  const tasksIndexFile = join(dir, "tasks.json");
  if (!existsSync(tasksIndexFile)) {
    writeFileSync(tasksIndexFile, JSON.stringify({ tasks: [] }, null, 2), "utf-8");
  }

  const cfg = configPath();
  if (!existsSync(cfg)) {
    saveConfig(DEFAULT_CONFIG);
  }

  console.log("Initialized .openkan/ directory.");
}

// ─── Subcommand: start ───────────────────────────────────────────────────────

async function cmdStart(ctx: BoardContext, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const host = (args.flags["host"] as string) ?? loadConfig().host;
  const port = parseInt((args.flags["port"] as string) ?? String(loadConfig().port), 10);
  const noOpen = args.flags["no-open"] === true || args.flags["no-open"] === "true";
  const foreground = args.flags["foreground"] === true || args.flags["foreground"] === "true";
  const noAutoDetect = args.flags["no-auto-detect"] === true || args.flags["no-auto-detect"] === "true";

  // --project flag: switch the active project before starting
  const projectFlag = args.flags["project"] as string | undefined;
  if (projectFlag) {
    const projectRoot = projectFlag;
    const id = basename(projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    addProject({ id, name: basename(projectRoot), root: projectRoot });
    setActiveProject(id);
    ctx.directory = projectRoot;
    setProjectRoot(projectRoot);
  }

  // Init board if not already
  await initBoard(ctx);

  const result = await startOrAttach(ctx, { host, port, webRoot: OPENKAN_WEB, _autoDetect: !noAutoDetect });

  if (foreground) {
    console.log(`OpenKan server running at ${result.url} (pid=${result.pid})`);
    // Keep process alive
    await new Promise(() => {});
  } else {
    // Write PID and log files. Format: "pid:port" so status can read both
    // without re-probing. The port may differ from the config if the
    // configured port was busy.
    const pidFile = join(ctx.directory, ".openkan", "server.pid");
    writeFileSync(pidFile, `${result.pid}:${result.port}`, "utf-8");
    const logFile = join(ctx.directory, ".openkan", "server.log");
    const logStream = appendFileSync ? appendFileSync : (() => {}) as any;

    console.log(`OpenKan server at ${result.url} (pid=${result.pid})`);

    if (!noOpen) {
      openUrl(result.url);
    }
  }
}

// ─── Subcommand: stop ─────────────────────────────────────────────────────────

async function cmdStop(ctx: BoardContext): Promise<void> {
  const pidFile = join(ctx.directory, ".openkan", "server.pid");
  if (!existsSync(pidFile)) {
    console.error("No server.pid found — is the server running?");
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) { console.error("Invalid PID in server.pid"); process.exit(1); }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // PID may already be dead
  }

  // Wait up to 5s for graceful shutdown
  let waited = 0;
  while (waited < 5000) {
    try {
      process.kill(pid, 0);
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    } catch {
      break;
    }
  }

  if (waited >= 5000) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }

  try { rmSync(pidFile); } catch { /* ignore */ }
  console.log("Server stopped.");
}

// ─── Subcommand: status ───────────────────────────────────────────────────────

async function cmdStatus(ctx: BoardContext): Promise<void> {
  const pidFile = join(ctx.directory, ".openkan", "server.pid");
  if (!existsSync(pidFile)) {
    console.log("status: stopped");
    return;
  }

  const raw = readFileSync(pidFile, "utf-8").trim();
  // Format: "pid:port" (new) or "pid" (legacy)
  const [pidStr, portStr] = raw.split(":");
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) {
    console.log("status: stopped (invalid PID)");
    return;
  }

  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }

  if (!alive) {
    console.log("status: stopped");
    return;
  }

  // Port from the pid file if present, else fall back to config
  const cfg = loadConfig();
  const port = portStr ? parseInt(portStr, 10) : cfg.port;
  const host = cfg.host;
  const uptimeMs = Date.now() - (() => {
    try {
      const st = require("node:fs").statSync(pidFile);
      return st.mtimeMs;
    } catch { return Date.now(); }
  })();
  const uptimeSec = Math.floor(uptimeMs / 1000);

  console.log(`status: running`);
  console.log(`pid: ${pid}`);
  console.log(`port: ${port}`);
  console.log(`host: ${host}`);
  console.log(`uptime: ${uptimeSec}s`);
}

// ─── Subcommand: open ─────────────────────────────────────────────────────────

async function cmdOpen(ctx: BoardContext): Promise<void> {
  const cfg = loadConfig();
  const url = `http://${cfg.host}:${cfg.port}/`;
  openUrl(url);
}

// ─── Subcommand: config ───────────────────────────────────────────────────────

async function cmdConfig(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "";
  const cfg = loadConfig();

  if (sub === "list") {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  if (sub === "get") {
    const key = argv[1];
    if (!key) { console.error("Usage: config get <key>"); process.exit(1); }
    const val = key.split(".").reduce((obj: any, k) => obj?.[k], cfg);
    console.log(typeof val === "object" ? JSON.stringify(val) : String(val ?? ""));
    return;
  }

  if (sub === "set") {
    const key = argv[1];
    const value = argv[2];
    if (!key || value === undefined) { console.error("Usage: config set <key> <value>"); process.exit(1); }
    // Parse value as JSON if possible, else string
    let parsed: any;
    try { parsed = JSON.parse(value); } catch { parsed = value; }
    const keys = key.split(".");
    const last = keys.pop()!;
    const target = keys.reduce((obj: any, k) => { if (!(k in obj)) obj[k] = {}; return obj[k]; }, cfg);
    target[last] = parsed;
    saveConfig(cfg);
    console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
    return;
  }

  console.error("Usage: config list | config get <key> | config set <key> <value>");
  process.exit(1);
}

// ─── Subcommand: logs ─────────────────────────────────────────────────────────

async function cmdLogs(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const tail = parseInt((args.flags["tail"] as string) ?? "50", 10);
  const follow = args.flags["follow"] === true || args.flags["follow"] === "true";
  const logFile = join(process.cwd(), ".openkan", "server.log");

  if (!existsSync(logFile)) {
    console.error("No server.log found.");
    process.exit(1);
  }

  const lines = readFileSync(logFile, "utf-8").split("\n");
  const lastLines = lines.slice(-tail);
  console.log(lastLines.join("\n"));

  if (follow) {
    // Simple tail -f using fs watch
    const { watch } = await import("node:fs");
    let offset = lines.length;
    watch(logFile, () => {
      const newLines = readFileSync(logFile, "utf-8").split("\n");
      const newPart = newLines.slice(offset);
      if (newPart.length) {
        process.stdout.write(newPart.join("\n") + "\n");
        offset = newLines.length;
      }
    });
    // Keep alive
    await new Promise(() => {});
  }
}

// ─── Subcommand: reset ───────────────────────────────────────────────────────

async function cmdReset(ctx: BoardContext, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const hard = args.flags["hard"] === true || args.flags["hard"] === "true";

  process.stderr.write("Type 'yes' to confirm: ");
  const answer = await new Promise<string>(resolve => {
    process.stdin.once("data", d => resolve(d.toString().trim()));
  });
  if (answer !== "yes") { console.log("Aborted."); return; }

  // Stop if running
  try { await cmdStop(ctx); } catch { /* ignore */ }

  const dir = join(ctx.directory, ".openkan");

  if (hard) {
    // Wipe tasks and sessions subdirs
    const tasksDir = join(dir, "tasks");
    const sessionsDir = join(dir, "sessions");
    removeDir(tasksDir);
    removeDir(sessionsDir);
  }

  removeDir(dir);
  console.log("Reset complete.");
}

// ─── URL opener ────────────────────────────────────────────────────────────────

function openUrl(url: string): void {
  const openCmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(openCmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    console.warn(`Could not open browser: ${e}`);
  }
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

function printHelp(cmd?: string): void {
  const msgs: Record<string, string> = {
    init: "init                             Create .openkan/ directory (idempotent)",
    start: "start [--port N] [--host H] [--no-open] [--no-auto-detect] [--foreground] [--project /abs/path]  Start the server",
    stop: "stop                             Stop the running server",
    status: "status                          Show server status, port, pid, uptime",
    open: "open                             Open the kanban UI in browser",
    config: "config list|get <key>|set <key> <value>  Manage config",
    logs: "logs [--tail N] [--follow]       Print server logs",
    reset: "reset [--hard]                  Reset .openkan/ (--hard also wipes tasks/sessions)",
  };
  if (cmd && msgs[cmd]) {
    console.log(`openkan ${msgs[cmd]}`);
  } else {
    console.log("Usage: openkan <command> [args...]\n");
    Object.values(msgs).forEach(m => console.log(`  ${m}`));
    console.log("\nFlags: --flag=value or --flag value, can appear before or after positionals.");
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printHelp(argv[0] === "-h" || argv[0] === "--help" ? argv[1] : undefined);
    return;
  }

  const { cmd, positionals, flags } = parseArgs(argv);

  const ctx: BoardContext = {
    directory: process.cwd(),
    client: null as any,
    log: async (lvl, msg) => { console.log(`[${lvl}] ${msg}`); },
  };

  // Make sure ctx.directory is set before any command tries to use it
  // (init doesn't need it, but others do)
  if (cmd !== "init" && cmd !== "config") {
    // Init board to set KANBAN_DIR for other commands
    try {
      await initBoard(ctx);
    } catch (e: any) {
      if (e?.message?.includes("not initialised") || e?.message?.includes("Board not initialised")) {
        // Board not yet initialized — init first
        await cmdInit();
        await initBoard(ctx);
      }
    }
  }

  switch (cmd) {
    case "init":   return cmdInit();
    case "start":   return cmdStart(ctx, argv.slice(1));
    case "stop":    return cmdStop(ctx);
    case "status":  return cmdStatus(ctx);
    case "open":    return cmdOpen(ctx);
    case "config":  return cmdConfig(argv.slice(1));
    case "logs":    return cmdLogs(argv.slice(1));
    case "reset":   return cmdReset(ctx, argv.slice(1));
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: any) => {
    console.error(`openkan: ${e?.message ?? e}`);
    process.exit(1);
  });
}
