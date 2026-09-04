import {
  existsSync,
  readFileSync,
} from "node:fs";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { resolve, join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";

export interface BizarConfig {
  enabled: boolean;
  projectRoot: string;
  command: string;
}

interface RawBizarConfig {
  enabled?: boolean;
  projectRoot?: string;
  command?: string;
}

export class BizarBridgeError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "BizarBridgeError";
    this.status = status;
    this.details = details;
  }
}

function loadOpenKanConfig(openkanProjectRoot: string): Record<string, unknown> {
  const path = join(openkanProjectRoot, ".ok", "openkan.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveConfiguredPath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export function resolveBizarConfig(openkanProjectRoot: string): BizarConfig {
  const root = resolve(openkanProjectRoot);
  const config = loadOpenKanConfig(root);
  const raw = (config.bizar && typeof config.bizar === "object"
    ? config.bizar
    : {}) as RawBizarConfig;
  const configuredRoot = process.env.OPENKAN_BIZAR_PROJECT_ROOT
    || raw.projectRoot
    || root;
  const projectRoot = resolveConfiguredPath(root, configuredRoot);
  const command = process.env.OPENKAN_BIZAR_COMMAND
    || raw.command
    || (existsSync(join(projectRoot, "cli", "bin.mjs"))
      ? join(projectRoot, "cli", "bin.mjs")
      : "bizar");
  return {
    enabled: raw.enabled !== false,
    projectRoot,
    command: isAbsolute(command) || command.includes("/")
      ? resolveConfiguredPath(root, command)
      : command,
  };
}

function executable(config: BizarConfig): { file: string; prefix: string[] } {
  if (config.command.endsWith(".mjs") || config.command.endsWith(".js")) {
    return { file: process.execPath, prefix: [config.command] };
  }
  return { file: config.command, prefix: [] };
}

function bizarJson(openkanProjectRoot: string, args: string[]): any {
  const config = resolveBizarConfig(openkanProjectRoot);
  if (!config.enabled) throw new BizarBridgeError("Bizar integration is disabled", 503);
  if (!existsSync(config.projectRoot)) {
    throw new BizarBridgeError(`Bizar project root does not exist: ${config.projectRoot}`, 503);
  }
  const command = executable(config);
  const result = spawnSync(command.file, [...command.prefix, ...args], {
    cwd: config.projectRoot,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, BIZAR_SKIP_BUILD: "1" },
    timeout: 30_000,
  });
  if (result.error) {
    throw new BizarBridgeError(`Bizar command failed: ${result.error.message}`, 502);
  }
  if (result.status !== 0) {
    let details: unknown = result.stderr?.trim() || result.stdout?.trim();
    try { details = JSON.parse(result.stderr || result.stdout); } catch { /* text details */ }
    const message = typeof details === "object" && details && "error" in details
      ? String((details as { error: unknown }).error)
      : `Bizar command exited ${result.status}`;
    throw new BizarBridgeError(message, 502, details);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    throw new BizarBridgeError("Bizar returned invalid JSON", 502, result.stdout);
  }
}

export function getBizarSnapshot(openkanProjectRoot: string): any {
  return bizarJson(openkanProjectRoot, ["control", "snapshot", "--json"]);
}

function requiredString(value: unknown, field: string, max = 16_384): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new BizarBridgeError(`${field} is required`, 422);
  if (Buffer.byteLength(text, "utf8") > max) {
    throw new BizarBridgeError(`${field} is too long`, 422);
  }
  return text;
}

function optionalString(value: unknown, field: string, max = 16_384): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, max);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BizarBridgeError(`${field} must be an array`, 422);
  return value.map((item) => requiredString(item, field, 512));
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new BizarBridgeError("Invalid JSON body", 400);
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  const bridge = error instanceof BizarBridgeError
    ? error
    : new BizarBridgeError((error as Error)?.message || String(error));
  return response({
    error: bridge.message,
    ...(bridge.details ? { details: bridge.details } : {}),
  }, bridge.status);
}

