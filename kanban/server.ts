// OpenKan — HTTP API server.

import { readFileSync, existsSync, statSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { join, extname, resolve } from "path";
import { constants as fs_constants, openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { BoardContext } from "./board.ts";
import {
  type Task,
  type ColumnId,
  type TaskStatus,
  type TaskState,
  type TaskArtifacts,
  withWrite,
  getBoard,
  renormalizeOrder,
  newId,
  nowIso,
  KANBAN_DIR,
  taskArtifacts,
  ensureBoardForProject,
} from "./board.ts";
import { extractMetadata } from "./tags.ts";
import {
  boardToMarkdown,
  writeTaskMdx,
  writeBoardMdx,
  writeSessionMdx,
  extractDescription,
  statMdxMtime,
} from "./mdx.ts";
import { listInputs, getPendingInput, addInput, respondInput, type Input } from "./inputs.ts";
import { listComments, addComment, deleteComment, resolveComment, type Comment } from "./comments.ts";
import { renderMdx, stripMdxFrontmatter } from "./mdx-render.ts";
import { buildPreview } from "./tsx-sandbox.ts";
import { writeFileAtomic, ensureDir, removeDir } from "./io.ts";
import { recordEvent, readEvents, readSummary, type ChangelogKind } from "./changelog.ts";
import { computeVelocity } from "./insights.ts";
import { listContributors, attributeCommitsToTasks, isGitRepo, type GitCommit } from "./git.ts";
import { archiveTask, restoreTask } from "./archive.ts";
import {
  listProjects,
  activeProject,
  setActiveProject,
  addProject,
  removeProject,
  getActiveProjectRoot,
  autoDetectProjects,
  type ProjectEntry,
  type AutoDetectScanResult,
} from "./projects.ts";
import { listDocs, readDoc } from "./docs.ts";
import { saveImage, listImages, deleteImage, readImage, type ImageMeta } from "./images.ts";
import type { Priority, Effort, Category } from "./tags.ts";
import { search, type SearchOptions } from "./search.ts";
import { applyBulk, type BulkOperation } from "./bulk.ts";
import { TASK_MDX_TEMPLATE, TEMPLATE_PARSE_HINTS } from "./template.ts";
import { watch, type WatchEvent, sourcePathOfTask } from "./watcher.ts";
import { listFs, readHome, parents, isDenyListed, realPathIfAllowed } from "./fs.ts";
import {
  attachBizarWebSocket,
  executeBizarCommand,
  getBizarSnapshot,
  handleBizarRequest,
} from "./bizar.ts";
import * as claudeState from "./claude-state.ts";
import { handleClaudeRequest } from "./claude-state.ts";
import {
  validateAgentsConfig,
  DEFAULT_AGENTS_CONFIG,
} from "../ok/schemas.ts";
import { handleChatRequest, sendTurn } from "./chat.ts";
import { initIfMissing as initOkIfMissing, listPrds as listOkPrds, readPrd as readOkPrd, writePrd as writeOkPrd, rebuildIndex as rebuildOkIndex } from "../ok/storage.ts";
import type { PrdGoal } from "../ok/schemas.ts";
import { WebSocketServer, WebSocket } from "ws";
import { runImport } from "./import.ts";

// ─── Module-level server state ────────────────────────────────────────────────

let watcherHandle: ReturnType<typeof watch> | null = null;
/** Timestamp up to which filesystem-change events should be suppressed (self-write guard). */
let selfWriteUntil = 0;

// ─── Self-write guard ─────────────────────────────────────────────────────────

/**
 * Wrap a server-initiated write so the file-watcher ignores the resulting
 * fs-watch events. The suppression window is 250 ms which covers the
 * synchronous fs.watch delivery on Linux/macOS and any microtask deferral.
 */
async function suppressSelfWrite<T>(fn: () => Promise<T>): Promise<T> {
  selfWriteUntil = Date.now() + 250;
  try { return await fn(); }
  finally { /* keep flag active for 250 ms to flush queued watch events */ }
}

export interface RunningServer {
  port: number;
  hostname: string;
  url: string;
  pid: number;
  isPrimary: boolean;
  stop(): Promise<void>;
  broadcast(event: string, data: unknown): void;
}

let runningServer: RunningServer | null = null;
let webRoot: string | null = null;
let bizarSocketBridge: { close(): void; broadcastSnapshot(): void } | null = null;
let claudeSocketBridge: { close(): void } | null = null;

/**
 * Read the current git user from local config (same logic as git.ts currentUser
 * but inlined here so server.ts stays self-contained; kanban/git.ts is the
 * canonical source of truth).
 */
function currentGitUser(cwd: string): { name: string; email: string } | null {
  try {
    // Without `--local` / `--global` flags, `git config` reads the merged
    // config: local repo wins, then global, then system. This way users with
    // only a global `user.name` (very common on dev machines) are picked up
    // too, instead of falling through to the literal "user" placeholder.
    const name = spawnSync("git", ["config", "user.name"], { cwd, encoding: "utf-8" }).stdout?.trim();
    const email = spawnSync("git", ["config", "user.email"], { cwd, encoding: "utf-8" }).stdout?.trim();
    if (!name) return null;
    return { name, email: email ?? "" };
  } catch { return null; }
}

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
  const html = await marked(stripMdxFrontmatter(raw));
  return html as string;
}

async function renderArtifact(markdownPath: string, rawFlag: boolean, theme?: string): Promise<{ body: string; contentType: string }> {
  if (!existsSync(markdownPath)) throw new Error(`Artifact not found: ${markdownPath}`);
  try { if (!statSync(markdownPath).isFile()) throw new Error("not a file"); } catch (e) {
    throw new Error(`Artifact unavailable: ${markdownPath} (${(e as Error).message})`); }
  if (rawFlag) return { body: readFileSync(markdownPath, "utf-8"), contentType: "text/markdown" };
  const raw = readFileSync(markdownPath, "utf-8");
  const html = await renderMarkdown(raw);
  const sanitizeHtml = (await import("sanitize-html")).default;
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
  });
  return {
    body: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Kanban Artifact</title>
<script>
// Read parent window theme (same origin only: same 127.0.0.1:7777)
var theme = "${theme ?? ""}";
if (!theme && window.parent && window.parent.location) {
  try {
    var stored = window.parent.localStorage.getItem("openkan:theme");
    if (stored) theme = stored;
  } catch(e) { /* cross-origin, ignore */ }
}
if (!theme) theme = "system";
if (theme === "system") {
  theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
document.documentElement.dataset.theme = theme;
</script>
<style>
:root[data-theme="light"] {
  --text: #111;
  --text-dim: #555;
  --bg: #fff;
  --accent: #2563eb;
  --rule: #e5e5e5;
  --code-bg: #f4f4f4;
  --row-alt: #f9fafb;
}
:root[data-theme="dark"] {
  --text: #e5e5e5;
  --text-dim: #9ca3af;
  --bg: #111827;
  --accent: #60a5fa;
  --rule: #374151;
  --code-bg: #1f2937;
  --row-alt: #1f2937;
}
body {
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  padding: 2rem;
  max-width: 860px;
  margin: 0 auto;
  line-height: 1.6;
  overflow-y: auto;
  min-height: 100vh;
  color: var(--text);
  background: var(--bg);
}
body > :first-child { margin-top: 0; }
body h1, body h2, body h3, body h4, body h5, body h6 {
  font-weight: 600;
  line-height: 1.25;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}
body h1 { font-size: 1.875rem; border-bottom: 1px solid var(--rule); padding-bottom: 0.3em; }
body h2 { font-size: 1.5rem; border-bottom: 1px solid var(--rule); padding-bottom: 0.3em; }
body p { margin: 0 0 1em; }
body a { color: var(--accent); text-decoration: none; }
body a:hover { text-decoration: underline; }
body code { background: var(--code-bg); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
body pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; line-height: 1.5; }
body pre code { padding: 0; background: transparent; }
body blockquote { border-left: 3px solid var(--accent); padding: 0.2em 1em; color: var(--text-dim); font-style: italic; margin: 0 0 1em; }
body ul, body ol { padding-left: 1.5em; margin: 0 0 1em; }
body table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
body th, body td { border: 1px solid var(--rule); padding: 0.5em 0.75em; text-align: left; }
body tr:nth-child(odd) { background: var(--row-alt); }
body img { max-width: 100%; border-radius: 8px; border: 1px solid var(--rule); }
.back-link { display: inline-block; margin-bottom: 1.5rem; font-size: 0.875rem; }
</style>
</head>
<body>
<a href="/" class="back-link">← Back to board</a>
${clean}
</body>
</html>`,
    contentType: "text/html",
  };
}

// ─── Session status cache ────────────────────────────────────────────────────

const sessionStatusCache = new Map<string, string>();

// ─── SSE broadcaster ─────────────────────────────────────────────────────────

const sseControllers = new Set<ReadableStreamDefaultController>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseControllers) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch (_) { /* client gone */ }
  }
}

// ─── Drift detection ───────────────────────────────────────────────────────────

/**
 * Returns true if the source file for `task` has changed since import.
 * A missing file is considered stale.
 */
async function checkSourceDrift(task: Task, kanbanDir: string): Promise<boolean> {
  if (!task.source) return false;
  const absPath = join(kanbanDir, "..", task.source.path);
  if (!existsSync(absPath)) return true; // file gone = stale
  let content: string;
  try { content = readFileSync(absPath, "utf-8"); } catch { return false; }
  const newHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return newHash !== task.sourceHash;
}

/**
 * Re-check stale status for all tasks that have a source file.
 * Updates the board and broadcasts task.updated events for any changed tasks.
 * Debounced via the `sweepLock` promise chain.
 */
let _sweepLock = Promise.resolve();
async function sweepSourceDrift(kanbanDir: string): Promise<void> {
  _sweepLock = _sweepLock.then(async () => {
    const board = await getBoard();
    const updates: Task[] = [];
    for (const task of board.tasks) {
      if (!task.source) continue;
      const isStale = await checkSourceDrift(task, kanbanDir);
      if (isStale !== task.stale) {
        task.stale = isStale;
        task.lastSourceCheck = nowIso();
        updates.push(task);
      }
    }
    if (updates.length > 0) {
      await withWrite(async (b) => {
        for (const updated of updates) {
          const t = b.tasks.find(t => t.id === updated.id);
          if (t) { t.stale = updated.stale; t.lastSourceCheck = updated.lastSourceCheck; }
        }
      });
      for (const updated of updates) {
        broadcast("task.updated", updated);
        await writeTaskMdx(updated, kanbanDir, await getBoard());
      }
    }
  });
  await _sweepLock;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) { for (const item of value) headers.append(key, item); }
    else if (value !== undefined) headers.set(key, value);
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const init = {
    method,
    headers,
    body: Readable.toWeb(req) as BodyInit,
    duplex: "half",
  } as RequestInit;
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => { res.setHeader(key, value); });
  if (!response.body) { res.end(); return; }
  const body = Readable.fromWeb(response.body as any);
  await new Promise<void>((resolve, reject) => {
    body.on("error", reject); res.on("error", reject); res.on("finish", resolve);
    body.pipe(res);
  });
}

function serveStatic(root: string, urlPath: string): { body: Buffer; contentType: string } | null {
  const fileName = urlPath.replace(/^\//, "");
  const filePath = join(root, fileName);
  if (filePath !== root && !filePath.startsWith(root + "/")) return null;
  if (!existsSync(filePath)) return null;
  let st;
  try { st = statSync(filePath); } catch { return null; }
  if (!st.isFile()) return null;
  const ext = extname(fileName);
  const ctMap: Record<string, string> = {
    ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".md": "text/markdown",
    ".svg": "image/svg+xml",
  };
  return { body: readFileSync(filePath), contentType: ctMap[ext] ?? "application/octet-stream" };
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

/** A self-contained browser error page; API clients continue to receive JSON. */
export function browserErrorPage(status: 404 | 500, pathname = "/"): Response {
  const notFound = status === 404;
  const title = notFound ? "Page not found" : "Workspace error";
  const eyebrow = notFound ? "Route unavailable" : "Something went wrong";
  const message = notFound
    ? "This workspace page does not exist, or it may have moved."
    : "OpenKan could not complete this page request. Your project files are still safe.";
  const route = escapeHtml(pathname || "/");

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${status} — ${title} · OpenKan</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; overflow: hidden; color: #e8edf7; background: #090d14; }
    body::before, body::after { content: ""; position: fixed; width: 48rem; height: 48rem; border-radius: 50%; pointer-events: none; filter: blur(20px); opacity: .18; }
    body::before { top: -32rem; left: -26rem; background: #6c63ff; }
    body::after { right: -30rem; bottom: -35rem; background: #2fba91; }
    main { position: relative; width: min(42rem, calc(100vw - 2rem)); padding: clamp(1.5rem, 6vw, 4rem); border: 1px solid #263247; border-radius: 1.5rem; background: rgba(16, 23, 35, .9); box-shadow: 0 1.5rem 5rem rgba(0, 0, 0, .38); }
    .brand { display: flex; align-items: center; gap: .65rem; color: #b9c4d7; font-size: .85rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .mark { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: .55rem; color: #fff; background: linear-gradient(135deg, #766dff, #4850db); font-size: 1.1rem; font-weight: 800; letter-spacing: 0; text-transform: none; box-shadow: 0 .35rem 1.25rem rgba(105, 96, 255, .3); }
    .code { margin: clamp(2.5rem, 7vw, 4.5rem) 0 .6rem; color: #f1f4fb; font-size: clamp(4.75rem, 18vw, 8.5rem); font-weight: 800; letter-spacing: -.09em; line-height: .82; }
    .eyebrow { margin: 0 0 .7rem; color: #8f87ff; font-size: .76rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    h1 { max-width: 28rem; margin: 0; font-size: clamp(1.65rem, 4vw, 2.35rem); letter-spacing: -.045em; line-height: 1.05; }
    p { max-width: 32rem; margin: 1rem 0 0; color: #aeb9cb; font-size: 1rem; line-height: 1.65; }
    code { padding: .16rem .38rem; border: 1px solid #2c3850; border-radius: .36rem; color: #d4dbeb; background: #111a29; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: .7rem; margin-top: 2rem; }
    a { display: inline-flex; align-items: center; justify-content: center; min-height: 2.7rem; padding: .65rem 1rem; border: 1px solid #34435e; border-radius: .7rem; color: #d7e0ef; background: #172236; font-weight: 700; text-decoration: none; transition: transform .16s ease, border-color .16s ease, background .16s ease; }
    a:hover { transform: translateY(-1px); border-color: #837cff; background: #202e48; }
    a.primary { border-color: transparent; color: #fff; background: #665cf6; box-shadow: 0 .55rem 1.4rem rgba(94, 83, 237, .28); }
    a.primary:hover { background: #756cff; }
    a:focus-visible { outline: 3px solid #a39cff; outline-offset: 3px; }
    .route { margin-top: 2.1rem; color: #728099; font-size: .8rem; }
    @media (max-width: 34rem) { main { border-radius: 1.1rem; } .actions { display: grid; } a { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark" aria-hidden="true">K</span> OpenKan</div>
    <div class="code" aria-label="Error ${status}">${status}</div>
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="actions"><a class="primary" href="/">Open workspace</a></div>
    <p class="route">Requested route: <code>${route}</code></p>
  </main>
</body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isBrowserNavigation(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return req.headers.get("accept")?.includes("text/html") ?? false;
}

export function requestErrorResponse(req: Request, status: 404 | 500, message: string): Response {
  if (isBrowserNavigation(req) && !new URL(req.url).pathname.startsWith("/api/")) {
    return browserErrorPage(status, new URL(req.url).pathname);
  }
  return errorResponse(message, status);
}

// ─── Tasks index ───────────────────────────────────────────────────────────────

// TaskIndexEntry and taskToIndexEntry are defined in the new handlers section below

// ─── API handlers ─────────────────────────────────────────────────────────────

async function apiGetBoard(): Promise<Response> {
  return jsonResponse(await getBoard());
}

// ─── Goals (PRDs stored in the canonical .ok/ planning workspace) ──────────

async function apiGetGoals(projectRoot: string): Promise<Response> {
  const paths = await initOkIfMissing(projectRoot);
  const prds = await listOkPrds(paths);
  prds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return jsonResponse({ prds });
}

async function apiPatchGoal(projectRoot: string, prdId: string, goalId: string, req: Request): Promise<Response> {
  let body: { status?: unknown };
  try { body = await req.json() as { status?: unknown }; }
  catch { return errorResponse("invalid JSON body"); }
  const statuses: PrdGoal["status"][] = ["open", "in_progress", "met", "dropped"];
  if (!statuses.includes(body.status as PrdGoal["status"])) {
    return errorResponse("status must be open, in_progress, met, or dropped");
  }
  const paths = await initOkIfMissing(projectRoot);
  const prd = await readOkPrd(paths, prdId);
  if (!prd) return errorResponse("PRD not found", 404);
  const goal = prd.goals.find((item) => item.id === goalId);
  if (!goal) return errorResponse("goal not found", 404);
  goal.status = body.status as PrdGoal["status"];
  prd.updatedAt = new Date().toISOString();
  await writeOkPrd(paths, prd);
  await rebuildOkIndex(paths);
  return jsonResponse({ prd });
}

// ─── Search endpoint ─────────────────────────────────────────────────────────

async function apiSearch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get("q") ?? undefined;
  const column = url.searchParams.get("column") ?? undefined;
  const tags = url.searchParams.getAll("tags");
  const assignee = url.searchParams.get("assignee") ?? undefined;
  const priority = url.searchParams.get("priority") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const opts: SearchOptions = {
    kanbanDir: KANBAN_DIR,
    query,
    column: column || undefined,
    tags: tags.length > 0 ? tags : undefined,
    assignee,
    priority: (priority as SearchOptions["priority"]) ?? undefined,
    category: (category as SearchOptions["category"]) ?? undefined,
    archived: includeArchived,
    limit,
    offset,
  };

  const result = await search(opts);
  return jsonResponse(result);
}

// ─── Bulk operations endpoint ───────────────────────────────────────────────

async function apiBulk(_ctx: BoardContext, req: Request): Promise<Response> {
  interface BulkBody { operation: BulkOperation; }
  let body: BulkBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.operation) return errorResponse("operation is required", 422);

  const board = await getBoard();
  selfWriteUntil = Date.now() + 250;
  const result = await applyBulk(board, body.operation);
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("board.updated", {});
  return jsonResponse(result);
}

// ─── Template endpoint ──────────────────────────────────────────────────────

async function apiGetTemplate(): Promise<Response> {
  return jsonResponse({ template: TASK_MDX_TEMPLATE, parseHints: TEMPLATE_PARSE_HINTS });
}

export async function apiCreateTask(_ctx: BoardContext, req: Request): Promise<Response> {
  interface CreateBody {
    title: string; description?: string; column?: string;
    agent?: string; model?: string;
    tags?: string[]; category?: Category;
    assignee?: string; // explicit assignee; if omitted, auto-assign to current git user
    parentId?: string; // if provided, create as a subtask
  }
  let body: CreateBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.title?.trim()) return errorResponse("title is required", 422);

  // Validate parentId if provided
  if (body.parentId !== undefined) {
    const board = await getBoard();
    const parent = board.tasks.find(t => t.id === body.parentId);
    if (!parent) return errorResponse("Parent task not found", 404);
    // No transitive nesting in v1
    if (parent.parentId !== null) return errorResponse("Cannot nest a subtask under another subtask (v1)", 422);
  }

  const id = newId("tsk");
  const arts = taskArtifacts(id);
  const now = nowIso();

  // Derive metadata from title + description
  const derived = extractMetadata({ title: body.title, description: body.description ?? "" });

  // Merge: explicit tags/category from body override derived values
  const tags = (body.tags && body.tags.length > 0)
    ? [...new Set([...derived.tags, ...body.tags])]
    : derived.tags;
  const category = body.category ?? derived.category;

  // Auto-assign: use body.assignee if provided, otherwise current git user, else "user"
  // (Agent-created tasks via kanban_add tool also flow through here; the tool calls
  // POST /api/tasks with a body that may include assignee, which gets processed below.)
  const projectRoot = join(KANBAN_DIR, "..");
  const gitUser = currentGitUser(projectRoot);
  const assigneeName = (body.assignee ?? gitUser?.name ?? "user") as string;

  const task: Task = {
    id,
    title: body.title.trim(),
    description: body.description ?? "",
    column: (body.column as Task["column"]) ?? "todo",
    order: 0,
    sessionId: null,
    agent: body.agent ?? "",
    model: body.model ?? null,
    status: "idle",
    state: "idle",
    lastError: null,
    createdAt: now,
    updatedAt: now,
    artifact: arts.mdxPath,
    sessionArtifact: null,
    pendingInputs: [],
    artifacts: arts,
    tags,
    category,
    priority: derived.priority,
    effort: derived.effort,
    archived: false,
    assignees: [assigneeName],
    images: [],
    parentId: body.parentId ?? null,
    subtaskIds: [],
  };

  let created: Task | undefined;
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (board) => {
    const colTasks = board.tasks.filter(t => t.column === task.column);
    task.order = colTasks.length;
    board.tasks.push(task);
    // Add child id to parent's subtaskIds
    if (task.parentId) {
      const parent = board.tasks.find(t => t.id === task.parentId);
      if (parent) {
        parent.subtaskIds = [...new Set([...parent.subtaskIds, task.id])];
      }
    }
    created = task;
  });

  // Create per-task directory
  const taskDir = join(KANBAN_DIR, "tasks", id);
  ensureDir(taskDir);
  await writeTaskMdx(created!, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.created", created!);
  recordEvent(KANBAN_DIR, "task.created", {
    taskId: id,
    author: "user",
    summary: `created '${created!.title}'`,
    payload: { column: created!.column, parentId: created!.parentId },
  });
  return jsonResponse(created!, 201);
}

export async function apiUpdateTask(_ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface PatchBody {
    title?: string; description?: string; column?: string;
    agent?: string; model?: string; state?: TaskState; order?: number;
    tags?: string[]; category?: Category;
    archived?: boolean;
    stale?: boolean;        // set or clear the stale flag
    assignees?: string[]; // add-only merge: union of existing + new
    parentId?: string | null; // null to un-parent; string to re-parent
  }
  let patch: PatchBody;
  try { patch = await req.json(); } catch { return errorResponse("Invalid JSON"); }

  // Validate empty title
  if (patch.title !== undefined && patch.title.trim().length === 0) {
    return errorResponse("title cannot be empty", 422);
  }

  let updated: Task | undefined;
  let columnChanged = false;
  let isEdit = false; // true if title or description changed
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (board) => {
    const idx = board.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const task = board.tasks[idx];

    // Handle re-parenting
    if (patch.parentId !== undefined) {
      const oldParentId = task.parentId;
      const newParentId = patch.parentId;

      // Check new parent exists and is not a subtask itself
      if (newParentId !== null) {
        const newParent = board.tasks.find(t => t.id === newParentId);
        if (!newParent) return; // will be caught after withWrite
        if (newParent.parentId !== null) return; // cannot re-parent under a subtask
        if (newParentId === taskId) return; // cannot parent to self
      }

      // Remove from old parent's subtaskIds
      if (oldParentId !== null) {
        const oldParent = board.tasks.find(t => t.id === oldParentId);
        if (oldParent) {
          oldParent.subtaskIds = oldParent.subtaskIds.filter(id => id !== taskId);
        }
      }

      // Add to new parent's subtaskIds
      if (newParentId !== null) {
        const newParent = board.tasks.find(t => t.id === newParentId);
        if (newParent) {
          newParent.subtaskIds = [...new Set([...newParent.subtaskIds, taskId])];
        }
      }

      task.parentId = newParentId;
    }

    if (patch.column !== undefined && patch.column !== task.column) columnChanged = true;
    if (patch.title !== undefined) { task.title = patch.title; isEdit = true; }
    if (patch.description !== undefined) { task.description = patch.description; isEdit = true; }
    if (patch.column !== undefined) task.column = patch.column as ColumnId;
    if (patch.agent !== undefined) task.agent = patch.agent;
    if (patch.model !== undefined) task.model = patch.model;
    if (patch.state !== undefined) task.state = patch.state;
    if (patch.order !== undefined) task.order = patch.order;
    if (patch.archived !== undefined) task.archived = patch.archived;
    if (patch.stale !== undefined) task.stale = patch.stale;
    // Merge assignees (add-only, not destructive)
    if (patch.assignees !== undefined) {
      task.assignees = [...new Set([...task.assignees, ...patch.assignees])];
    }

    // Re-derive metadata if title or description changed
    if (patch.title !== undefined || patch.description !== undefined) {
      const derived = extractMetadata({ title: task.title, description: task.description });
      task.tags = (patch.tags && patch.tags.length > 0)
        ? [...new Set([...derived.tags, ...patch.tags])]
        : derived.tags;
      task.category = patch.category ?? derived.category;
      task.priority = derived.priority;
      task.effort = derived.effort;
    } else {
      // Apply explicit overrides even without re-derivation
      if (patch.tags !== undefined) {
        task.tags = patch.tags;
      }
      if (patch.category !== undefined) {
        task.category = patch.category;
      }
    }

    task.updatedAt = nowIso();
    if (columnChanged) board.tasks = renormalizeOrder(board.tasks);
    updated = { ...task };
  });

  if (!updated) return errorResponse("Task not found", 404);
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updated);
  if (columnChanged) {
    recordEvent(KANBAN_DIR, "task.moved", {
      taskId,
      author: "user",
      summary: `moved '${updated.title}' to ${updated.column}`,
      payload: { from: patch.column },
    });
  } else if (isEdit) {
    recordEvent(KANBAN_DIR, "task.updated", {
      taskId,
      author: "user",
      summary: `edited '${updated.title}'`,
      payload: { changes: Object.keys(patch) },
    });
  } else {
    recordEvent(KANBAN_DIR, "task.updated", {
      taskId,
      author: "user",
      summary: `updated '${updated.title}'`,
      payload: { changes: Object.keys(patch) },
    });
  }
  return jsonResponse(updated);
}

// ─── Stale recheck endpoint ─────────────────────────────────────────────────

/**
 * POST /api/tasks/recheck-stale
 * Body: { taskId: string }
 * Returns: { stale: boolean, sourceHash: string }
 *
 * Checks whether the source file for a task has changed since import.
 */
export async function apiRecheckStale(_ctx: BoardContext, req: Request): Promise<Response> {
  interface RecheckBody { taskId: string; }
  let body: RecheckBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.taskId) return errorResponse("taskId is required", 422);

  const board = await getBoard();
  const task = board.tasks.find(t => t.id === body.taskId);
  if (!task) return errorResponse("Task not found", 404);

  // No source → never stale
  if (!task.source) {
    return jsonResponse({ stale: false, sourceHash: "" });
  }

  const absPath = join(KANBAN_DIR, "..", task.source.path);
  let content: string;
  try { content = readFileSync(absPath, "utf-8"); } catch { return errorResponse("Source file not readable", 422); }

  const newHash = createHash("sha256").update(content).digest("hex");
  const isStale = newHash !== task.sourceHash;

  if (isStale !== task.stale || task.lastSourceCheck === undefined) {
    task.stale = isStale;
    task.lastSourceCheck = nowIso();
    if (isStale) task.sourceHash = newHash; // update hash so subsequent recheck is consistent
    selfWriteUntil = Date.now() + 250;
    await withWrite(async (b) => {
      const t = b.tasks.find(t => t.id === body.taskId);
      if (t) {
        t.stale = isStale;
        t.lastSourceCheck = task.lastSourceCheck;
        if (isStale) t.sourceHash = newHash;
      }
    });
    const updated = (await getBoard()).tasks.find(t => t.id === body.taskId)!;
    await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
    broadcast("task.updated", updated);
    return jsonResponse({ stale: isStale, sourceHash: newHash });
  }

  return jsonResponse({ stale: isStale, sourceHash: task.sourceHash ?? newHash });
}

export async function apiDeleteTask(_ctx: BoardContext, taskId: string): Promise<Response> {
  let removedId = "";
  const subtaskIds: string[] = [];
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (board) => {
    const idx = board.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    removedId = board.tasks[idx].id;
    subtaskIds.push(...board.tasks[idx].subtaskIds);

    // Remove child's id from parent's subtaskIds
    const parentId = board.tasks[idx].parentId;
    if (parentId) {
      const parent = board.tasks.find(t => t.id === parentId);
      if (parent) {
        parent.subtaskIds = parent.subtaskIds.filter(id => id !== taskId);
      }
    }

    board.tasks.splice(idx, 1);
    board.tasks = renormalizeOrder(board.tasks);
  });
  if (!removedId) return errorResponse("Task not found", 404);

  // Cascade delete all subtasks (collect grandchildren first, then delete leaves)
  async function deleteSubtasks(ids: string[]): Promise<void> {
    for (const id of ids) {
      const taskDir = join(KANBAN_DIR, "tasks", id);
      removeDir(taskDir);
      // Record event before board modification
      recordEvent(KANBAN_DIR, "task.deleted", {
        taskId: id,
        author: "user",
        summary: `deleted subtask '${id}'`,
        payload: {},
      });
      broadcast("task.deleted", { id });
      await withWrite(async (board) => {
        const idx = board.tasks.findIndex(t => t.id === id);
        if (idx === -1) return;
        // Remove from parent's subtaskIds
        const pId = board.tasks[idx].parentId;
        if (pId) {
          const parent = board.tasks.find(t => t.id === pId);
          if (parent) parent.subtaskIds = parent.subtaskIds.filter(x => x !== id);
        }
        board.tasks.splice(idx, 1);
        board.tasks = renormalizeOrder(board.tasks);
      });
    }
  }
  await deleteSubtasks(subtaskIds);

  // Delete task directory
  const taskDir = join(KANBAN_DIR, "tasks", taskId);
  removeDir(taskDir);

  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.deleted", { id: taskId });
  recordEvent(KANBAN_DIR, "task.deleted", {
    taskId,
    author: "user",
    summary: `deleted task '${taskId}'`,
    payload: {},
  });
  return jsonResponse({ ok: true });
}

// ─── Tags endpoint ────────────────────────────────────────────────────────────

async function apiGetTags(): Promise<Response> {
  const board = await getBoard();

  const categorySet = new Set<Category>();
  const tagCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const effortCounts = new Map<string, number>();

  for (const task of board.tasks) {
    const cat = (task.category ?? "task") as Category;
    categorySet.add(cat);
    priorityCounts.set(task.priority ?? "normal", (priorityCounts.get(task.priority ?? "normal") ?? 0) + 1);
    if (task.effort !== null && task.effort !== undefined) {
      effortCounts.set(task.effort, (effortCounts.get(task.effort) ?? 0) + 1);
    }
    for (const tag of (task.tags ?? [])) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const tagCountObj: Record<string, number> = {};
  for (const [tag, count] of tagCounts) tagCountObj[tag] = count;

  const priorityCountObj: Record<string, number> = {};
  for (const [p, count] of priorityCounts) priorityCountObj[p] = count;

  const effortCountObj: Record<string, number> = {};
  for (const [e, count] of effortCounts) effortCountObj[e] = count;

  return jsonResponse({
    categories: [...categorySet].sort(),
    tagCounts: tagCountObj,
    priorityCounts: priorityCountObj,
    effortCounts: effortCountObj,
  });
}

// ─── Input endpoints ──────────────────────────────────────────────────────────

async function apiAskInput(_ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface AskBody {
    type?: "ask" | "choice" | "input" | "confirm";
    question: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    placeholder?: string;
    blockId?: string;
  }
  let body: AskBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.question) return errorResponse("question is required", 422);

  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);

  // Check for existing pending input
  const existing = getPendingInput(taskId, KANBAN_DIR);
  if (existing) return errorResponse("A pending input already exists for this task", 409);

  const inputType = body.type ?? "ask";
  const input = addInput(taskId, KANBAN_DIR, {
    type: inputType,
    question: body.question,
    options: body.options,
    placeholder: body.placeholder,
    blockId: body.blockId,
  });

  // Update task state to waiting-for-input
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (b) => {
    const t = b.tasks.find(t => t.id === taskId);
    if (t) {
      t.state = "waiting-for-input";
      t.pendingInputs = [...(t.pendingInputs ?? []), input.id];
      t.updatedAt = nowIso();
    }
  });

  const updated = (await getBoard()).tasks.find(t => t.id === taskId)!;
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  broadcast("task.updated", updated);
  broadcast("task.input.asked", { taskId, input });
  recordEvent(KANBAN_DIR, "task.input.asked", {
    taskId,
    author: "user",
    summary: `asked '${body.question}' on '${task.title}'`,
    payload: { inputId: input.id, type: input.type },
  });
  return jsonResponse(input, 201);
}

async function apiRespondInput(_ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface RespondBody { inputId: string; value?: string; optionId?: string; }
  let body: RespondBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.inputId) return errorResponse("inputId is required", 422);

  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);

  let updatedInput: Input;
  try {
    updatedInput = respondInput(taskId, KANBAN_DIR, body.inputId, { value: body.value, optionId: body.optionId });
  } catch (e) {
    return errorResponse("respondInput failed: " + String((e as any)?.message ?? e), 422);
  }

  // Restore task to prior state (default running)
  const priorState = task.sessionId ? "running" : "idle";
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (b) => {
    const t = b.tasks.find(t => t.id === taskId);
    if (t) {
      t.state = priorState;
      t.pendingInputs = (t.pendingInputs ?? []).filter(id => id !== body.inputId);
      t.updatedAt = nowIso();
    }
  });

  const updated = (await getBoard()).tasks.find(t => t.id === taskId)!;
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  broadcast("task.updated", updated);
  broadcast("task.input.responded", { taskId, input: updatedInput });
  recordEvent(KANBAN_DIR, "task.input.responded", {
    taskId,
    author: "user",
    summary: `responded to input on '${task.title}'`,
    payload: { inputId: updatedInput.id },
  });
  return jsonResponse(updatedInput);
}

// ─── Comment endpoints ────────────────────────────────────────────────────────

async function apiGetComments(_ctx: BoardContext, taskId: string): Promise<Response> {
  const comments = listComments(taskId, KANBAN_DIR);
  return jsonResponse(comments);
}

async function apiAddComment(_ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface CommentBody { blockId: string; line: number; text: string; author?: string; }
  let body: CommentBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.blockId || !body.text) return errorResponse("blockId and text are required", 422);

  // Resolve author: explicit "agent:<name>" wins, else body.author, else git user, else "user"
  let author = body.author ?? "user";
  const projectRoot = getActiveProjectRoot();
  if (author === "user" || !author) {
    const gitUser = currentGitUser(projectRoot);
    author = gitUser?.name ?? "user";
  }

  const comment = addComment(taskId, KANBAN_DIR, {
    blockId: body.blockId,
    line: body.line ?? 1,
    text: body.text,
    author,
  });

  broadcast("task.comment.added", { taskId, comment });
  recordEvent(KANBAN_DIR, "task.commented", {
    taskId,
    author: comment.author,
    summary: `commented on task`,
    payload: { commentId: comment.id, text: comment.text.slice(0, 80) },
  });
  return jsonResponse(comment, 201);
}

async function apiResolveComment(_ctx: BoardContext, taskId: string, commentId: string, req: Request): Promise<Response> {
  interface ResolveBody { resolved: boolean; reason?: string; author?: string; }
  let body: ResolveBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }

  // Resolve resolvedBy: explicit author wins, else git user, else "user"
  let resolvedBy = body.author ?? "user";
  if (!resolvedBy || resolvedBy === "user") {
    const projectRoot = getActiveProjectRoot();
    const gitUser = currentGitUser(projectRoot);
    resolvedBy = gitUser?.name ?? "user";
  }

  const updated = resolveComment(taskId, KANBAN_DIR, commentId, body.resolved, resolvedBy, undefined, body.reason);
  if (!updated) return errorResponse("Comment not found", 404);
  broadcast("task.comment.resolved", { taskId, comment: updated });
  recordEvent(KANBAN_DIR, "task.comment.resolved", {
    taskId,
    author: resolvedBy,
    summary: `${body.resolved ? "resolved" : "unresolved"} comment on task`,
    payload: { commentId },
  });
  return jsonResponse(updated);
}

async function apiDeleteComment(_ctx: BoardContext, taskId: string, commentId: string): Promise<Response> {
  const ok = deleteComment(taskId, KANBAN_DIR, commentId);
  if (!ok) return errorResponse("Comment not found", 404);
  broadcast("task.comment.deleted", { taskId, commentId });
  recordEvent(KANBAN_DIR, "task.comment.deleted", {
    taskId,
    author: "user",
    summary: `deleted comment on task`,
    payload: { commentId },
  });
  return jsonResponse({ ok: true });
}

// ─── MDX rendered ────────────────────────────────────────────────────────────

async function apiGetMdxRendered(taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);

  const mdxPath = join(KANBAN_DIR, task.artifacts.mdxPath);
  let mdx = "";
  if (existsSync(mdxPath)) {
    try { if (statSync(mdxPath).isFile()) mdx = readFileSync(mdxPath, "utf-8"); } catch { /* ignore */ }
  }

  const result = await renderMdx(mdx);
  return jsonResponse({ html: result.html, blocks: result.blocks });
}

// ─── TSX preview ─────────────────────────────────────────────────────────────

async function apiPreview(req: Request): Promise<Response> {
  interface PreviewBody { tsx: string; props?: Record<string, unknown>; }
  let body: PreviewBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.tsx) return errorResponse("tsx is required", 422);

  const result = await buildPreview(body.tsx, body.props);
  if (result.error) return jsonResponse({ error: result.error }, 422);
  return jsonResponse({ js: result.js, sandboxHtml: result.sandboxHtml });
}

// ─── Session/status handlers (reuse existing) ─────────────────────────────────

export async function apiStartTask(projectRoot: string, taskId: string, req: Request): Promise<Response> {
  interface StartBody { agent?: string; model?: string; }
  let body: StartBody;
  try { body = await req.json(); } catch { body = {}; }

  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  if (task.sessionId) return errorResponse("Task already has an active session", 409);

  let knownAgents: string[] = [];
  try {
    const snapshot = await getBizarSnapshot(projectRoot);
    knownAgents = Array.isArray(snapshot?.agents)
      ? snapshot.agents.map((candidate: any) => candidate.id ?? candidate.name).filter(Boolean)
      : [];
  } catch (e) {
    return errorResponse("Unable to load Bizar agents: " + String((e as any)?.message ?? e), 502);
  }

  if (body.agent && knownAgents.length > 0 && !knownAgents.includes(body.agent)) {
    return errorResponse(`Unknown agent "${body.agent}". Available: ${knownAgents.join(", ")}`, 400);
  }

  // Read agents.active from .ok/openkan.json if present
  let agentsActive: string | undefined;
  try {
    const agentsConfigPath = join(projectRoot, ".ok", "openkan.json");
    if (existsSync(agentsConfigPath)) {
      const raw = JSON.parse(readFileSync(agentsConfigPath, "utf-8")) as Record<string, unknown>;
      const agentsBlock = raw["agents"] as Record<string, unknown> | undefined;
      if (agentsBlock && typeof agentsBlock["active"] === "string" && agentsBlock["active"]) {
        agentsActive = agentsBlock["active"] as string;
      }
    }
  } catch { /* ignore config read errors */ }

  const preferred = body.agent || task.agent;
  const agent = (preferred && knownAgents.includes(preferred) ? preferred : "")
    || (agentsActive && knownAgents.includes(agentsActive) ? agentsActive : "")
    || (knownAgents.includes("mike") ? "mike" : knownAgents[0]);
  if (!agent) return errorResponse("No Bizar agents are available", 503);

  let sessionId: string;
  try {
    const started = executeBizarCommand(projectRoot, "start-session", {
      agent,
      name: `OpenKan: ${task.title}`,
      prompt: [
        `Work on OpenKan task ${task.id}: ${task.title}`,
        task.description,
        `Keep the task workspace at .ok/tasks/${task.id}/task.mdx synchronized with progress.`,
      ].filter(Boolean).join("\n\n"),
    });
    sessionId = started?.session?.sessionId ?? started?.session?.id ?? "";
    if (!sessionId) throw new Error("Bizar did not return a session ID");
  } catch (e) {
    return errorResponse("Bizar session start failed: " + String((e as any)?.message ?? e), 502);
  }

  const startedAt = nowIso();
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (b) => {
    const t = b.tasks.find(t => t.id === taskId);
    if (!t) return;
    t.sessionId = sessionId;
    t.agent = agent;
    if (body.model) t.model = body.model;
    t.state = "running";
    t.updatedAt = nowIso();
    b.sessions[sessionId] = { taskId, status: "running", startedAt, endedAt: null };
  });

  const updatedTask = (await getBoard()).tasks.find(t => t.id === taskId)!;
  await writeTaskMdx(updatedTask, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updatedTask);
  recordEvent(KANBAN_DIR, "agent.started", {
    taskId,
    author: `agent:${agent}`,
    summary: `started on '${task.title}'`,
    payload: { sessionId, agent },
  });
  return jsonResponse(updatedTask);
}

export async function apiAbortTask(projectRoot: string, taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  const sessionId = task.sessionId;
  if (!sessionId) return errorResponse("Task has no active session", 409);

  try {
    executeBizarCommand(projectRoot, "stop-session", { sessionId });
  } catch (e: any) {
    return errorResponse("Bizar session stop failed: " + String(e?.message ?? e), 502);
  }

  selfWriteUntil = Date.now() + 250;
  await withWrite(async (b) => {
    const t = b.tasks.find(t => t.id === taskId);
    if (!t) return;
    t.state = "cancelled";
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

// ─── Archive / restore ──────────────────────────────────────────────────────

export async function apiArchiveTask(_ctx: BoardContext, taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  const author = "user";
  selfWriteUntil = Date.now() + 250;

  // Cascade archive subtasks
  async function archiveSubtasks(ids: string[]): Promise<void> {
    for (const id of ids) {
      const subtask = (await getBoard()).tasks.find(t => t.id === id);
      if (!subtask || subtask.archived) continue;
      const updated = await archiveTask(subtask, KANBAN_DIR, author);
      await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
      broadcast("task.updated", updated);
    }
  }

  const updated = await archiveTask(task, KANBAN_DIR, author);
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updated);

  // Cascade to subtasks
  await archiveSubtasks(task.subtaskIds);

  return jsonResponse(updated);
}

export async function apiRestoreTask(_ctx: BoardContext, taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  const author = "user";
  selfWriteUntil = Date.now() + 250;

  // Cascade restore subtasks
  async function restoreSubtasks(ids: string[]): Promise<void> {
    for (const id of ids) {
      const subtask = (await getBoard()).tasks.find(t => t.id === id);
      if (!subtask || !subtask.archived) continue;
      const updated = await restoreTask(subtask, KANBAN_DIR, author);
      await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
      broadcast("task.updated", updated);
    }
  }

  const updated = await restoreTask(task, KANBAN_DIR, author);
  await writeTaskMdx(updated, KANBAN_DIR, await getBoard());
  await writeBoardMdx(await getBoard(), KANBAN_DIR);
  broadcast("task.updated", updated);

  // Cascade to subtasks
  await restoreSubtasks(task.subtaskIds);

  return jsonResponse(updated);
}

// ─── Changelog ─────────────────────────────────────────────────────────────

export async function apiGetChangelog(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? undefined;
  const until = url.searchParams.get("until") ?? undefined;
  const kindStr = url.searchParams.get("kind");
  const kind = kindStr as ChangelogKind | undefined;
  const taskId = url.searchParams.get("taskId") ?? undefined;
  const author = url.searchParams.get("author") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const completedOnly = url.searchParams.get("completedOnly") === "true" || url.searchParams.get("completedOnly") === "1";
  const reset = url.searchParams.get("reset") === "true";
  const result = readEvents(KANBAN_DIR, { since, until, kind, taskId, author, limit, offset, completedOnly, reset, kanbanDirForCompletedOnly: KANBAN_DIR });
  return jsonResponse(result, 200, { "Cache-Control": "no-cache, no-transform" });
}

async function apiGetChangelogSummary(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  const summary = readSummary(KANBAN_DIR, { days });
  return jsonResponse(summary);
}

async function apiGetInsightsVelocity(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawDays = parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Math.max(1, Math.min(365, isFinite(rawDays) ? rawDays : 30));
  const buckets = computeVelocity(KANBAN_DIR, days);
  return jsonResponse({
    days: buckets.days,
    columns: {
      backlog: buckets.backlog,
      todo: buckets.todo,
      doing: buckets.doing,
      review: buckets.review,
      done: buckets.done,
    },
    windowDays: buckets.windowDays,
    generatedAt: buckets.generatedAt,
  });
}

// ─── Contributors & git attribution ────────────────────────────────────────

async function apiGetContributors(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? undefined;
  const until = url.searchParams.get("until") ?? undefined;
  const maxCount = parseInt(url.searchParams.get("maxCount") ?? "1000", 10);
  const projectRoot = join(KANBAN_DIR, "..");
  if (!isGitRepo(projectRoot)) return jsonResponse([]);
  const contributors = listContributors(projectRoot, { since, until, maxCount });
  return jsonResponse(contributors);
}

async function apiGetTaskContributors(_ctx: BoardContext, taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  const projectRoot = join(KANBAN_DIR, "..");
  const attributed = attributeCommitsToTasks(
    projectRoot,
    [{ id: task.id, title: task.title, source: task.source }],
    {},
  );
  const commits = attributed.get(task.id) ?? [];
  return jsonResponse(commits);
}

// ─── Organize ───────────────────────────────────────────────────────────────

export type OrganizeOperation =
  | { kind: "rederive"; taskId: string }
  | { kind: "set-tags"; taskId: string; tags: string[] }
  | { kind: "add-tags"; taskId: string; tags: string[] }
  | { kind: "remove-tag"; taskId: string; tag: string }
  | { kind: "set-priority"; taskId: string; priority: Priority }
  | { kind: "set-effort"; taskId: string; effort: Effort | null }
  | { kind: "set-category"; taskId: string; category: Category }
  | { kind: "move"; taskId: string; column: import("./board.ts").ColumnId }
  | { kind: "archive"; taskId: string }
  | { kind: "restore"; taskId: string }
  | { kind: "add-area"; taskId: string; area: string };

export async function apiOrganize(_ctx: BoardContext, req: Request): Promise<Response> {
  interface OrganizeBody { operations: OrganizeOperation[]; }
  let body: OrganizeBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!Array.isArray(body.operations)) return errorResponse("operations must be an array", 422);

  const applied: Array<{ taskId: string; kind: string; before: unknown; after: unknown }> = [];
  const skipped: Array<{ taskId: string; kind: string; reason: string }> = [];

  selfWriteUntil = Date.now() + 1000;
  await withWrite(async (board) => {
    for (const op of body.operations) {
      const t = board.tasks.find(x => x.id === op.taskId);
      if (!t) {
        skipped.push({ taskId: op.taskId, kind: op.kind, reason: `Task not found` });
        continue;
      }
      const before = { column: t.column, tags: [...t.tags], priority: t.priority, effort: t.effort, category: t.category, archived: t.archived };
      try {
        switch (op.kind) {
          case "rederive": {
            const derived = extractMetadata({ title: t.title, description: t.description });
            t.tags = derived.tags;
            t.category = derived.category;
            t.priority = derived.priority;
            t.effort = derived.effort;
            break;
          }
          case "set-tags":
            t.tags = op.tags;
            break;
          case "add-tags":
            t.tags = [...new Set([...t.tags, ...op.tags])];
            break;
          case "remove-tag":
            t.tags = t.tags.filter(tag => tag !== op.tag);
            break;
          case "set-priority":
            t.priority = op.priority;
            break;
          case "set-effort":
            t.effort = op.effort;
            break;
          case "set-category":
            t.category = op.category;
            break;
          case "move":
            t.column = op.column;
            break;
          case "archive":
            t.archived = true;
            break;
          case "restore":
            t.archived = false;
            break;
          case "add-area":
            if (!t.tags.includes(`area:${op.area}`)) t.tags = [...t.tags, `area:${op.area}`];
            break;
          default:
            skipped.push({
              taskId: (op as any).taskId,
              kind: (op as any).kind,
              reason: "Unknown operation kind",
            });
            continue;
        }
        t.updatedAt = nowIso();
        const after = { column: t.column, tags: [...t.tags], priority: t.priority, effort: t.effort, category: t.category, archived: t.archived };
        applied.push({ taskId: op.taskId, kind: op.kind, before, after });
      } catch (e) {
        skipped.push({ taskId: op.taskId, kind: op.kind, reason: String((e as any)?.message ?? e) });
      }
    }
    // Renormalize after any move ops
    if (applied.some(a => a.kind === "move")) {
      board.tasks = renormalizeOrder(board.tasks);
    }
  });

  const summary = {
    moved: applied.filter(a => a.kind === "move").length,
    retagged: applied.filter(a => ["set-tags", "add-tags", "remove-tag", "add-area", "set-category", "rederive"].includes(a.kind)).length,
    archived: applied.filter(a => a.kind === "archive").length,
    errors: skipped.length,
  };

  if (applied.length > 0) {
    const board = await getBoard();
    for (const a of applied) {
      const t = board.tasks.find(x => x.id === a.taskId);
      if (t) {
        await writeTaskMdx(t, KANBAN_DIR, board);
        broadcast("task.updated", t);
      }
    }
    await writeBoardMdx(board, KANBAN_DIR);
  }

  recordEvent(KANBAN_DIR, "kanban.organized", {
    author: "user",
    summary: `organized ${applied.length} task(s)`,
    payload: { operations: applied, skipped },
  });

  return jsonResponse({ applied, skipped, summary });
}

// ─── Import ──────────────────────────────────────────────────────────────────

export async function apiImport(_ctx: BoardContext, req: Request): Promise<Response> {
  interface ImportBody {
    include?: string[];
    exclude?: string[];
    defaultColumn?: string;
  }

  let body: ImportBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }

  // Read defaults from config
  const configPath = join(KANBAN_DIR, "config.json");
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch { /* ignore */ }

  const importConfig = (config["import"] as Record<string, unknown>) ?? {};
  const include = body.include ?? (importConfig["include"] as string[] | undefined) ?? ["docs/**", "*.md", "*.mdx"];
  const exclude = body.exclude ?? (importConfig["exclude"] as string[] | undefined) ?? [];

  const importCtx: BoardContext = {
    directory: KANBAN_DIR,
    client: null as any,
    log: async () => {},
  };

  const result = await runImport(importCtx, { include, exclude });
  return jsonResponse({ ok: true, imported: result.imported }, 201);
}

// ─── Settings ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  columns: ["backlog", "todo", "doing", "review", "done"],
  defaultAgent: "",
  defaultModel: null as string | null,
};

async function apiGetSettings(): Promise<Response> {
  const configPath = join(KANBAN_DIR, "openkan.json");
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch { /* ignore */ }
  const projectRoot = join(KANBAN_DIR, "..");
  const gitUser = isGitRepo(projectRoot) ? { name: "git", email: "" } : null;
  const merged = { ...DEFAULT_SETTINGS, ...config, gitUser };
  return jsonResponse(merged);
}

async function apiPatchSettings(_ctx: BoardContext, req: Request): Promise<Response> {
  let patch: Record<string, unknown>;
  try { patch = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  const configPath = join(KANBAN_DIR, "openkan.json");
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch { /* ignore */ }
  const merged = { ...existing, ...patch };
  writeFileAtomic(configPath, JSON.stringify(merged, null, 2));
  recordEvent(KANBAN_DIR, "settings.changed", {
    author: "user",
    summary: "changed settings",
    payload: { changes: Object.keys(patch) },
  });
  return jsonResponse({ ok: true, settings: merged });
}

// ─── Config sections (settings sidebar) ─────────────────────────────────────────

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  value: unknown;
  options?: Array<{ label: string; value: unknown }>;
  description?: string;
}

export interface ConfigSection {
  id: string;
  label: string;
  fields: ConfigField[];
}

function loadConfig(): Record<string, unknown> {
  const configPath = join(KANBAN_DIR, "openkan.json");
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    }
  } catch { /* ignore */ }
  return {};
}

export async function apiGetConfigSections(): Promise<Response> {
  const config = loadConfig();

  const sections: ConfigSection[] = [
    {
      id: "project",
      label: "Project",
      fields: [
        { key: "defaultAgent",   label: "Default agent",     type: "text",   value: (config["project"] as Record<string, unknown>)?.["defaultAgent"] ?? "" },
        { key: "defaultModel",    label: "Default model",      type: "text",   value: (config["project"] as Record<string, unknown>)?.["defaultModel"] ?? "" },
        { key: "defaultColumn", label: "Default column", type: "select", value: (config["project"] as Record<string, unknown>)?.["defaultColumn"] ?? "backlog", options: [{ label: "Backlog", value: "backlog" }, { label: "To Do", value: "todo" }, { label: "In Progress", value: "doing" }, { label: "Review", value: "review" }, { label: "Done", value: "done" }], description: "Where newly created tasks start." },
        { key: "autoArchiveDays", label: "Auto-archive days", type: "number", value: (config["project"] as Record<string, unknown>)?.["autoArchiveDays"] ?? 0, description: "Use 0 to keep completed tasks indefinitely." },
      ],
    },
    {
      id: "server",
      label: "Server",
      fields: [
        { key: "port", label: "Port", type: "number", value: config["port"] ?? 7777 },
        { key: "host", label: "Host", type: "text",   value: config["host"] ?? "127.0.0.1" },
      ],
    },
    {
      id: "ui",
      label: "UI",
      fields: [
        {
          key: "theme", label: "Theme", type: "select", description: "Applied immediately and remembered for this browser.",
          value: config["theme"] ?? "dark",
          options: [
            { label: "Light",  value: "light"  },
            { label: "Dark",   value: "dark"   },
            { label: "System", value: "system" },
          ],
        },
      ],
    },
    {
      id: "sandbox",
      label: "Sandbox",
      fields: [
        { key: "tsxMaxBytes", label: "TSX max bytes", type: "number", value: (config["sandbox"] as Record<string, unknown>)?.["tsxMaxBytes"] ?? 32768 },
      ],
    },
    {
      id: "bizar",
      label: "Agent runtime",
      fields: [
        {
          key: "enabled",
          label: "Enabled",
          type: "boolean",
          value: (config["bizar"] as Record<string, unknown>)?.["enabled"] ?? true,
          description: "Expose this project's configured Bizar control plane.",
        },
        {
          key: "projectRoot",
          label: "Bizar project root",
          type: "text",
          value: (config["bizar"] as Record<string, unknown>)?.["projectRoot"] ?? ".",
          description: "Absolute path or path relative to the OpenKan project.",
        },
        {
          key: "command",
          label: "Bizar command",
          type: "text",
          value: (config["bizar"] as Record<string, unknown>)?.["command"] ?? "bizar",
          description: "Executable or local cli/bin.mjs path. Never evaluated through a shell.",
        },
      ],
    },
    {
      id: "import",
      label: "Import",
      fields: [
        { key: "include", label: "Include paths",   type: "text", value: JSON.stringify((config["import"] as Record<string, unknown>)?.["include"] ?? []) },
        { key: "exclude", label: "Exclude paths",   type: "text", value: JSON.stringify((config["import"] as Record<string, unknown>)?.["exclude"] ?? []) },
      ],
    },
    {
      id: "chat",
      label: "Chat",
      fields: [
        { key: "defaultModel", label: "Default model", type: "text", value: (config["chat"] as Record<string, unknown>)?.["defaultModel"] ?? "", description: "Leave empty to use the model router's configured default." },
        { key: "defaultEffort", label: "Default effort", type: "select", value: (config["chat"] as Record<string, unknown>)?.["defaultEffort"] ?? "high", options: [{ label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" }] },
        { key: "permissionMode", label: "Permission mode", type: "select", value: (config["chat"] as Record<string, unknown>)?.["permissionMode"] ?? "default", options: [{ label: "Default", value: "default" }, { label: "Accept edits", value: "acceptEdits" }, { label: "Plan", value: "plan" }] },
      ],
    },
    {
      id: "notifications",
      label: "Notifications",
      fields: [
        { key: "desktop", label: "Desktop notifications", type: "boolean", value: (config["notifications"] as Record<string, unknown>)?.["desktop"] ?? false },
        { key: "sound", label: "Completion sound", type: "boolean", value: (config["notifications"] as Record<string, unknown>)?.["sound"] ?? false },
      ],
    },
    {
      id: "advanced",
      label: "Advanced",
      fields: [
        { key: "autoArchiveAfterDays", label: "Auto-archive after days", type: "number", value: config["autoArchiveAfterDays"] ?? 0 },
      ],
    },
    {
      id: "agents",
      label: "Agents",
      fields: [
        {
          key: "active",
          label: "Active profile",
          type: "text",
          value: (config["agents"] as Record<string, unknown>)?.["active"] ?? "claude-code",
        },
        {
          key: "profiles",
          label: "Profiles (read-only)",
          type: "text",
          value: JSON.stringify((config["agents"] as Record<string, unknown>)?.["profiles"] ?? []),
        },
      ],
    },
    {
      id: "contributors",
      label: "Contributors",
      fields: [],
    },
  ];

  return jsonResponse({ sections });
}

export async function apiPatchConfigSection(_ctx: BoardContext, sectionId: string, req: Request): Promise<Response> {
  interface PatchEntry { key: string; value: unknown; }
  let body: PatchEntry[];
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!Array.isArray(body)) return errorResponse("body must be an array of { key, value }", 422);

  const config = loadConfig();

  // Map sectionId to config path
  for (const { key, value } of body) {
    switch (sectionId) {
      case "project":
        if (!config["project"]) (config as Record<string, unknown>)["project"] = {};
        (config["project"] as Record<string, unknown>)[key] = value;
        break;
      case "server":
        (config as Record<string, unknown>)[key] = value;
        break;
      case "ui":
        (config as Record<string, unknown>)[key] = value;
        break;
      case "sandbox":
        if (!config["sandbox"]) (config as Record<string, unknown>)["sandbox"] = {};
        (config["sandbox"] as Record<string, unknown>)[key] = value;
        break;
      case "bizar":
        if (!config["bizar"]) (config as Record<string, unknown>)["bizar"] = {};
        (config["bizar"] as Record<string, unknown>)[key] = value;
        break;
      case "import":
        if (!config["import"]) (config as Record<string, unknown>)["import"] = {};
        if (key === "include" || key === "exclude") {
          // Stored as JSON arrays
          (config["import"] as Record<string, unknown>)[key] = typeof value === "string" ? JSON.parse(value) : value;
        } else {
          (config["import"] as Record<string, unknown>)[key] = value;
        }
        break;
      case "chat":
      case "notifications":
        if (!config[sectionId]) (config as Record<string, unknown>)[sectionId] = {};
        (config[sectionId] as Record<string, unknown>)[key] = value;
        break;
      case "advanced":
        (config as Record<string, unknown>)[key] = value;
        break;
      case "agents":
        if (!config["agents"]) (config as Record<string, unknown>)["agents"] = { active: "claude-code", profiles: [] };
        (config["agents"] as Record<string, unknown>)[key] = value;
        break;
      default:
        return errorResponse(`Unknown section: ${sectionId}`, 404);
    }
  }

  const configPath = join(KANBAN_DIR, "openkan.json");
  // Validate agents section before persisting
  if (sectionId === "agents") {
    const agents = config["agents"] as Record<string, unknown> | undefined;
    if (agents) {
      const err = validateAgentsConfig(agents);
      if (err) return errorResponse(`Invalid agents config at ${err.path}: ${err.reason}`, 422);
    }
  }
  writeFileAtomic(configPath, JSON.stringify(config, null, 2));

  // Return the updated section
  return apiGetConfigSections();
}

// ─── Updated tasks index (includes archived) ────────────────────────────────

function taskToIndexEntry(task: Task, _includeArchived: boolean) {
  return {
    id: task.id,
    title: task.title,
    column: task.column,
    order: task.order,
    state: task.state,
    mdxPath: task.artifacts?.mdxPath ?? task.artifact,
    agent: task.agent,
    model: task.model,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    source: task.source,
    tags: task.tags ?? [],
    category: task.category ?? "task",
    priority: task.priority ?? "normal",
    effort: task.effort ?? null,
    archived: task.archived,
    contributors: [] as Array<{ name: string; email: string; lastSeen: string }>,
  };
}

async function apiGetTasksIndex(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const board = await getBoard();
  let tasks = board.tasks.map(t => taskToIndexEntry(t, includeArchived));
  if (!includeArchived) tasks = tasks.filter(t => !t.archived);

  // Add top-5 contributors per task
  const projectRoot = join(KANBAN_DIR, "..");
  if (isGitRepo(projectRoot)) {
    const allContributors = listContributors(projectRoot, {});
    for (const t of tasks) {
      const attributed = attributeCommitsToTasks(projectRoot, [{ id: t.id, title: t.title, source: t.source }], {});
      const taskCommits = attributed.get(t.id) ?? [];
      const topEmails = [...new Set(taskCommits.map(c => c.email))].slice(0, 5);
      t.contributors = topEmails.map(email => {
        const c = allContributors.find(x => x.email === email);
        return c ? { name: c.name, email: c.email, lastSeen: c.lastSeen } : { name: email, email, lastSeen: "" };
      });
    }
  }

  return jsonResponse({ tasks });
}

// ─── Updated task detail (adds contributors) ───────────────────────────────

export async function apiGetTask(taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);

  let mdx = "";
  const mdxPath = join(KANBAN_DIR, task.artifacts.mdxPath);
  if (existsSync(mdxPath)) {
    try { if (statSync(mdxPath).isFile()) mdx = readFileSync(mdxPath, "utf-8"); } catch { /* ignore */ }
  }

  const blocks = await renderMdx(mdx);
  const renderedHtml = await renderMarkdown(mdx);
  const comments = listComments(taskId, KANBAN_DIR);
  const inputs = listInputs(taskId, KANBAN_DIR);

  // Fetch immediate subtasks
  const subtasks = task.subtaskIds
    .map(id => board.tasks.find(t => t.id === id))
    .filter((t): t is Task => t !== undefined);

  const projectRoot = join(KANBAN_DIR, "..");
  let commits: Array<{ sha: string; author: string; email: string; ts: string; subject: string; files: string[] }> = [];
  if (isGitRepo(projectRoot)) {
    const attributed = attributeCommitsToTasks(projectRoot, [{ id: task.id, title: task.title, source: task.source }], {});
    commits = attributed.get(task.id) ?? [];
  }

  return jsonResponse({
    task,
    mdx,
    metadata: {
      title: task.title,
      description: extractDescription(mdx),
      tags: task.tags || [],
      category: task.category,
      priority: task.priority,
      effort: task.effort,
      assignees: task.assignees || [],
      updatedAt: task.updatedAt,
      mtime: statMdxMtime(taskId, KANBAN_DIR) || null,
    },
    html: renderedHtml,
    blocks: blocks.blocks,
    comments,
    inputs,
    subtasks,
    attributions: commits,
  });
}

export async function apiGetSubtasks(taskId: string): Promise<Response> {
  const board = await getBoard();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return errorResponse("Task not found", 404);
  const subtasks = task.subtaskIds
    .map(id => board.tasks.find(t => t.id === id))
    .filter((t): t is Task => t !== undefined);
  return jsonResponse({ subtasks });
}

// ─── Image endpoints ──────────────────────────────────────────────────────────

/**
 * POST /api/tasks/:id/images
 * Body (v1 JSON): { data: base64, filename?: string, contentType?: string }
 * Frontend sends files as base64 via FileReader.readAsDataURL().
 * Alternative (not implemented in v1): multipart/form-data with raw bytes.
 */
async function apiUploadImage(_ctx: BoardContext, taskId: string, req: Request): Promise<Response> {
  interface ImageBody { data: string; filename?: string; contentType?: string; }
  let body: ImageBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.data) return errorResponse("data (base64) is required", 422);

  // Decode base64
  let buffer: Buffer;
  try {
    const base64Data = body.data.replace(/^data:[^;]+;base64,/, ""); // strip optional mime prefix
    buffer = Buffer.from(base64Data, "base64");
  } catch {
    return errorResponse("Invalid base64 data", 422);
  }

  // Determine extension from contentType or filename
  let ext = "";
  if (body.filename) {
    const m = body.filename.match(/\.([^.]+)$/);
    if (m) ext = m[1];
  }
  if (!ext && body.contentType) {
    const map: Record<string, string> = {
      "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
      "image/webp": "webp", "image/svg+xml": "svg",
    };
    ext = map[body.contentType] ?? "";
  }
  if (!ext) ext = "png"; // default

  const author = "user";
  let meta: ImageMeta;
  try {
    meta = saveImage(taskId, KANBAN_DIR, buffer, ext, body.contentType ?? `image/${ext}`, author);
  } catch (e) {
    return errorResponse(e?.message ?? "Failed to save image", 422);
  }

  // Add image filename to task.images list
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (board) => {
    const t = board.tasks.find(t => t.id === taskId);
    if (t) {
      if (!t.images) t.images = [];
      if (!t.images.includes(meta.name)) t.images.push(meta.name);
      t.updatedAt = nowIso();
    }
  });

  broadcast("task.image-added", { taskId, image: meta });
  recordEvent(KANBAN_DIR, "task.image-added", {
    taskId,
    author,
    summary: `uploaded image '${meta.name}'`,
    payload: { imageName: meta.name, size: meta.size },
  });
  return jsonResponse(meta, 201);
}

async function apiListImages(_ctx: BoardContext, taskId: string): Promise<Response> {
  const images = listImages(taskId, KANBAN_DIR);
  return jsonResponse({ images });
}

async function apiGetImage(_ctx: BoardContext, taskId: string, name: string): Promise<Response> {
  const result = readImage(taskId, KANBAN_DIR, name);
  if (!result) return errorResponse("Image not found", 404);
  return new Response(result.buffer, {
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "max-age=3600",
    },
  });
}

async function apiDeleteImage(_ctx: BoardContext, taskId: string, name: string): Promise<Response> {
  const ok = deleteImage(taskId, KANBAN_DIR, name);
  if (!ok) return errorResponse("Image not found", 404);

  // Remove from task.images list
  selfWriteUntil = Date.now() + 250;
  await withWrite(async (board) => {
    const t = board.tasks.find(t => t.id === taskId);
    if (t && t.images) {
      t.images = t.images.filter(n => n !== name);
      t.updatedAt = nowIso();
    }
  });

  broadcast("task.image-deleted", { taskId, imageName: name });
  recordEvent(KANBAN_DIR, "task.image-deleted", {
    taskId,
    author: "user",
    summary: `deleted image '${name}'`,
    payload: { imageName: name },
  });
  return jsonResponse({ ok: true });
}

// ─── /api/me ─────────────────────────────────────────────────────────────────

async function apiGetMe(_ctx: BoardContext): Promise<Response> {
  const projectRoot = join(KANBAN_DIR, "..");
  const gitUser = currentGitUser(projectRoot);
  const name = gitUser?.name ?? "user";
  const email = gitUser?.email ?? "";

  // Count tasks assigned to this user
  const board = await getBoard();
  const currentTasks = board.tasks.filter(t => t.assignees?.includes(name) && !t.archived).length;

  return jsonResponse({ name, email, currentTasks });
}

// ─── Project registry endpoints ───────────────────────────────────────────────

async function apiGetProjects(): Promise<Response> {
  return jsonResponse({ active: activeProject(), projects: listProjects() });
}

async function apiCreateProject(req: Request): Promise<Response> {
  interface CreateProjectBody { name?: string; root: string; }
  let body: CreateProjectBody;
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (!body.root) return errorResponse("root is required", 422);

  const entry = addProject({ name: body.name ?? body.root, root: body.root });
  await ensureBoardForProject(projectBoardContext(entry.root));
  return jsonResponse(entry, 201);
}

async function apiAutoDetectProjects(req: Request): Promise<Response> {
  interface AutoDetectBody {
    homes?: string[];
    suffixes?: string[];
    maxResults?: number;
  }
  let body: AutoDetectBody;
  try { body = await req.json().catch(() => ({})); } catch { body = {}; }

  const result = await autoDetectProjects({
    homes: body.homes,
    suffixes: body.suffixes,
    maxResults: body.maxResults,
  });
  return jsonResponse(result);
}

async function apiDeleteProject(id: string): Promise<Response> {
  const wasActive = activeProject()?.id === id;
  const ok = removeProject(id);
  if (!ok) return errorResponse("Project not found", 404);
  // If the deleted project was active, the registry already switched to the next one
  if (wasActive) {
    const newActive = activeProject();
    if (newActive) {
      await ensureBoardForProject(projectBoardContext(newActive.root));
    }
  }
  return jsonResponse({ ok: true });
}

async function apiActivateProject(id: string): Promise<Response> {
  const prev = setActiveProject(id);
  if (prev === null) return errorResponse("Project not found", 404);
  const entry = activeProject();
  if (entry) await ensureBoardForProject(projectBoardContext(entry.root));
  return jsonResponse(entry);
}

function projectBoardContext(directory: string): BoardContext {
  return { directory, client: null, log: async () => undefined };
}

// ─── Active project info endpoint ─────────────────────────────────────────────

async function apiGetProject(): Promise<Response> {
  return jsonResponse({ active: activeProject() });
}

// ─── Docs endpoints ───────────────────────────────────────────────────────────

async function apiGetDocs(): Promise<Response> {
  const root = getActiveProjectRoot();
  const { entries } = listDocs({ root });
  return jsonResponse({ entries });
}

async function apiGetDoc(req: Request, path: string): Promise<Response> {
  const root = getActiveProjectRoot();
  const url = new URL(req.url);
  const rawFlag = url.searchParams.get("raw") === "1";
  try {
    const doc = await readDoc({ root, relPath: path, render: !rawFlag });
    if (rawFlag) {
      return new Response(doc.raw, { headers: { "Content-Type": "text/markdown" } });
    }
    return jsonResponse(doc);
  } catch (e) {
    return errorResponse((e as Error).message ?? "Not found", 404);
  }
}

async function apiWriteDoc(req: Request, relPath: string): Promise<Response> {
  const root = getActiveProjectRoot();
  if (!relPath || relPath.includes("..") || !/\.(md|mdx|txt)$/i.test(relPath)) return errorResponse("Use a safe .md, .mdx, or .txt path", 422);
  let body: { content?: unknown };
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (typeof body.content !== "string") return errorResponse("content is required", 422);
  const docsRoot = resolve(root, "docs"); const target = resolve(docsRoot, relPath);
  if (!target.startsWith(`${docsRoot}/`)) return errorResponse("Unsafe path", 422);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, body.content, "utf8");
  return apiGetDoc(new Request(`http://local/api/docs/${encodeURI(relPath)}`), relPath);
}

async function apiDeleteDoc(relPath: string): Promise<Response> {
  const root = getActiveProjectRoot(); const docsRoot = resolve(root, "docs"); const target = resolve(docsRoot, relPath);
  if (!relPath || relPath.includes("..") || !target.startsWith(`${docsRoot}/`) || !existsSync(target)) return errorResponse("Document not found", 404);
  rmSync(target); return jsonResponse({ ok: true, path: relPath });
}

async function apiRenderDoc(req: Request): Promise<Response> {
  let body: { content?: unknown };
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  if (typeof body.content !== "string") return errorResponse("content is required", 422);
  const rendered = await renderMdx(body.content);
  return jsonResponse({ html: rendered.html, rendered: rendered.html, blocks: rendered.blocks });
}

async function apiGenerateDoc(req: Request): Promise<Response> {
  const root = getActiveProjectRoot(); let body: { path?: unknown; prompt?: unknown; model?: unknown; effort?: unknown; permissionMode?: unknown };
  try { body = await req.json(); } catch { return errorResponse("Invalid JSON"); }
  const path = typeof body.path === "string" ? body.path : ""; const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!path || !prompt) return errorResponse("path and prompt are required", 422);
  const result = await sendTurn(root, { message: `Write a complete Markdown document for docs/${path}. ${prompt}. Return only the document content.`, model: typeof body.model === "string" ? body.model : "default", effort: typeof body.effort === "string" ? body.effort : "high", permissionMode: typeof body.permissionMode === "string" ? body.permissionMode : "bypassPermissions" });
  const content = result.assistantTurn.content;
  const writeReq = new Request("http://local/api/docs", { method: "PUT", body: JSON.stringify({ content }), headers: { "content-type": "application/json" } });
  return apiWriteDoc(writeReq, path);
}

