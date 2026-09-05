import {
  existsSync,
  readFileSync,
} from "node:fs";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { readSnapshot as readClaudeSnapshot, type SnapshotPayload } from "./claude-state.ts";

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

/**
 * Legacy snapshot endpoint. The Bizar CLI bridge has been removed; the
 * legacy `/api/bizar/*` URL namespace now sources its data directly from the
 * native Claude Code readers in `claude-state.ts`. New integrations should
 * prefer `/api/claude/*`.
 */
export async function getBizarSnapshot(openkanProjectRoot: string): Promise<any> {
  const snapshot: SnapshotPayload = await readClaudeSnapshot(openkanProjectRoot);
  return {
    version: 1,
    projectRoot: openkanProjectRoot,
    agents: snapshot.agents ?? [],
    tasks: [],
    sessions: [],
    messages: [],
  };
}

/**
 * Legacy session/message/task command shim. With the Bizar CLI removed, this
 * no longer spawns external processes. Callers receive back a local session
 * identifier that the UI can display alongside the task; nothing actually
 * runs off-host. Mutations (claim/heartbeat/complete/cancel) return
 * `{deprecated:true, status:410}` so existing clients can detect the change.
 * For new integrations use `/api/claude/*` POST handlers and the
 * `/api/claude/events` SSE stream.
 */
export function executeBizarCommand(
  _openkanProjectRoot: string,
  command: string,
  payload: Record<string, unknown>,
): any {
  if (command === "start-session") {
    const sessionId = `ses-local-${randomUUID()}`;
    return { session: { sessionId }, deprecated: true, successor: "/api/claude/*" };
  }
  if (command === "stop-session" || command === "send-session" || command === "send-message") {
    return { ok: true, deprecated: true, successor: "/api/claude/*" };
  }
  if (
    command === "create-task" ||
    command === "claim-task" ||
    command === "heartbeat-task" ||
    command === "complete-task" ||
    command === "cancel-task"
  ) {
    return { ok: true, deprecated: true, status: 410, successor: "/api/claude/*" };
  }
  throw new BizarBridgeError(`Unknown Bizar command: ${command}`, 404);
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

function gone(message: string): Response {
  return response({
    error: message,
    deprecated: true,
    successor: "/api/claude/*",
  }, 410);
}

const GONE = "Bizar CLI integration removed; use /api/claude/*";

export async function handleBizarRequest(
  openkanProjectRoot: string,
  req: Request,
  path: string,
): Promise<Response> {
  try {
    if (req.method === "GET") {
      const snapshot = await getBizarSnapshot(openkanProjectRoot);
      if (path === "/api/bizar/snapshot") return response(snapshot);
      if (path === "/api/bizar/agents") return response({ agents: snapshot.agents || [] });
      if (path === "/api/bizar/tasks") return response({ tasks: snapshot.tasks || [] });
      if (path === "/api/bizar/sessions") return response({ sessions: snapshot.sessions || [] });
      if (path === "/api/bizar/messages") return response({ messages: snapshot.messages || [] });
    }
    if (req.method !== "POST") return response({ error: "Not found" }, 404);
    return gone(GONE);
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

  async function snapshot(socket?: WebSocket) {
    try {
      const event = { type: "snapshot", data: await getBizarSnapshot(projectRoot()) };
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
        // The legacy WS command channel has been superseded by the native
        // /api/claude/events SSE stream and the /api/claude/* POST endpoints.
        // Acknowledging receipt with a 410-styled result keeps existing clients
        // log-parsable while signalling that no work will be performed.
        send(socket, {
          type: "result",
          requestId: message.requestId,
          data: { deprecated: true, status: 410, error: GONE, successor: "/api/claude/*" },
        });
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