function taskCommand(action: string, id: string, payload: Record<string, unknown>): string[] {
  const args = ["task", action, requiredString(id, "task id", 128)];
  if (action === "create") {
    args.push("--title", requiredString(payload.title, "title", 512));
    for (const scope of stringArray(payload.scopes, "scopes")) args.push("--scope", scope);
    for (const dependency of stringArray(payload.dependencies, "dependencies")) {
      args.push("--depends-on", dependency);
    }
    if (payload.priority !== undefined) args.push("--priority", String(payload.priority));
  } else if (action === "claim") {
    args.push("--owner", requiredString(payload.owner, "owner", 128));
    const workspace = optionalString(payload.workspace, "workspace", 4096);
    if (workspace) args.push("--workspace", workspace);
    if (payload.leaseMs !== undefined) args.push("--lease-ms", String(payload.leaseMs));
  } else if (action === "heartbeat") {
    args.push("--owner", requiredString(payload.owner, "owner", 128));
    if (payload.leaseMs !== undefined) args.push("--lease-ms", String(payload.leaseMs));
  } else if (action === "complete") {
    args.push("--owner", requiredString(payload.owner, "owner", 128));
    const evidence = optionalString(payload.evidence, "evidence");
    if (evidence) args.push("--evidence", evidence);
  } else if (action === "cancel") {
    const owner = optionalString(payload.owner, "owner", 128);
    const reason = optionalString(payload.reason, "reason");
    if (owner) args.push("--owner", owner);
    if (reason) args.push("--reason", reason);
  }
  args.push("--json");
  return args;
}

export function executeBizarCommand(
  openkanProjectRoot: string,
  command: string,
  payload: Record<string, unknown>,
): any {
  switch (command) {
    case "create-task":
      return bizarJson(openkanProjectRoot, taskCommand("create", requiredString(payload.id, "id", 128), payload));
    case "claim-task":
    case "heartbeat-task":
    case "complete-task":
    case "cancel-task": {
      const action = command.replace("-task", "");
      return bizarJson(openkanProjectRoot, taskCommand(action, requiredString(payload.id, "id", 128), payload));
    }
    case "start-session": {
      const args = [
        "control", "session", "start",
        "--agent", requiredString(payload.agent, "agent", 128),
        "--prompt", requiredString(payload.prompt, "prompt"),
      ];
      const name = optionalString(payload.name, "name", 256);
      if (name) args.push("--name", name);
      args.push("--json");
      return bizarJson(openkanProjectRoot, args);
    }
    case "send-session": {
      const args = [
        "control", "session", "send",
        requiredString(payload.sessionId, "sessionId", 128),
        "--text", requiredString(payload.text, "text"),
      ];
      const from = optionalString(payload.from, "from", 128);
      const taskId = optionalString(payload.taskId, "taskId", 128);
      if (from) args.push("--from", from);
      if (taskId) args.push("--task", taskId);
      args.push("--json");
      return bizarJson(openkanProjectRoot, args);
    }
    case "stop-session":
      return bizarJson(openkanProjectRoot, [
        "control", "session", "stop",
        requiredString(payload.sessionId, "sessionId", 128),
        "--json",
      ]);
    case "send-message": {
      const args = ["control", "message"];
      const agent = optionalString(payload.agent, "agent", 128);
      const sessionId = optionalString(payload.sessionId, "sessionId", 128);
      if (!agent && !sessionId) throw new BizarBridgeError("agent or sessionId is required", 422);
      if (agent) args.push("--agent", agent);
      if (sessionId) args.push("--session", sessionId);
      args.push("--text", requiredString(payload.text, "text"));
      const from = optionalString(payload.from, "from", 128);
      const taskId = optionalString(payload.taskId, "taskId", 128);
      if (from) args.push("--from", from);
      if (taskId) args.push("--task", taskId);
      args.push("--json");
      return bizarJson(openkanProjectRoot, args);
    }
    default:
      throw new BizarBridgeError(`Unknown Bizar command: ${command}`, 404);
  }
}

