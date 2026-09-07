// ok/commands/agent.ts — `ok agent install|capabilities|context|call|start|abort`.

import { resolve } from "node:path";
import { installAgent } from "../../bin/install-agent.mjs";
import { AGENT_CAPABILITIES, parseArgs } from "./serve.ts";
import { apiBaseUrl } from "./api.ts";
import { cmdApi } from "./api.ts";

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
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), capabilities: AGENT_CAPABILITIES, context }, null, 2));
}

export async function cmdAgent(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "capabilities";
  if (sub === "install") {
    // parseArgs treats argv[0] as the command name, so prefix before parsing.
    const args = parseArgs(["install", ...argv.slice(1)]);
    // Validate the provider through whichever channel it arrived: the
    // explicit --provider flag or a positional argument. Without this,
    // `agent install bogus` silently falls through to the default provider.
    const SUPPORTED_PROVIDERS = new Set(["claude"]);
    const providerFromFlag = typeof args.flags.provider === "string" ? args.flags.provider : undefined;
    const providerFromPositional = args.positionals.find((p) => !p.startsWith("-"));
    const provider = providerFromFlag ?? providerFromPositional;
    if (provider !== undefined && !SUPPORTED_PROVIDERS.has(provider)) {
      throw new Error(`Only the Claude provider is currently supported (got: ${provider})`);
    }
    const result = installAgent({ force: args.flags.force === true, ...(typeof args.flags.target === "string" ? { configDir: resolve(args.flags.target) } : {}) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (sub === "-h" || sub === "--help" || sub === "help") {
    console.log("Usage: ok agent install|capabilities|context|call|start|abort\n\n  install [--target DIR] [--force]  Install the Claude agent and skill\n  capabilities              Print the supported local API groups\n  context [--json]          Snapshot active workspace context\n  call /api/path [flags]    Call a loopback OpenKan API route\n  start <task-id> [flags]   Start the configured agent for a task\n  abort <task-id> [flags]   Abort a running task agent\n");
    return;
  }
  if (sub === "capabilities") {
    console.log(JSON.stringify(AGENT_CAPABILITIES, null, 2));
    return;
  }
  if (sub === "context") return cmdAgentContext(argv.slice(1));
  if (sub === "call") return cmdApi(argv.slice(1));
  if (sub === "start") {
    const taskId = argv[1];
    if (!taskId) throw new Error("Usage: ok agent start <task-id> [--agent id] [--model id]");
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
    if (!taskId) throw new Error("Usage: ok agent abort <task-id>");
    return cmdApi([`/api/tasks/${encodeURIComponent(taskId)}/abort`, "--method", "POST", ...argv.slice(2)]);
  }
  throw new Error("Usage: ok agent install|capabilities|context|call|start|abort …");
}