// ─── File-system browser endpoints ─────────────────────────────────────────────

/**
 * GET /api/fs?path=/abs/path&depth=2&includeHidden=0
 * Returns FsEntry for that path with children up to depth.
 * 400 if path is outside allowed roots.
 */
async function apiFs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return errorResponse("path is required", 400);

  // Must be absolute
  if (!rawPath.startsWith("/")) return errorResponse("path must be absolute", 400);

  // Deny-list check
  if (isDenyListed(rawPath)) return errorResponse("Access denied: deny-listed path", 403);

  // Symlink check: canonicalize and verify allowed
  const { realPath, allowed } = realPathIfAllowed(rawPath);
  if (!allowed) return errorResponse("Access denied: symlink resolves outside allowed tree", 403);

  // Cap depth at 5, maxEntries at 1000
  const depth = Math.min(parseInt(url.searchParams.get("depth") ?? "1", 10), 5);
  const includeHidden = url.searchParams.get("includeHidden") === "1" || url.searchParams.get("includeHidden") === "true";
  const maxEntries = Math.min(parseInt(url.searchParams.get("maxEntries") ?? "500", 10), 1000);

  const result = await listFs({ root: realPath, depth, includeHidden, followSymlinks: false, maxEntries });
  return jsonResponse(result);
}

