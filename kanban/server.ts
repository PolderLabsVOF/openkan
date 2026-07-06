import { readFileSync, existsSync } from "fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { join, extname } from "path";
import type { BoardContext } from "./board.ts";
import {
  type Task,
  type TaskStatus,
  withWrite,
  getBoard,
  renormalizeOrder,
  newId,
  nowIso,
  KANBAN_DIR,
} from "./board.ts";
import {
  boardToMarkdown,
  writeTaskMdx,
  writeBoardMdx,
  writeSessionMdx,
} from "./mdx.ts";

// ─── Renderer ─────────────────────────────────────────────────────────────────

const ALLOWED_TAGS = [
  "h1","h2","h3","h4","h5","h6","p","ul","ol","li",
  "code","pre","blockquote","a","strong","em","hr","br",
  "table","thead","tbody","tr","th","td",
];
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  code: ["class"],
};

function urlFilter(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:" ||
        u.protocol === "mailto:" || u.pathname.startsWith("/artifacts/")) return true;
    if (u.protocol === "data:") return url.startsWith("data:image/");
    return false;
  } catch {
    return !url.startsWith("javascript:") && !url.startsWith("data:");
  }
}

async function renderMarkdown(raw: string): Promise<string> {
  const { marked } = await import("marked");
  const html = await marked(raw);
  return html as string;
}

async function renderArtifact(markdownPath: string, rawFlag: boolean): Promise<{ body: string; contentType: string }> {
  if (!existsSync(markdownPath)) {
    throw new Error(`Artifact not found: ${markdownPath}`);
  }
  if (rawFlag) {
    return { body: readFileSync(markdownPath, "utf-8"), contentType: "text/markdown" };
  }
  const raw = readFileSync(markdownPath, "utf-8");
  const html = await renderMarkdown(raw);
  const sanitizeHtml = (await import("sanitize-html")).default;
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    filter(url) { return urlFilter(url); },
  });
  return {
    body: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Kanban Artifact</title>
<link rel="stylesheet" href="/style.css">
<style>
body { max-width: 860px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; }
pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; border-radius: 4px; }
code { background: #f4f4f4; padding: .15em .35em; border-radius: 3px; }
blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: .5rem; }
a { color: #2563eb; }
</style>
</head>
<body>${clean}</body>
</html>`,
    contentType: "text/html",
  };
}

// ─── Session status cache ──────────────────────────────────────────────────────

const sessionStatusCache = new Map<string, string>();

// ─── SSE broadcaster ──────────────────────────────────────────────────────────

const sseControllers = new Set<ReadableStreamDefaultController>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseControllers) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch (_) { /* client gone */ }
  }
}

// ─── Module-level server state ────────────────────────────────────────────────

export interface RunningServer {
  port: number;
  hostname: string;
  url: string;
  stop(): Promise<void>;
  broadcast(event: string, data: unknown): void;
}

let runningServer: RunningServer | null = null;

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`
  const method = req.method ?? "GET"
  const headers = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers })
  }

  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(req) as BodyInit,
    duplex: "half",
  })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status

  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (!response.body) {
    res.end()
    return
  }

  const body = Readable.fromWeb(response.body as globalThis.ReadableStream)
  await new Promise<void>((resolve, reject) => {
    body.on("error", reject)
    res.on("error", reject)
    res.on("finish", resolve)
    body.pipe(res)
  })
}

// ─── Static helpers ──────────────────────────────────────────────────────────

