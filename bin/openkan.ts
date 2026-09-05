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
import { runImport } from "../kanban/import.ts";
import { main as runPlanning } from "./ok.ts";
import { cpSync } from "node:fs";
import { homedir } from "node:os";
import { installAgent } from "./install-agent.mjs";

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


// Agent-facing REST capability map. `openkan api` exposes this entire surface
// without requiring a different shell script for each dashboard feature.
const AGENT_CAPABILITIES = Object.freeze({
  board: ["GET /api/board", "GET /api/tasks-index", "GET /api/tasks/:id", "POST /api/tasks", "PATCH /api/tasks/:id", "DELETE /api/tasks/:id", "POST /api/tasks/bulk", "POST /api/organize", "POST /api/import"],
  taskContext: ["GET|POST /api/tasks/:id/comments", "POST /api/tasks/:id/ask", "POST /api/tasks/:id/respond", "GET /api/tasks/:id/subtasks", "GET|POST /api/tasks/:id/images", "POST /api/tasks/:id/start", "POST /api/tasks/:id/abort"],
  planning: ["openkan task|plan|prd|goal …", "openkan progress --json", "openkan doctor", "ok task|plan|prd|goal …", "GET /api/goals", "PATCH /api/goals/:prdId/:goalId"],
  docs: ["GET /api/docs", "GET|PUT|DELETE /api/docs/:path", "POST /api/docs/render", "POST /api/docs/generate"],
  chat: ["POST /api/chat/send", "GET /api/chat/sessions", "GET /api/chat/sessions/:id", "POST /api/chat/sessions/:id/abort"],
  agents: ["GET /api/claude/snapshot", "GET /api/claude/agents|skills|commands|hooks|teams|workflows", "GET /api/claude/activity", "GET /api/claude/model-router"],
  projects: ["GET|POST /api/projects", "PATCH /api/projects/:id/active", "POST /api/projects/auto-detect", "DELETE /api/projects/:id"],
  insight: ["GET /api/search", "GET /api/tags", "GET /api/changelog", "GET /api/changelog/summary", "GET /api/insights/velocity", "GET /api/contributors"],
  config: ["GET|PATCH /api/settings", "GET /api/config-sections", "PATCH /api/config-sections/:sectionId", "openkan config list|get|set"],
});

function configPath(): string {
  return join(process.cwd(), ".ok", "openkan.json");
}

function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg: Config): void {
  ensureDir(join(process.cwd(), ".ok"));
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
  const dir = join(process.cwd(), ".ok");
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

  console.log("Initialized .ok/ directory.");
}

// ─── Subcommand: import ───────────────────────────────────────────────────────

async function cmdImport(ctx: BoardContext, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const pathFlag = args.flags["path"] as string | undefined;
  const includeFlag = args.flags["include"] as string | undefined;
  const excludeFlag = args.flags["exclude"] as string | undefined;

  // ctx.directory must be set
  if (!ctx.directory) {
    console.error("openkan import: no project directory set — run 'openkan start' first or set --path");
    process.exit(1);
  }

  const targetDir = pathFlag ?? ctx.directory;
  const importCtx = { ...ctx, directory: targetDir };

  const include = includeFlag ? includeFlag.split(",").map((s) => s.trim()) : undefined;
  const exclude = excludeFlag ? excludeFlag.split(",").map((s) => s.trim()) : undefined;

  const result = await runImport(importCtx, { include, exclude });

  if (result.imported.length === 0) {
    console.log("No unchecked checkboxes found.");
    return;
  }

  console.log(`imported ${result.imported.length} tasks`);
  const board = await getBoard();
  for (const id of result.imported) {
    const task = board.tasks.find((t) => t.id === id);
    if (task && task.source) {
      console.log(`  created ${id} at ${task.source.path}:${task.source.line}`);
    } else {
      console.log(`  created ${id}`);
    }
  }
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
    const entry = addProject({ id, name: basename(projectRoot), root: projectRoot });
    setActiveProject(entry.id);
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
    const pidFile = join(ctx.directory, ".ok", "server.pid");
    writeFileSync(pidFile, `${result.pid}:${result.port}`, "utf-8");
    const logFile = join(ctx.directory, ".ok", "server.log");
    const logStream = appendFileSync ? appendFileSync : (() => {}) as any;

    console.log(`OpenKan server at ${result.url} (pid=${result.pid})`);

    if (!noOpen) {
      openUrl(result.url);
    }
  }
}

// ─── Subcommand: stop ─────────────────────────────────────────────────────────