/**
 * GET /api/home
 * Returns { home, entries } for the user's home directory.
 */
async function apiHome(): Promise<Response> {
  const result = await readHome();
  return jsonResponse(result);
}

/**
 * GET /api/parents?path=/abs/path&maxDepth=8
 * Returns array of FsEntry for ancestor directories (each depth 0, no children).
 * Used for breadcrumbs.
 */
async function apiParents(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return errorResponse("path is required", 400);

  if (!rawPath.startsWith("/")) return errorResponse("path must be absolute", 400);
  if (isDenyListed(rawPath)) return errorResponse("Access denied: deny-listed path", 403);

  const { allowed } = realPathIfAllowed(rawPath);
  if (!allowed) return errorResponse("Access denied: symlink resolves outside allowed tree", 403);

  const maxDepth = Math.min(parseInt(url.searchParams.get("maxDepth") ?? "8", 10), 8);
  const result = parents(rawPath, maxDepth);
  return jsonResponse(result);
}

// ─── Event handler ───────────────────────────────────────────────────────────

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
        if (t) { t.state = "done"; t.updatedAt = nowIso(); }
      });
      const updated = (await getBoard()).tasks.find(t => t.id === rec.taskId);
      if (updated) { await writeTaskMdx(updated, KANBAN_DIR, await getBoard()); broadcast("task.updated", updated); }
      await writeSessionMdx(sid, (await getBoard()).sessions[sid], updated, KANBAN_DIR, ctx.client);
      await writeBoardMdx(await getBoard(), KANBAN_DIR);
      broadcast("session.ended", { sessionId: sid, status: "done" });
      if (rec) {
        recordEvent(KANBAN_DIR, "agent.ended", {
          taskId: rec.taskId,
          author: "agent",
          summary: `agent ended (done) on '${task?.title ?? rec.taskId}'`,
          payload: { sessionId: sid, status: "done" },
        });
      }
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
        if (t) { t.state = "failed"; t.lastError = errMsg; t.updatedAt = nowIso(); }
      });
      const updated = (await getBoard()).tasks.find(t => t.id === rec.taskId);
      if (updated) { await writeTaskMdx(updated, KANBAN_DIR, await getBoard()); broadcast("task.updated", updated); }
      await writeSessionMdx(sid, (await getBoard()).sessions[sid], updated, KANBAN_DIR, ctx.client);
      await writeBoardMdx(await getBoard(), KANBAN_DIR);
      broadcast("session.ended", { sessionId: sid, status: "failed", error: errMsg });
      if (rec) {
        recordEvent(KANBAN_DIR, "agent.ended", {
          taskId: rec.taskId,
          author: "agent",
          summary: `agent ended (failed) on '${updated?.title ?? rec.taskId}'`,
          payload: { sessionId: sid, status: "failed", error: errMsg },
        });
      }
      break;
    }
    case "session.status": {
      if (sid) sessionStatusCache.set(sid, event.properties?.status ?? "unknown");
      break;
    }
    default: break;
  }
}