function serveStatic(root: string, urlPath: string): { body: Buffer; contentType: string } | null {
  const fileName = urlPath.replace(/^\//, "");
  const filePath = join(root, fileName);
  if (!filePath.startsWith(root)) return null;   // path traversal guard
  if (!existsSync(filePath)) return null;
  const ext = extname(fileName);
  const ctMap: Record<string, string> = {
    ".html": "text/html",
    ".css":  "text/css",
    ".js":   "application/javascript",
    ".json": "application/json",
    ".md":   "text/markdown",
  };
  return {
    body: readFileSync(filePath),
    contentType: ctMap[ext] ?? "application/octet-stream",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ─── API handlers ─────────────────────────────────────────────────────────────

async function apiGetBoard(): Promise<Response> {
  return jsonResponse(await getBoard());
}

async function apiCreateTask(_ctx: BoardContext, req: Request): Promise<Response> {
  interface CreateBody { title: string; description?: string; column?: string; agent?: string; model?: string; }
  let body: CreateBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.title?.trim()) return errorResponse("title is required", 422);

  const task: Task = {
    id: newId("tsk"),
    title: body.title.trim(),
    description: body.description ?? "",
    column: (body.column as Task["column"]) ?? "todo",
    order: 0,
    sessionId: null,
    agent: body.agent ?? "",
    model: body.model ?? null,
    status: "idle",
    lastError: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    artifact: "",
    sessionArtifact: null,
  };
  task.artifact = `tasks/${task.id}.mdx`;

  let created: Task | undefined;
  await withWrite(async (board) => {
    const colTasks = board.tasks.filter(t => t.column === task.column);
    task.order = colTasks.length;
    board.tasks.push(task);
    created = task;
  });

  await writeTaskMdx(created!, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.created", created!);
  return jsonResponse(created!, 201);
}

async function apiUpdateTask(_ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface PatchBody {
    title?: string; description?: string; column?: string;
    agent?: string; model?: string; status?: TaskStatus; order?: number;
  }
  let patch: PatchBody;
  try { patch = await req.json(); } catch { return errorResponse("Invalid JSON"); }

  let updated: Task | undefined;
  let columnChanged = false;
  await withWrite(async (board) => {
    const idx = board.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const task = board.tasks[idx];
    if (patch.column !== undefined && patch.column !== task.column) columnChanged = true;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.column !== undefined) task.column = patch.column;
    if (patch.agent !== undefined) task.agent = patch.agent;
    if (patch.model !== undefined) task.model = patch.model;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.order !== undefined) task.order = patch.order;
    task.updatedAt = nowIso();
    if (columnChanged) board.tasks = renormalizeOrder(board.tasks);
    updated = { ...task };
  });

  if (!updated) return errorResponse("Task not found", 404);
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updated);
  return jsonResponse(updated);
}

async function apiDeleteTask(_ctx: BoardContext, taskId: string): Promise<Response> {
  let removedId = "";
  await withWrite(async (board) => {
    const idx = board.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    removedId = board.tasks[idx].id;
    board.tasks.splice(idx, 1);
    board.tasks = renormalizeOrder(board.tasks);
  });
  if (!removedId) return errorResponse("Task not found", 404);
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.deleted", { id: taskId });
  return jsonResponse({ ok: true });
}

async function apiStartTask(ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface StartBody { agent?: string; model?: string; }
  let body: StartBody;
  try { body = await req.json(); } catch { body = {}; }

  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  if (task.sessionId) return errorResponse("Task already has an active session", 409);

  // Validate agent if client.app.agents is available
  const agent = body.agent ?? task.agent ?? "";
  if (agent && ctx.client?.app?.agents) {
    try {
      const list: any[] = await ctx.client.app.agents();
      const known = list.map((a: any) => typeof a === "string" ? a : a.name ?? "").filter(Boolean);
      if (known.length > 0 && !known.includes(agent)) {
        return errorResponse(`Unknown agent "${agent}". Available: ${known.join(", ")}`, 400);
      }
    } catch (_) { /* allow unknown if API not available */ }
  }

  // Create session
  const sessionOptions: Record<string, any> = { path: { id: `kanban-${taskId}` } };
  if (agent) sessionOptions.agent = agent;
  if (body.model) sessionOptions.model = body.model;

  let sessionId: string;
  try {
    const sess: any = await ctx.client.session.create(sessionOptions);
    sessionId = sess.id ?? sess.sessionId ?? String(sess);
  } catch (e: any) {
    return errorResponse(`session.create failed: ${e?.message ?? e}`, 500);
  }

  const startedAt = nowIso();

  // Link session → task BEFORE promptAsync so handleEvent can correlate
  await withWrite(async (b) => {
    const t = b.tasks.find(t => t.id === taskId);
    if (!t) return;
    t.sessionId = sessionId;
    t.agent = agent;
    if (body.model) t.model = body.model;
    t.status = "running";
    t.updatedAt = nowIso();
    b.sessions[sessionId] = { taskId, status: "running", startedAt, endedAt: null };
  });

  const updatedTask = (await getBoard()).tasks.find(t => t.id === taskId)!;

  // Prompt session (non-fatal if it fails)
  try {
    await ctx.client.session.promptAsync({
      path: { id: sessionId },
      body: { prompt: `${task.title}\n\n${task.description}`.trim() },
    });
  } catch (e: any) {
    ctx.log("warn", `promptAsync failed for ${sessionId}: ${e?.message ?? e}`);
  }

  await writeTaskMdx(updatedTask, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updatedTask);
  return jsonResponse(updatedTask);
}