export async function handleBizarRequest(
  openkanProjectRoot: string,
  req: Request,
  path: string,
): Promise<Response> {
  try {
    if (req.method === "GET") {
      const snapshot = getBizarSnapshot(openkanProjectRoot);
      if (path === "/api/bizar/snapshot") return response(snapshot);
      if (path === "/api/bizar/agents") return response({ agents: snapshot.agents || [] });
      if (path === "/api/bizar/tasks") return response({ tasks: snapshot.tasks || [] });
      if (path === "/api/bizar/sessions") return response({ sessions: snapshot.sessions || [] });
      if (path === "/api/bizar/messages") return response({ messages: snapshot.messages || [] });
    }
    if (req.method === "POST" && path === "/api/bizar/tasks") {
      return response(executeBizarCommand(openkanProjectRoot, "create-task", await body(req)));
    }
    const task = path.match(/^\/api\/bizar\/tasks\/([^/]+)\/(claim|heartbeat|complete|cancel)$/);
    if (req.method === "POST" && task) {
      return response(executeBizarCommand(openkanProjectRoot, `${task[2]}-task`, {
        ...(await body(req)),
        id: decodeURIComponent(task[1]),
      }));
    }
    if (req.method === "POST" && path === "/api/bizar/sessions") {
      return response(executeBizarCommand(openkanProjectRoot, "start-session", await body(req)));
    }
    const session = path.match(/^\/api\/bizar\/sessions\/([^/]+)\/(messages|stop)$/);
    if (req.method === "POST" && session) {
      const payload = session[2] === "stop" ? {} : await body(req);
      return response(executeBizarCommand(
        openkanProjectRoot,
        session[2] === "stop" ? "stop-session" : "send-session",
        { ...payload, sessionId: decodeURIComponent(session[1]) },
      ));
    }
    if (req.method === "POST" && path === "/api/bizar/messages") {
      return response(executeBizarCommand(openkanProjectRoot, "send-message", await body(req)));
    }
    return response({ error: "Not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function attachBizarWebSocket(
  server: HttpServer,
  projectRoot: () => string,
): { close(): void; broadcastSnapshot(): void } {
  const wss = new WebSocketServer({ noServer: true });

  function send(socket: WebSocket, value: unknown) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }

  function snapshot(socket?: WebSocket) {
    try {
      const event = { type: "snapshot", data: getBizarSnapshot(projectRoot()) };
      if (socket) send(socket, event);
      else for (const client of wss.clients) send(client, event);
    } catch (error) {
      const event = {
        type: "error",
        error: (error as Error)?.message || String(error),
      };
      if (socket) send(socket, event);
      else for (const client of wss.clients) send(client, event);
    }
  }

  const upgrade = (req: IncomingMessage, socket: any, head: Buffer) => {
    let pathname = "";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { /* invalid */ }
    if (pathname !== "/api/bizar/ws") return;
    if (!isLoopback(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  };
  server.on("upgrade", upgrade);

  wss.on("connection", (socket) => {
    snapshot(socket);
    socket.on("message", (raw) => {
      let message: any;
      try { message = JSON.parse(raw.toString()); }
      catch {
        send(socket, { type: "error", error: "Invalid JSON" });
        return;
      }
      if (message.type === "refresh") {
        snapshot(socket);
        return;
      }
      if (message.type !== "command") {
        send(socket, { type: "error", requestId: message.requestId, error: "Unknown message type" });
        return;
      }
      try {
        const result = executeBizarCommand(
          projectRoot(),
          requiredString(message.command, "command", 128),
          message.payload && typeof message.payload === "object" ? message.payload : {},
        );
        send(socket, { type: "result", requestId: message.requestId, data: result });
        snapshot();
      } catch (error) {
        send(socket, {
          type: "error",
          requestId: message.requestId,
          error: (error as Error)?.message || String(error),
        });
      }
    });
  });

  const interval = setInterval(() => {
    if (wss.clients.size > 0) snapshot();
  }, 5_000);
  interval.unref?.();

  return {
    broadcastSnapshot: () => snapshot(),
    close() {
      clearInterval(interval);
      server.off("upgrade", upgrade);
      for (const client of wss.clients) client.close();
      wss.close();
    },
  };
}