// ─── Server start (private helper) ──────────────────────────────────────────

async function _startServer(
  ctx: BoardContext,
  opts: { host?: string; port?: number; maxPortTries?: number; webRoot?: string },
  extraServerOpts?: { writePidFile?: boolean; lockFd?: number },
): Promise<{ server: HttpServer; port: number; hostname: string }> {
  const host = opts.host ?? "127.0.0.1";
  const basePort = opts.port ?? 7777;
  const maxTries = opts.maxPortTries ?? 10;
  const webRoot = opts.webRoot ?? join(ctx.directory, "..", "..", "web");

  let port = basePort;
  let server: HttpServer | null = null;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error & { code?: string }) => {
          server?.off("listening", onListening);
          reject(err);
        };
        const onListening = () => { server?.off("error", onError); resolve(); };
        server?.once("error", onError);
        server?.once("listening", onListening);
        server?.listen(port, host);
      });
      break;
    } catch (e) {
      if (e?.code === "EADDRINUSE" || String(e?.message).includes("EADDRINUSE")) {
        lastErr = e;
        server?.close();
        port++;
        continue;
      }
      throw e;
    }
  }

  if (!server) throw lastErr ?? new Error(`Could not bind server after ${maxTries} attempts`);
  return { server, port, hostname: host };
}