async function apiAbortTask(ctx: BoardContext, taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  const sessionId = task.sessionId;
  if (!sessionId) return errorResponse("Task has no active session", 409);

  try {
    await ctx.client.session.abort({ path: { id: sessionId } });
  } catch (e: any) {
    ctx.log("warn", `session.abort failed for ${sessionId}: ${e?.message ?? e}`);
  }

  await withWrite(async (b) => {
    const t = b.tasks.find(t => t.id === taskId);
    if (!t) return;
    t.status = "cancelled";
    t.updatedAt = nowIso();
    const r = b.sessions[sessionId];
    if (r) { r.status = "cancelled"; r.endedAt = nowIso(); }
  });

  const updated = (await getBoard()).tasks.find(t => t.id === taskId)!;
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updated);
  return jsonResponse(updated);
}

async function apiSessionStatus(sessionId: string): Promise<Response> {
  return jsonResponse({ status: sessionStatusCache.get(sessionId) ?? "unknown" });
}

// ─── Event handler ─────────────────────────────────────────────────────────────

export async function handleEvent(ctx: BoardContext, event: any): Promise<void> {
  if (!event?.type) return;
  const sid: string = event.properties?.sessionID ?? event.properties?.sessionId ?? "";
  switch (event.type) {
    case "session.idle": {
      if (!sid) break;
      const board = await getBoard();
      const rec = board.sessions[sid];
      if (!rec) break;
      const task = board.tasks.find(t => t.id === rec.taskId);
      const endedAt = nowIso();
      await withWrite(async (b) => {
        const r = b.sessions[sid];
        if (!r) return;
        r.status = "done";
        r.endedAt = endedAt;
        const t = b.tasks.find(t => t.id === r.taskId);
        if (t) { t.status = "done"; t.updatedAt = nowIso(); }
      });
      const updated = (await getBoard()).tasks.find(t => t.id === rec.taskId);
      if (updated) {
        await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
        broadcast("task.updated", updated);
      }
      await writeSessionMdx(sid, (await getBoard()).sessions[sid], updated, KANBAN_DIR, ctx.client);
      await writeBoardMdx(await getBoard(), KANBAN_DIR);
      broadcast("session.ended", { sessionId: sid, status: "done" });
      break;
    }
    case "session.error": {
      if (!sid) break;
      const board = await getBoard();
      const rec = board.sessions[sid];
      if (!rec) break;
      const errMsg = event.properties?.error ?? event.properties?.message ?? "Unknown error";
      const endedAt = nowIso();
      await withWrite(async (b) => {
        const r = b.sessions[sid];
        if (!r) return;
        r.status = "failed";
        r.endedAt = endedAt;
        const t = b.tasks.find(t => t.id === r.taskId);
        if (t) { t.status = "failed"; t.lastError = errMsg; t.updatedAt = nowIso(); }
      });
      const updated = (await getBoard()).tasks.find(t => t.id === rec.taskId);
      if (updated) {
        await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
        broadcast("task.updated", updated);
      }
      await writeSessionMdx(sid, (await getBoard()).sessions[sid], updated, KANBAN_DIR, ctx.client);
      await writeBoardMdx(await getBoard(), KANBAN_DIR);
      broadcast("session.ended", { sessionId: sid, status: "failed", error: errMsg });
      break;
    }
    case "session.status": {
      if (sid) sessionStatusCache.set(sid, event.properties?.status ?? "unknown");
      break;
    }
    default:
      break;
  }
}

// ─── Server start ─────────────────────────────────────────────────────────────

export function getServer(): RunningServer | null {
  return runningServer;
}