async function cmdStop(ctx: BoardContext): Promise<void> {
  const pidFile = join(ctx.directory, ".ok", "server.pid");
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
  const pidFile = join(ctx.directory, ".ok", "server.pid");
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
  // Mirror cmdStatus: refuse to open the browser when no server is up so the
  // user gets a clear error instead of staring at a blank tab.
  const pidFile = join(ctx.directory, ".ok", "server.pid");
  if (!existsSync(pidFile)) {
    console.error("No server.pid found — is the server running? Start it with `openkan start`.");
    process.exit(1);
  }
  const raw = readFileSync(pidFile, "utf-8").trim();
  const [pidStr, portStr] = raw.split(":");
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) {
    console.error("Invalid PID in server.pid");
    process.exit(1);
  }
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (!alive) {
    console.error("Server is not running (stale PID). Start it with `openkan start`.");
    process.exit(1);
  }

  const cfg = loadConfig();
  const port = portStr ? parseInt(portStr, 10) : cfg.port;
  const url = `http://${cfg.host}:${port}/`;
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
  const logFile = join(process.cwd(), ".ok", "server.log");

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

// ─── Agent API bridge ─────────────────────────────────────────────────────────

function apiBaseUrl(args: ParsedArgs): string {
  const cfg = loadConfig();
  const host = String(args.flags.host ?? cfg.host);
  const port = Number.parseInt(String(args.flags.port ?? cfg.port), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a valid TCP port");
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) throw new Error("openkan api only permits a loopback --host");
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function parseJsonInput(args: ParsedArgs): unknown | undefined {
  const raw = args.flags.data;
  const file = args.flags["data-file"];
  if (raw !== undefined && file !== undefined) throw new Error("Use either --data or --data-file, not both");
  const value = file !== undefined ? readFileSync(resolve(String(file)), "utf-8") : raw;
  if (value === undefined || value === true) return undefined;
  try { return JSON.parse(String(value)); }
  catch { throw new Error("--data must be valid JSON"); }
}

function printApiResult(status: number, statusText: string, body: string, jsonOnly: boolean): void {
  let rendered = body;
  try { rendered = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep text response */ }
  if (!jsonOnly) process.stderr.write(`openkan api: ${status} ${statusText}\n`);
  process.stdout.write(`${rendered}${rendered.endsWith("\n") ? "" : "\n"}`);
}

async function cmdApi(argv: string[]): Promise<void> {
  const args = parseArgs(["api", ...argv]);
  const path = args.positionals[0];
  if (!path) throw new Error("Usage: openkan api <path> [--method GET] [--data JSON|--data-file file] [--json]");
  if (!path.startsWith("/api/")) throw new Error("API path must begin with /api/");
  if (path.includes("..") || /\s/.test(path)) throw new Error("API path must be a clean relative API path");
  const method = String(args.flags.method ?? (args.flags.data !== undefined || args.flags["data-file"] !== undefined ? "POST" : "GET")).toUpperCase();
  if (!/^(GET|POST|PATCH|PUT|DELETE)$/.test(method)) throw new Error("--method must be GET, POST, PATCH, PUT, or DELETE");
  const payload = parseJsonInput(args);
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${apiBaseUrl(args)}${path}`, init);
  const body = await response.text();
  printApiResult(response.status, response.statusText, body, args.flags.json === true || args.flags.json === "true");
  if (!response.ok) process.exitCode = 1;
}

async function cmdBoard(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const args = parseArgs(['board', ...rest]);
  const [id, ...words] = args.positionals;
  const transport: string[] = ['--json'];
  for (const key of ['host', 'port']) if (args.flags[key] !== undefined) transport.push(`--${key}`, String(args.flags[key]));
  let path = '/api/board';
  let method = 'GET';
  let data: Record<string, unknown> | undefined;
  if (sub === 'show' && id) path = `/api/tasks/${encodeURIComponent(id)}`;
  else if (sub === 'add' && id) {
    if (args.flags.column && !['backlog', 'todo', 'doing', 'review', 'done'].includes(String(args.flags.column))) throw new Error('column must be backlog|todo|doing|review|done');
    path = '/api/tasks'; method = 'POST';
    data = { title: [id, ...words].join(' '), column: String(args.flags.column || 'todo') };
    if (typeof args.flags.description === 'string') data.description = args.flags.description;
  } else if (sub === 'move' && id && words.length === 1) {
    if (!['backlog', 'todo', 'doing', 'review', 'done'].includes(words[0])) throw new Error('column must be backlog|todo|doing|review|done');
    path = `/api/tasks/${encodeURIComponent(id)}`; method = 'PATCH'; data = { column: words[0] };
  } else if (sub === 'comment' && id && words.length) {
    path = `/api/tasks/${encodeURIComponent(id)}/comments`; method = 'POST';
    data = { text: words.join(' '), blockId: 'progress', line: 1, author: String(args.flags.author || 'agent:openkan') };
  } else if (sub !== 'list') {
    throw new Error('Usage: openkan board list | show <id> | add <title> [--column todo] | move <id> <column> | comment <id> <text> [--author agent:NAME]');
  }
  // The dashboard can select another repository; never silently write to it.
  const response = await fetch(`${apiBaseUrl(args)}/api/project`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Cannot verify active project: HTTP ${response.status}`);
  const project = await response.json() as { active?: { root?: string } };
  if (project.active?.root && resolve(project.active.root) !== resolve(process.cwd())) {
    throw new Error(`Dashboard is on ${project.active.root}; select this repository with openkan project use <id> before using board commands`);
  }
  await cmdApi([path, '--method', method, ...transport, ...(data ? ['--data', JSON.stringify(data)] : [])]);
}