// ─── PID + lock helpers ──────────────────────────────────────────────────────

const PID_FILE = "server.pid";
const LOCK_FILE = "server.lock";

function readPidFile(dir: string): number | null {
  const pidPath = join(dir, PID_FILE);
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function writePidFile(dir: string, pid: number): void {
  const pidPath = join(dir, PID_FILE);
  writeFileSync(pidPath, String(pid), "utf-8");
}

function deletePidFile(dir: string): void {
  try {
    const pidPath = join(dir, PID_FILE);
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch { /* ignore */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeServer(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const res = await fetch(`http://${host}:${port}/api/board`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return false;
      const json = await res.json();
      return !!json.version; // basic validity check
    } catch {
      clearTimeout(timeout);
      return false;
    }
  } catch { return false; }
}

// ─── startOrAttach ───────────────────────────────────────────────────────────

export interface StartOrAttachResult {
  port: number;
  hostname: string;
  url: string;
  pid: number;
  isPrimary: boolean;
  broadcast(event: string, data: unknown): void;
  stop(): Promise<void>;
}

export async function startOrAttach(
  ctx: BoardContext,
  opts: { host?: string; port?: number; maxPortTries?: number; webRoot?: string; _autoDetect?: boolean } = {},
): Promise<StartOrAttachResult> {
  const host = opts.host ?? "127.0.0.1";
  const basePort = opts.port ?? 7777;
  const maxTries = opts.maxPortTries ?? 10;

  const dir = join(ctx.directory, ".ok");

  // 1. Check if existing server is alive
  const existingPid = readPidFile(dir);
  if (existingPid && isPidAlive(existingPid)) {
    const alive = await probeServer(host, basePort);
    if (alive) {
      // Attach to existing server (not primary)
      runningServer = {
        port: basePort,
        hostname: host,
        url: `http://${host}:${basePort}`,
        pid: existingPid,
        isPrimary: false,
        broadcast,
        async stop() { /* no-op: not the primary */ },
      };
      return runningServer;
    }
  }

  // 2. Try to acquire the lock. We use a "create-if-not-exists" file lock:
  //    writeFileSync with { flag: "wx" } fails if the file already exists.
  //    This is sufficient for local single-user, single-server operation;
  //    not race-free under heavy concurrent access (rare in practice), and
  //    a stale lock is auto-cleared on the next start if the PID is dead.
  //    On systems with `flock(2)` available, we layer it on top for safety.
  //    TODO: switch to flock(2) on Node versions that expose `node:fs.flock`.
  const lockPath = join(dir, LOCK_FILE);
  ensureDir(dir);
  let hasLock = false;
  let lockFd: number | null = null;

  try {
    // Clean up a stale lock from a dead PID.
    const existingPid = readPidFile(dir);
    if (!existingPid || !isPidAlive(existingPid)) {
      try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
    }

    lockFd = openSync(lockPath, "wx"); // "wx" = O_CREAT | O_EXCL, fails if exists
    hasLock = true;
  } catch {
    hasLock = false;
  }

  if (!hasLock) {
    // Could not acquire lock — wait and retry, then give up
    for (let retry = 0; retry < 10; retry++) {
      await new Promise(r => setTimeout(r, 200));
      const pid2 = readPidFile(dir);
      if (pid2 && isPidAlive(pid2)) {
        const alive = await probeServer(host, basePort);
        if (alive) {
          runningServer = {
            port: basePort, hostname: host,
            url: `http://${host}:${basePort}`, pid: pid2, isPrimary: false,
            broadcast,
            async stop() {},
          };
          return runningServer;
        }
      }
      // Re-attempt the lock; the holder may have died.
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
        lockFd = openSync(lockPath, "wx");
        hasLock = true;
        break;
      } catch {
        // still held
      }
    }
    if (!hasLock) {
      throw new Error("Could not acquire server lock; another process may be starting the server");
    }
  }

  // 3. We have the lock — bind the server
  const { server, port, hostname } = await _startServer(
    ctx,
    { ...opts, host, port: basePort, maxPortTries: maxTries },
    { writePidFile: true, lockFd: lockFd ?? undefined },
  );

  const pid = process.pid;
  writePidFile(dir, pid);
  // Resolve and cache webRoot so the request handler can serve static files.
  // Default: <project>/web (one level up from .ok).
  webRoot = opts.webRoot ?? join(ctx.directory, "web");

  // Set up HTTP request handler (full routing)
  server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const request = await toRequest(req);
      const response = await handleRequest(request);
      await writeResponse(res, response);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal server error";
      const response = requestErrorResponse(await toRequest(req), 500, message);
      await writeResponse(res, response);
    }
  });
  bizarSocketBridge?.close();
  bizarSocketBridge = attachBizarWebSocket(server, getActiveProjectRoot);
  claudeSocketBridge?.close();
  claudeSocketBridge = attachClaudeWebSocket(server, getActiveProjectRoot);

    runningServer = {
      port,
      hostname,
      url: `http://${hostname}:${port}`,
      pid,
      isPrimary: true,
      broadcast,
      async stop() {
        clearInterval(driftSweepInterval);
        bizarSocketBridge?.close();
        bizarSocketBridge = null;
        claudeSocketBridge?.close();
        claudeSocketBridge = null;
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        deletePidFile(dir);
        if (lockFd !== null) {
          try { closeSync(lockFd); } catch { /* ignore */ }
          try { unlinkSync(lockPath); } catch { /* ignore */ }
        }
        watcherHandle?.close();
        watcherHandle = null;
        runningServer = null;
      },
    };

  // ─── File watcher (SSE broadcaster) ───────────────────────────────────────
  // Watch the project root so we also catch changes to source files (e.g. docs/*.mdx)
  // that are tracked as task sources. Events from .ok subdirs are filtered out
  // to avoid the existing board.json / task.mdX event spam.
  const projectRoot = join(dir, "..");
  watcherHandle = watch({
    root: projectRoot,
    ignore: (p) =>
      /server\.(lock|log|pid)$/.test(p) ||
      p.endsWith(".tmp") ||
      p.replace(/\\/g, "/").includes("/.ok/"),
  });

  // Periodic drift sweep — every 60 s, re-check all source hashes.
  const driftSweepInterval = setInterval(() => {
    sweepSourceDrift(dir).catch(() => {/* ignore */});
  }, 60_000);

  (async () => {
    for await (const ev of watcherHandle.events) {
      // Skip events caused by server's own writes.
      if (Date.now() < selfWriteUntil) continue;

      // Check if this event matches any task's source.path → drift detection
      let driftedTaskId: string | null = null;
      {
        const board = await getBoard();
        for (const task of board.tasks) {
          if (!task.source) continue;
          const srcAbs = sourcePathOfTask(task, dir);
          if (srcAbs === ev.absPath) { driftedTaskId = task.id; break; }
        }
      }

      if (ev.path.endsWith("board.json") || ev.path.replace(/\\/g, "/").endsWith(".ok/board.json")) {
        broadcast("board.changed", { path: ev.path });
      } else if (ev.path.endsWith("changelog.jsonl")) {
        broadcast("changelog.appended", { path: ev.path });
      } else if (ev.path.includes("/tasks/") && ev.path.endsWith("task.mdx")) {
        const taskId = ev.path.match(/\/tasks\/([^/]+)\//)?.[1];
        if (taskId) broadcast("task.mdx.changed", { taskId, path: ev.path });
      } else if (ev.path.includes("/tasks/") && ev.path.endsWith("comments.json")) {
        const taskId = ev.path.match(/\/tasks\/([^/]+)\//)?.[1];
        if (taskId) broadcast("task.comment.added", { taskId });
      } else if (ev.path.includes("/tasks/") && ev.path.endsWith("inputs.json")) {
        const taskId = ev.path.match(/\/tasks\/([^/]+)\//)?.[1];
        if (taskId) broadcast("task.input.asked", { taskId });
      } else if (ev.path.includes("/tasks/") && ev.path.endsWith("state.json")) {
        const taskId = ev.path.match(/\/tasks\/([^/]+)\//)?.[1];
        if (taskId) broadcast("task.state.changed", { taskId });
      } else if (ev.path.match(/\/tasks\/([^/]+)\/images\//)) {
        const taskId = ev.path.match(/\/tasks\/([^/]+)\/images\//)?.[1];
        if (taskId) broadcast("task.image.changed", { taskId });
      } else if (driftedTaskId) {
        // A tracked source file changed — run drift check for the affected task
        const task = (await getBoard()).tasks.find(t => t.id === driftedTaskId);
        if (task) {
          const isStale = await checkSourceDrift(task, dir);
          if (isStale !== task.stale) {
            task.stale = isStale;
            task.lastSourceCheck = nowIso();
            await withWrite(async (b) => {
              const t2 = b.tasks.find(t => t.id === driftedTaskId);
              if (t2) { t2.stale = isStale; t2.lastSourceCheck = nowIso(); }
            });
            broadcast("task.updated", task);
            await writeTaskMdx(task, dir, await getBoard());
          }
        }
        broadcast("task.source-changed", { taskId: driftedTaskId, path: ev.path });
      } else {
        // Generic file-change event for any other watched files.
        broadcast("file.changed", { path: ev.path });
      }
    }
  })();

  ctx.log("info", `Kanban server started at ${runningServer.url} (primary)`);

  // Auto-detect projects in the background if no active project is set
  if (opts._autoDetect !== false && !activeProject()) {
    (async () => {
      try {
        const result = await autoDetectProjects();
        if (result.discovered.length) {
          ctx.log("info", `auto-detect: found ${result.discovered.length} new project(s): ${result.discovered.map(p => p.name).join(", ")}`);
        } else {
          ctx.log("info", "auto-detect: no new projects found");
        }
      } catch (e: any) {
        ctx.log("warn", `auto-detect failed: ${e?.message ?? e}`);
      }
    })();
  }

  return runningServer;
}

// ─── Public startServer (back-compat, delegates to startOrAttach) ─────────────

export function getServer(): RunningServer | null {
  return runningServer;
}

/** @deprecated Use startOrAttach instead. */
export async function startServer(
  ctx: BoardContext,
  opts: { host?: string; port?: number; maxPortTries?: number; webRoot?: string; _autoDetect?: boolean } = {},
): Promise<RunningServer> {
  return startOrAttach(ctx, opts) as Promise<RunningServer>;
}

// ─── Request router ──────────────────────────────────────────────────────────

/**
 * Attach a small WebSocket bridge to `ws://…/api/claude/ws`. Mirrors
 * `attachBizarWebSocket` (the legacy `/api/bizar/ws` endpoint) but sources
 * the snapshot and live updates from `kanban/claude-state.ts` so callers
 * no longer need the external `bizar` CLI. SSE on `/api/claude/events` is the
 * preferred transport; this bridge exists for clients that prefer WS.
 */
export function attachClaudeWebSocket(
  server: HttpServer,
  projectRoot: () => string,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });

  function send(socket: WebSocket, value: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }

  async function snapshot(socket: WebSocket): Promise<void> {
    try {
      const data = await claudeState.readSnapshot(projectRoot());
      send(socket, { type: "snapshot", data });
    } catch (error) {
      send(socket, { type: "error", error: (error as Error)?.message || String(error) });
    }
  }

  const upgrade = (req: IncomingMessage, socket: any, head: Buffer) => {
    let pathname = "";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { /* invalid */ }
    if (pathname !== "/api/claude/ws") return;
    if (!isLoopback(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  };
  server.on("upgrade", upgrade);

  wss.on("connection", (socket) => {
    void snapshot(socket);
    socket.on("message", (raw) => {
      let message: { type?: string; requestId?: string };
      try { message = JSON.parse(raw.toString()) as typeof message; }
      catch {
        send(socket, { type: "error", error: "Invalid JSON" });
        return;
      }
      if (message.type === "refresh") {
        void snapshot(socket);
        return;
      }
      send(socket, {
        type: "error",
        requestId: message.requestId,
        error: "Unknown message type",
      });
    });
  });

  const interval = setInterval(() => {
    if (wss.clients.size > 0) {
      for (const client of wss.clients) void snapshot(client);
    }
  }, 5_000);
  interval.unref?.();

  return {
    close() {
      clearInterval(interval);
      server.off("upgrade", upgrade);
      for (const client of wss.clients) client.close();
      wss.close();
    },
  };
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function handleRequest(req: Request): Promise<Response> {
  // Resolve and load the active project for this request. The board is cached
  // in process, so changing a directory alone would leak the previous
  // project's tasks into the selected project.
  const projectRoot = getActiveProjectRoot();
  await ensureBoardForProject(projectBoardContext(projectRoot));

  const url = new URL(req.url);
  const path = url.pathname;
  const rawFlag = url.searchParams.get("raw") === "1";

  // SSE
  if (path === "/api/events") {
    const stream = new ReadableStream({
      start(ctrl) { sseControllers.add(ctrl); ctrl.enqueue(new TextEncoder().encode("event: server.connected\ndata: {}\n\n")); },
      cancel(ctrl) { sseControllers.delete(ctrl); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
  }

  // Static: any file under webRoot with an allowed extension. webRoot
  // defaults to `<project>/web`; the caller can override. The whitelist
  // includes svg so the brand assets (logo, favicon, banners, empty-state
  // illustrations) can be served directly.
  if (path === "/" || /\.(html|css|js|json|md|txt|svg)$/.test(path)) {
    const root = webRoot ?? join(KANBAN_DIR, "..", "web");
    const pathForStatic = path === "/" ? "/index.html" : path;
    const sf = serveStatic(root, pathForStatic);
    if (sf) return new Response(sf.body, { headers: { "Content-Type": sf.contentType } });
    // If the explicit static match fails, fall through to other handlers (don't 404 here)
  }

  // GET /api/board
  if (path === "/api/board" && req.method === "GET") return apiGetBoard();

  if (path.startsWith("/api/bizar/")) {
    return handleBizarRequest(projectRoot, req, path);
  }

  if (path.startsWith("/api/claude/")) {
    return handleClaudeRequest(projectRoot, req, path);
  }

  if (path.startsWith("/api/chat/")) {
    return handleChatRequest(projectRoot, req, path);
  }

  // GET /api/goals — PRDs and their durable goals from .ok/prds.
  if (path === "/api/goals" && req.method === "GET") return apiGetGoals(projectRoot);
  const goalMatch = path.match(/^\/api\/goals\/(prd-[A-Za-z0-9_-]+)\/(g[0-9]+)$/);
  if (goalMatch && req.method === "PATCH") return apiPatchGoal(projectRoot, goalMatch[1], goalMatch[2], req);

  // GET /api/tasks-index
  if (path === "/api/tasks-index" && req.method === "GET") return apiGetTasksIndex(req);

  // GET /api/tags
  if (path === "/api/tags" && req.method === "GET") return apiGetTags();

  // GET /api/changelog
  if (path === "/api/changelog" && req.method === "GET") return apiGetChangelog(req);

  // GET /api/changelog/summary
  if (path === "/api/changelog/summary" && req.method === "GET") return apiGetChangelogSummary(req);

  // GET /api/insights/velocity
  if (path === "/api/insights/velocity" && req.method === "GET") return apiGetInsightsVelocity(req);

  // GET /api/contributors
  if (path === "/api/contributors" && req.method === "GET") return apiGetContributors(req);

  // GET /api/settings
  if (path === "/api/settings" && req.method === "GET") return apiGetSettings();

  // PATCH /api/settings
  if (path === "/api/settings" && req.method === "PATCH") return apiPatchSettings({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);

  // GET /api/config-sections
  if (path === "/api/config-sections" && req.method === "GET") return apiGetConfigSections();

  // PATCH /api/config-sections/:sectionId
  const configSectionMatch = path.match(/^\/api\/config-sections\/([^/]+)$/);
  if (configSectionMatch && req.method === "PATCH") {
    return apiPatchConfigSection({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, configSectionMatch[1], req);
  }

  // POST /api/organize
  if (path === "/api/organize" && req.method === "POST") return apiOrganize({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);

  // POST /api/import
  if (path === "/api/import" && req.method === "POST") return apiImport({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);

  // GET /api/search
  if (path === "/api/search" && req.method === "GET") return apiSearch(req);

  // POST /api/tasks/bulk
  if (path === "/api/tasks/bulk" && req.method === "POST") return apiBulk({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);

  // GET /api/template
  if (path === "/api/template" && req.method === "GET") return apiGetTemplate();

  // GET /api/tasks/:id
  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const [_, id] = taskMatch;
    if (req.method === "GET") return apiGetTask(id);
    if (req.method === "POST") return apiCreateTask({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);
    if (req.method === "PATCH") return apiUpdateTask({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, req);
    if (req.method === "DELETE") return apiDeleteTask({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id);
  }

  // POST /api/tasks/:id/archive
  const archiveMatch = path.match(/^\/api\/tasks\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    return apiArchiveTask({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, archiveMatch[1]);
  }

  // POST /api/tasks/:id/restore
  const restoreMatch = path.match(/^\/api\/tasks\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    return apiRestoreTask({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, restoreMatch[1]);
  }

  // GET /api/tasks/:id/contributors
  const contribMatch = path.match(/^\/api\/tasks\/([^/]+)\/contributors$/);
  if (contribMatch && req.method === "GET") {
    return apiGetTaskContributors({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, contribMatch[1]);
  }

  // GET /api/tasks/:id/subtasks
  const subtasksMatch = path.match(/^\/api\/tasks\/([^/]+)\/subtasks$/);
  if (subtasksMatch && req.method === "GET") {
    return apiGetSubtasks(subtasksMatch[1]);
  }

  // POST /api/tasks (legacy)
  if (path === "/api/tasks" && req.method === "POST") return apiCreateTask({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);

  // /api/tasks/:id/ask
  const askMatch = path.match(/^\/api\/tasks\/([^/]+)\/ask$/);
  if (askMatch && req.method === "POST") {
    const [_, id] = askMatch;
    return apiAskInput({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, req);
  }

  // POST /api/tasks/recheck-stale
  if (path === "/api/tasks/recheck-stale" && req.method === "POST") {
    return apiRecheckStale({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);
  }

  // /api/tasks/:id/respond
  const respondMatch = path.match(/^\/api\/tasks\/([^/]+)\/respond$/);
  if (respondMatch && req.method === "POST") {
    const [_, id] = respondMatch;
    return apiRespondInput({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, req);
  }

  // /api/tasks/:id/comments
  const commentsMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (commentsMatch) {
    const [_, id] = commentsMatch;
    if (req.method === "GET") return apiGetComments({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id);
    if (req.method === "POST") return apiAddComment({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, req);
  }

  // /api/tasks/:id/comments/:cid
  const commentMatch = path.match(/^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/);
  if (commentMatch) {
    const [_, id, cid] = commentMatch;
    if (req.method === "PATCH") return apiResolveComment({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, cid, req);
    if (req.method === "DELETE") return apiDeleteComment({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, cid);
  }

  // /api/tasks/:id/images
  const imgCollectionMatch = path.match(/^\/api\/tasks\/([^/]+)\/images$/);
  if (imgCollectionMatch) {
    const [_, id] = imgCollectionMatch;
    if (req.method === "GET") return apiListImages({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id);
    if (req.method === "POST") return apiUploadImage({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, req);
  }

  // /api/tasks/:id/images/:name
  const imgMatch = path.match(/^\/api\/tasks\/([^/]+)\/images\/([^/]+)$/);
  if (imgMatch) {
    const [_, id, name] = imgMatch;
    if (req.method === "GET") return apiGetImage({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, name);
    if (req.method === "DELETE") return apiDeleteImage({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, id, name);
  }

  // GET /api/me
  if (path === "/api/me" && req.method === "GET") {
    return apiGetMe({ directory: KANBAN_DIR, client: null as any, log: async () => {} });
  }

  // GET /api/project
  if (path === "/api/project" && req.method === "GET") {
    return apiGetProject();
  }

  // GET /api/projects
  if (path === "/api/projects" && req.method === "GET") {
    return apiGetProjects();
  }

  // POST /api/projects
  if (path === "/api/projects" && req.method === "POST") {
    return apiCreateProject(req);
  }

  // DELETE /api/projects/:id
  const deleteProjectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (deleteProjectMatch && req.method === "DELETE") {
    return apiDeleteProject(deleteProjectMatch[1]);
  }

  // POST /api/projects/auto-detect
  if (path === "/api/projects/auto-detect" && req.method === "POST") {
    return apiAutoDetectProjects(req);
  }

  // PATCH /api/projects/:id/active
  const activateProjectMatch = path.match(/^\/api\/projects\/([^/]+)\/active$/);
  if (activateProjectMatch && req.method === "PATCH") {
    return apiActivateProject(activateProjectMatch[1]);
  }

  // Docs workspace CRUD + configured-agent generation.
  if (path === "/api/docs/generate" && req.method === "POST") return apiGenerateDoc(req);
  if (path === "/api/docs/render" && req.method === "POST") return apiRenderDoc(req);
  const docListMatch = path.match(/^\/api\/docs\/?$/);
  if (docListMatch && req.method === "GET") return apiGetDocs();
  const docFileMatch = path.match(/^\/api\/docs\/(.+)$/);
  if (docFileMatch && req.method === "GET") return apiGetDoc(req, docFileMatch[1]);
  if (docFileMatch && req.method === "PUT") return apiWriteDoc(req, decodeURIComponent(docFileMatch[1]));
  if (docFileMatch && req.method === "DELETE") return apiDeleteDoc(decodeURIComponent(docFileMatch[1]));

  // GET /api/fs — browse filesystem
  if (path === "/api/fs" && req.method === "GET") return apiFs(req);

  // GET /api/home — user's home directory
  if (path === "/api/home" && req.method === "GET") return apiHome();

  // GET /api/parents — ancestor directories for breadcrumbs
  if (path === "/api/parents" && req.method === "GET") return apiParents(req);

  // /api/tasks/:id/mdx-rendered
  const mdxRenderedMatch = path.match(/^\/api\/tasks\/([^/]+)\/mdx-rendered$/);
  if (mdxRenderedMatch && req.method === "GET") {
    return apiGetMdxRendered(mdxRenderedMatch[1]);
  }

  // /api/tasks/:id/start | /abort
  const actionMatch = path.match(/^\/api\/tasks\/([^/]+)\/(start|abort)$/);
  if (actionMatch && req.method === "POST") {
    const [_, id, action] = actionMatch;
    if (action === "start") return apiStartTask(projectRoot, id, req);
    if (action === "abort") return apiAbortTask(projectRoot, id);
  }

  // /api/sessions/:sid/status
  const sessMatch = path.match(/^\/api\/sessions\/([^/]+)\/status$/);
  if (sessMatch && req.method === "GET") return apiSessionStatus(sessMatch[1]);

  // POST /api/preview
  if (path === "/api/preview" && req.method === "POST") return apiPreview(req);

  // Artifacts
  // Theme: ?theme=dark|light|system wins; otherwise script reads localStorage
  const themeParam = url.searchParams.get("theme") ?? undefined;
  const cspHeaders = {
    // unsafe-inline needed for the theme-init script and inline CSS vars
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  };

  if (path === "/artifacts/board") {
    try {
      const { body, contentType } = await renderArtifact(join(KANBAN_DIR, "board.mdx"), rawFlag, themeParam);
      return new Response(body, { headers: { "Content-Type": contentType, ...cspHeaders } });
    } catch (e) { const m = (e as any)?.message || "Render error"; return errorResponse(m, 500); }
  }

  const taskArtMatch = path.match(/^\/artifacts\/tasks\/([^/]+)$/);
  if (taskArtMatch) {
    const [_, id] = taskArtMatch;
    try {
      // Support both flat and per-task layout
      const flatPath = join(KANBAN_DIR, "tasks", `${id}.mdx`);
      const perPath = join(KANBAN_DIR, "tasks", id, "task.mdx");
      const mdxPath = existsSync(perPath) ? perPath : existsSync(flatPath) ? flatPath : null;
      if (!mdxPath) throw new Error(`Task artifact not found for ${id}`);
      const { body, contentType } = await renderArtifact(mdxPath, rawFlag, themeParam);
      return new Response(body, { headers: { "Content-Type": contentType, ...cspHeaders } });
    } catch (e) { const m = (e as any)?.message || "Render error"; return errorResponse(m, 500); }
  }

  const sessArtMatch = path.match(/^\/artifacts\/sessions\/([^/]+)$/);
  if (sessArtMatch) {
    const [_, sid] = sessArtMatch;
    try {
      const { body, contentType } = await renderArtifact(join(KANBAN_DIR, "sessions", `${sid}.mdx`), rawFlag, themeParam);
      return new Response(body, { headers: { "Content-Type": contentType, ...cspHeaders } });
    } catch (e) { const m = (e as any)?.message || "Render error"; return errorResponse(m, 500); }
  }

  return requestErrorResponse(req, 404, "Not found");
}

// ─── Event subscription ───────────────────────────────────────────────────────

export async function subscribeEvents(ctx: BoardContext, signal: AbortSignal): Promise<void> {
  if (!ctx.client?.event?.subscribe) return;
  try {
    for await (const event of ctx.client.event.subscribe({ signal })) {
      await handleEvent(ctx, event);
    }
  } catch (e: unknown) {
    if ((e as any)?.name === "AbortError" || signal.aborted) return;
    const errMsg = (e as any)?.message ?? String(e);
    ctx.log("error", "Event subscription error: " + errMsg);
  }
}