export async function startServer(
  ctx: BoardContext,
  opts: {
    host?: string;
    port?: number;
    maxPortTries?: number;
    webRoot?: string;
  } = {},
): Promise<RunningServer> {
  if (runningServer) return runningServer;

  const host       = opts.host ?? "127.0.0.1";
  const basePort  = opts.port ?? 7777;
  const maxTries  = opts.maxPortTries ?? 10;
  const webRoot   = opts.webRoot ?? join(ctx.directory, "..", "..", "web");

  let port = basePort;
  let server: HttpServer | null = null;
  let lastErr: Error | null = null;

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const rawFlag = url.searchParams.get("raw") === "1";

    // ── SSE ──────────────────────────────────────────────────────────────
    if (path === "/api/events") {
      const stream = new ReadableStream({
        start(ctrl) {
          sseControllers.add(ctrl);
          ctrl.enqueue(new TextEncoder().encode("event: server.connected\ndata: {}\n\n"));
        },
        cancel(ctrl) { sseControllers.delete(ctrl); },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── Static ───────────────────────────────────────────────────────────
    if (path === "/" || path === "/index.html" || path === "/style.css" || path === "/app.js") {
      const sf = serveStatic(webRoot, path);
      if (sf) return new Response(sf.body, { headers: { "Content-Type": sf.contentType } });
      return errorResponse(`${path} not found`, 404);
    }

    // ── API: board ───────────────────────────────────────────────────────
    if (path === "/api/board" && req.method === "GET") return apiGetBoard();

    // ── API: create task ─────────────────────────────────────────────────
    if (path === "/api/tasks" && req.method === "POST") return apiCreateTask(ctx, req);

    // ── API: update / delete task ────────────────────────────────────────
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const [_, id] = taskMatch;
      if (req.method === "PATCH") return apiUpdateTask(ctx, id, req);
      if (req.method === "DELETE") return apiDeleteTask(ctx, id);
    }

    // ── API: start / abort task ──────────────────────────────────────────
    const actionMatch = path.match(/^\/api\/tasks\/([^/]+)\/(start|abort)$/);
    if (actionMatch) {
      const [_, id, action] = actionMatch;
      if (action === "start") return apiStartTask(ctx, id, req);
      if (action === "abort") return apiAbortTask(ctx, id);
    }

    // ── API: session status ─────────────────────────────────────────────
    const sessMatch = path.match(/^\/api\/sessions\/([^/]+)\/status$/);
    if (sessMatch) {
      const [_, sid] = sessMatch;
      if (req.method === "GET") return apiSessionStatus(sid);
    }

    // ── Artifacts ────────────────────────────────────────────────────────
    const cspHeaders = {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    };

    if (path === "/artifacts/board") {
      try {
        const { body, contentType } = await renderArtifact(join(KANBAN_DIR, "board.mdx"), rawFlag);
        return new Response(body, { headers: { "Content-Type": contentType, ...cspHeaders } });
      } catch (e: any) {
        return errorResponse(e?.message ?? "Render error", 500);
      }
    }

    const taskArtMatch = path.match(/^\/artifacts\/tasks\/([^/]+)$/);
    if (taskArtMatch) {
      const [_, id] = taskArtMatch;
      try {
        const { body, contentType } = await renderArtifact(join(KANBAN_DIR, "tasks", `${id}.mdx`), rawFlag);
        return new Response(body, { headers: { "Content-Type": contentType, ...cspHeaders } });
      } catch (e: any) {
        return errorResponse(e?.message ?? "Render error", 500);
      }
    }

    const sessArtMatch = path.match(/^\/artifacts\/sessions\/([^/]+)$/);
    if (sessArtMatch) {
      const [_, sid] = sessArtMatch;
      try {
        const { body, contentType } = await renderArtifact(join(KANBAN_DIR, "sessions", `${sid}.mdx`), rawFlag);
        return new Response(body, { headers: { "Content-Type": contentType, ...cspHeaders } });
      } catch (e: any) {
        return errorResponse(e?.message ?? "Render error", 500);
      }
    }

    return errorResponse("Not found", 404);
  };

  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const request = await toRequest(req)
          const response = await handleRequest(request)
          await writeResponse(res, response)
        } catch (e: any) {
          const response = errorResponse(e?.message ?? "Internal server error", 500)
          await writeResponse(res, response)
        }
      })

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error & { code?: string }) => {
          server?.off("listening", onListening)
          reject(err)
        }
        const onListening = () => {
          server?.off("error", onError)
          resolve()
        }

        server?.once("error", onError)
        server?.once("listening", onListening)
        server?.listen(port, host)
      })
      break; // success
    } catch (e: any) {
      if (e?.code === "EADDRINUSE" || String(e?.message).includes("EADDRINUSE")) {
        lastErr = e;
        server?.close()
        port++;
        continue;
      }
      throw e;
    }
  }

  if (!server) throw lastErr ?? new Error(`Could not bind server after ${maxTries} attempts`);

  runningServer = {
    port,
    hostname: host,
    url: `http://${host}:${port}`,
    broadcast,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()))
      })
      runningServer = null;
    },
  };

  ctx.log("info", `Kanban server started at ${runningServer.url}`);
  return runningServer;
}

// ─── Event subscription (called from plugin entrypoint) ───────────────────────

export async function subscribeEvents(ctx: BoardContext, signal: AbortSignal): Promise<void> {
  if (!ctx.client?.event?.subscribe) return;
  try {
    for await (const event of ctx.client.event.subscribe({ signal })) {
      await handleEvent(ctx, event);
    }
  } catch (e: any) {
    if (e?.name === "AbortError" || signal.aborted) return;
    ctx.log("error", `Event subscription error: ${e?.message ?? e}`);
  }
}