async function cmdProject(argv: string[]): Promise<void> {
  if (argv[0] === 'list') return cmdApi(['/api/projects', '--json', ...argv.slice(1)]);
  if (argv[0] === 'use' && argv[1]) return cmdApi([`/api/projects/${encodeURIComponent(argv[1])}/active`, '--method', 'PATCH', '--json', ...argv.slice(2)]);
  throw new Error('Usage: openkan project list | use <id>');
}

async function cmdAgentContext(argv: string[]): Promise<void> {
  const args = parseArgs(["context", ...argv]);
  const endpoints = {
    project: "/api/project", board: "/api/board", tasks: "/api/tasks-index", goals: "/api/goals",
    docs: "/api/docs", projects: "/api/projects", agents: "/api/claude/agents", workflows: "/api/claude/workflows",
    chatSessions: "/api/chat/sessions", settings: "/api/config-sections", tags: "/api/tags",
  } as const;
  const base = apiBaseUrl(args);
  const entries = await Promise.all(Object.entries(endpoints).map(async ([name, path]) => {
    try {
      const response = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
      const raw = await response.text();
      let value: unknown = raw;
      try { value = JSON.parse(raw); } catch { /* retain raw body */ }
      return [name, response.ok ? value : { error: `HTTP ${response.status}`, body: value }] as const;
    } catch (error) {
      return [name, { error: error instanceof Error ? error.message : String(error) }] as const;
    }
  }));
  const context = Object.fromEntries(entries);
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), capabilities: AGENT_CAPABILITIES, context }, null, 2)}\n`);
}

async function cmdAgent(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "capabilities";
  if (sub === "install") {
    const args = parseArgs(argv.slice(1));
    if (args.flags.provider && args.flags.provider !== "claude") throw new Error("Only the Claude provider is currently supported");
    const result = installAgent({ force: args.flags.force === true, ...(typeof args.flags.target === "string" ? { configDir: resolve(args.flags.target) } : {}) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write("Usage: openkan agent install|capabilities|context|call|start|abort\n\n  install [--target DIR] [--force]  Install the Claude agent and skill\n  capabilities              Print the supported local API groups\n  context [--json]          Snapshot active workspace context\n  call /api/path [flags]    Call a loopback OpenKan API route\n  start <task-id> [flags]   Start the configured agent for a task\n  abort <task-id> [flags]   Abort a running task agent\n");
    return;
  }
  if (sub === "capabilities") {
    process.stdout.write(`${JSON.stringify(AGENT_CAPABILITIES, null, 2)}\n`);
    return;
  }
  if (sub === "context") return cmdAgentContext(argv.slice(1));
  if (sub === "call") return cmdApi(argv.slice(1));
  if (sub === "start") {
    const taskId = argv[1];
    if (!taskId) throw new Error("Usage: openkan agent start <task-id> [--agent id] [--model id]");
    const args = parseArgs(["start", ...argv.slice(2)]);
    const data: Record<string, string> = {};
    if (typeof args.flags.agent === "string") data.agent = args.flags.agent;
    if (typeof args.flags.model === "string") data.model = args.flags.model;
    const requestArgs = [`/api/tasks/${encodeURIComponent(taskId)}/start`, "--method", "POST", "--data", JSON.stringify(data)];
    if (args.flags.port !== undefined) requestArgs.push("--port", String(args.flags.port));
    if (args.flags.host !== undefined) requestArgs.push("--host", String(args.flags.host));
    return cmdApi(requestArgs);
  }
  if (sub === "abort") {
    const taskId = argv[1];
    if (!taskId) throw new Error("Usage: openkan agent abort <task-id>");
    return cmdApi([`/api/tasks/${encodeURIComponent(taskId)}/abort`, "--method", "POST", ...argv.slice(2)]);
  }
  throw new Error("Usage: openkan agent install|capabilities|context|call|start|abort …");
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

  const dir = join(ctx.directory, ".ok");

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
    init: "init                             Create .ok/ directory (idempotent)",
    start: "start [--port N] [--host H] [--no-open] [--no-auto-detect] [--foreground] [--project /abs/path]  Start the server",
    import: "import [--path DIR] [--include PATTERN] [--exclude PATTERN]  Import checkboxes as tasks",
    stop: "stop                             Stop the running server",
    status: "status                          Show server status, port, pid, uptime",
    open: "open                             Open the kanban UI in browser",
    config: "config list|get <key>|set <key> <value>  Manage config",
    logs: "logs [--tail N] [--follow]       Print server logs",
    api: "api <path> [--method M] [--data JSON|--data-file FILE]  Call any local OpenKan REST feature",
    agent: "agent install|capabilities|context|call|start|abort  Agent-first command/control bridge",
    task: "task add|list|show|update|claim|heartbeat|complete|cancel|release  Durable offline tasks (same as ok task)",
    board: "board list|show|add|move|comment   Dashboard tasks (requires local server and matching project)",
    project: "project list|use <id>             Inspect/select the dashboard project",
    plan: "plan add|list|show|update         Plans and phases (same as ok plan)",
    prd: "prd add|list|show|update           Long-horizon scope (same as ok prd)",
    goal: "goal list|add|show|update          Goals within PRDs; goal update <prd> <goal> --status met",
    progress: "progress [--prd ID] [--json]       Task, goal, plan and PRD rollups without a server",
    skill: "skill install [--agent codex|claude|all] [--target DIR] [--force]  Install command-first agent guidance",
    doctor: "doctor                            Validate the .ok/ planning store",
    reset: "reset [--hard]                  Reset .ok/ (--hard also wipes tasks/sessions)",
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

  if (["task", "plan", "prd", "goal", "progress", "doctor", "index", "migrate-from-openkan"].includes(cmd)) {
    process.exitCode = await runPlanning(argv);
    return;
  }
  if (cmd === "skill") {
    if (positionals[0] !== "install") throw new Error("Usage: openkan skill install [--agent codex|claude|all] [--target DIR] [--force]");
    const agent = String(flags.agent || "all");
    if (!["all", "claude", "codex"].includes(agent)) throw new Error("--agent must be codex, claude, or all");
    const targets = typeof flags.target === 'string' ? [resolve(flags.target)] : (agent === 'all' ? ['claude', 'codex'] : [agent]).map(name => join(homedir(), `.${name}`, 'skills', 'openkan'));
    for (const target of targets) {
      if (existsSync(target) && !flags.force) throw new Error(`${target} already exists; use --force to update`);
    }
    for (const target of targets) { cpSync(join(OPENKAN_ROOT, 'skills', 'openkan'), target, { recursive: true }); console.log(`Installed openkan skill: ${target}`); }
    return;
  }

  // Resolve nested invocations without creating a second workspace.
  if (cmd !== 'init') {
    let directory = process.cwd();
    while (!existsSync(join(directory, '.ok')) && dirname(directory) !== directory) directory = dirname(directory);
    if (existsSync(join(directory, '.ok'))) process.chdir(directory);
  }
  // Command/API helpers must not rewrite board state just to read it.
  if (cmd === 'board') return cmdBoard(argv.slice(1));
  if (cmd === 'project') return cmdProject(argv.slice(1));
  if (cmd === 'api') return cmdApi(argv.slice(1));
  if (cmd === 'agent') return cmdAgent(argv.slice(1));

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
    case "init":    await cmdInit(); process.exitCode = await runPlanning(['init']); return;
    case "start":   return cmdStart(ctx, argv.slice(1));
    case "import":  return cmdImport(ctx, argv.slice(1));
    case "stop":    return cmdStop(ctx);
    case "status":  return cmdStatus(ctx);
    case "open":    return cmdOpen(ctx);
    case "config":  return cmdConfig(argv.slice(1));
    case "logs":    return cmdLogs(argv.slice(1));
    case "api":     return cmdApi(argv.slice(1));
    case "agent":   return cmdAgent(argv.slice(1));
    case "reset":   return cmdReset(ctx, argv.slice(1));
    case "onboard": return cmdOnboard();
    case "mcp":     return cmdMcp();
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

// ─── Onboard stub (M20 wires this) ──────────────────────────────────────────

function cmdOnboard(): void {
  console.log("openkan onboard: wired in M20");
  console.log("  Hint: run 'openkan start' and use the Settings sidebar to configure agents.");
}

// ─── MCP stub (M21 wires this) ───────────────────────────────────────────────

function cmdMcp(): never {
  console.error("openkan mcp: not yet wired (M21)");
  process.exit(1);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: any) => {
    console.error(`openkan: ${e?.message ?? e}`);
    process.exit(1);
  });
}
