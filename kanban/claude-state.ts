// OpenKan — native readers for Claude Code's filesystem state.
//
// These readers let OpenKan render the Bizar control plane without shelling
// out to the external `bizar` CLI. They walk `~/.claude/`, `~/.claude/skills/`,
// `~/.claude/commands/`, `~/.claude/hooks/`, and `~/.claude/projects/` to
// surface the same data shape the legacy `bizarJson(..., ["control",
// "snapshot", "--json"])` shim returned, with two differences:
//
// 1. Sources are read directly from disk; no subprocess is spawned.
// 2. Frontmatter is parsed with `gray-matter` so each field is a real value,
//    not a stringified blob.
//
// All readers are pure async functions with no module-level state except a
// module-private cursor map for `readActivityTail` so tail calls are
// incremental.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, sep } from "node:path";
import matter from "gray-matter";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Inline shape for the per-project activity ring buffer. Kept structurally
 * compatible with `kanban/agent-activity.ts` (which the UI consumes); when
 * that module lands on this branch, callers will import `ActivityEvent` from
 * there and this local alias can be deleted.
 */
export type ActivityKind =
  | "chat.turn-started"
  | "chat.turn-ended"
  | "chat.turn-aborted"
  | "chat.message-added"
  | "task.created"
  | "task.moved"
  | "task.commented"
  | "task.linked"
  | "task.deleted"
  | "agent.started"
  | "agent.ended"
  | "agent.queued";

export type ActivityStatus = "active" | "completed" | "aborted" | "errored" | "info";

export interface ActivityEvent {
  id: string;
  projectId: string;
  agentId: string;
  kind: ActivityKind;
  status: ActivityStatus;
  summary: string;
  taskId?: string;
  meta?: Record<string, unknown>;
  ts: string;
}

export interface AgentDef {
  /** Stable identifier derived from the frontmatter `name` (or the filename). */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Raw frontmatter keys (name, description, tools, model, etc.). */
  frontmatter: Record<string, unknown>;
  /** Markdown body without the YAML frontmatter. */
  body: string;
  /** Parsed `tools` array, if present. */
  tools: string[];
  /** Parsed `model` from frontmatter or router resolution. */
  model: string | null;
}

export interface SkillDef {
  id: string;
  path: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  /** `kind: workflow` marker if the skill represents a workflow. */
  kind: string | null;
}

export interface CommandDef {
  id: string;
  path: string;
  description: string;
  frontmatter: Record<string, unknown>;
  /** `workflow: true` marker if the command represents a workflow. */
  workflow: boolean;
}

export interface HookDef {
  /** Hook event name (UserPromptSubmit, PreToolUse, ...). */
  event: string;
  /** Optional matcher string. */
  matcher: string | null;
  /** Resolved command string (the inner hook command line). */
  command: string;
  /** Origin file path or "settings" for the inline settings.json entry. */
  source: string;
}

export interface ModelRouterDef {
  version: string | null;
  endpoint: string | null;
  models: string[];
  tierHints: Record<string, string>;
  policies: {
    mainOrchestrator: string | null;
    unknownAgent: string;
  };
  raw: Record<string, unknown>;
}

export interface TeamDef {
  name: string;
  members: string[];
  model: string | null;
}

export interface WorkflowDef {
  id: string;
  name: string;
  source: "skill" | "command";
  path: string;
  description: string;
  /** Lightweight phase list extracted from headings when present. */
  phases: string[];
}

export interface SnapshotPayload {
  agents: AgentDef[];
  skills: SkillDef[];
  commands: CommandDef[];
  hooks: HookDef[];
  modelRouter: ModelRouterDef;
  teams: TeamDef[];
  workflows: WorkflowDef[];
  projects: Array<{ id: string; root: string; sessionCount: number }>;
  serverTs: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHARED_DIR = `${sep}_shared${sep}`;

function listMarkdownFiles(rootDir: string, relPath: string): string[] {
  const dir = join(rootDir, ".claude", relPath);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md") || name.endsWith(".mdx"))
    .map((name) => join(dir, name));
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function isSharedPath(path: string): boolean {
  return path.includes(SHARED_DIR);
}

function parseFrontmatter(path: string): { frontmatter: Record<string, unknown>; body: string } {
  const raw = safeReadFile(path);
  if (raw === null) return { frontmatter: {}, body: "" };
  try {
    const parsed = matter(raw);
    const fm = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
    return { frontmatter: fm as Record<string, unknown>, body: parsed.content ?? "" };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export async function readAgents(rootDir: string): Promise<AgentDef[]> {
  const router = await readModelRouter(rootDir);
  const agentsDir = join(rootDir, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];

  const out: AgentDef[] = [];
  const stack: string[] = [agentsDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { stack.push(full); continue; }
      if (!st.isFile()) continue;
      if (!name.endsWith(".md")) continue;
      if (isSharedPath(full)) continue;
      const { frontmatter, body } = parseFrontmatter(full);
      const id = asString(frontmatter.name) || full.replace(agentsDir + sep, "").replace(/\.md$/, "");
      const tools = asStringArray(frontmatter.tools);
      const routerModel = router.tierHints[id];
      const model = asString(frontmatter.model) || (routerModel === "default" ? null : routerModel) || null;
      out.push({ id, path: full, frontmatter, body, tools, model });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ─── Skills ──────────────────────────────────────────────────────────────────

export async function readSkills(rootDir: string): Promise<SkillDef[]> {
  const skillsRoot = join(rootDir, ".claude", "skills");
  if (!existsSync(skillsRoot)) return [];

  const out: SkillDef[] = [];
  let entries: string[];
  try { entries = readdirSync(skillsRoot); } catch { return []; }
  for (const entry of entries) {
    const skillMd = join(skillsRoot, entry, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const { frontmatter, body } = parseFrontmatter(skillMd);
    const name = asString(frontmatter.name) || entry;
    const description = asString(frontmatter.description) || extractFirstHeading(body) || "";
    out.push({
      id: name,
      path: skillMd,
      name,
      description,
      frontmatter,
      kind: frontmatter.kind ? asString(frontmatter.kind) : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function extractFirstHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+?)$/m);
  return match ? match[1].trim() : null;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function readCommands(rootDir: string): Promise<CommandDef[]> {
  const files = listMarkdownFiles(rootDir, "commands");
  const out: CommandDef[] = [];
  for (const path of files) {
    const { frontmatter, body } = parseFrontmatter(path);
    const id = asString(frontmatter.name) || path.replace(/^.*\/commands\//, "").replace(/\.md$/, "");
    const description = asString(frontmatter.description) || extractFirstHeading(body) || "";
    const workflow = frontmatter.workflow === true;
    out.push({ id, path, description, frontmatter, workflow });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

interface RawHookEntry { type?: unknown; command?: unknown; }

function parseHooksObject(hooks: unknown, source: string, out: HookDef[]): void {
  if (!hooks || typeof hooks !== "object") return;
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcherEntry of matchers) {
      const matcher = matcherEntry && typeof matcherEntry === "object" && "matcher" in matcherEntry
        ? asString((matcherEntry as { matcher?: unknown }).matcher) || null
        : null;
      const inner = matcherEntry && typeof matcherEntry === "object" && "hooks" in matcherEntry
        ? (matcherEntry as { hooks?: RawHookEntry[] }).hooks
        : undefined;
      const list = Array.isArray(inner) ? inner : [matcherEntry as RawHookEntry];
      for (const h of list) {
        if (!h || typeof h !== "object") continue;
        const command = asString(h.command);
        if (!command) continue;
        out.push({ event, matcher, command, source });
      }
    }
  }
}

export async function readHooks(rootDir: string): Promise<HookDef[]> {
  const out: HookDef[] = [];

  const userSettings = join(rootDir, ".claude", "settings.json");
  if (existsSync(userSettings)) {
    const raw = safeReadFile(userSettings);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { hooks?: unknown };
        parseHooksObject(parsed.hooks, userSettings, out);
      } catch { /* swallow malformed settings.json */ }
    }
  }

  const projectSettings = join(rootDir, ".claude", "settings.json");
  if (projectSettings !== userSettings && existsSync(projectSettings)) {
    const raw = safeReadFile(projectSettings);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { hooks?: unknown };
        parseHooksObject(parsed.hooks, projectSettings, out);
      } catch { /* swallow */ }
    }
  }

  const hooksDir = join(rootDir, ".claude", "hooks");
  if (existsSync(hooksDir)) {
    let entries: string[];
    try { entries = readdirSync(hooksDir); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.endsWith(".mjs") && !entry.endsWith(".js") && !entry.endsWith(".sh")) continue;
      const full = join(hooksDir, entry);
      out.push({ event: "filesystem", matcher: null, command: full, source: full });
    }
  }

  return out;
}

// ─── Model router ────────────────────────────────────────────────────────────

const DEFAULT_ROUTER: ModelRouterDef = {
  version: null,
  endpoint: null,
  models: [],
  tierHints: {},
  policies: { mainOrchestrator: null, unknownAgent: "minimax/MiniMax-M3" },
  raw: {},
};

export async function readModelRouter(rootDir: string): Promise<ModelRouterDef> {
  const path = join(rootDir, ".claude", "model-router.json");
  if (!existsSync(path)) return DEFAULT_ROUTER;
  const raw = safeReadFile(path);
  if (!raw) return DEFAULT_ROUTER;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; }
  catch { return DEFAULT_ROUTER; }

  const userSelected = (parsed.userSelected && typeof parsed.userSelected === "object"
    ? parsed.userSelected as Record<string, unknown>
    : {});
  const models = Array.isArray(userSelected.models)
    ? userSelected.models.filter((m): m is string => typeof m === "string")
    : [];
  const tierHints = userSelected.tierHints && typeof userSelected.tierHints === "object"
    ? Object.fromEntries(
      Object.entries(userSelected.tierHints as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, v as string]),
    )
    : {};
  const policiesRaw = parsed.policies && typeof parsed.policies === "object"
    ? parsed.policies as Record<string, unknown>
    : {};
  const policies = {
    mainOrchestrator: typeof policiesRaw.mainOrchestrator === "string"
      ? policiesRaw.mainOrchestrator
      : null,
    unknownAgent: typeof policiesRaw.unknownAgent === "string"
      ? policiesRaw.unknownAgent
      : DEFAULT_ROUTER.policies.unknownAgent,
  };

  return {
    version: typeof parsed.version === "string" ? parsed.version : null,
    endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : null,
    models,
    tierHints,
    policies,
    raw: parsed,
  };
}

// ─── Teams ───────────────────────────────────────────────────────────────────

const TEAM_KEYWORDS = [/\bteam\b/i, /\borchestrator\b/i, /\bcoordinator\b/i];

function isTeamish(description: string): boolean {
  return TEAM_KEYWORDS.some((re) => re.test(description));
}

export async function readTeams(rootDir: string): Promise<TeamDef[]> {
  const agents = await readAgents(rootDir);
  const router = await readModelRouter(rootDir);
  const mainOrchestrator = router.policies.mainOrchestrator;

  const teamAgents = agents.filter((a) => {
    const desc = asString(a.frontmatter.description);
    return isTeamish(desc);
  });

  const teams: TeamDef[] = [];

  if (mainOrchestrator) {
    const orchestrator = agents.find((a) => a.id === mainOrchestrator);
    const members = teamAgents
      .filter((a) => a.id !== mainOrchestrator)
      .map((a) => a.id);
    if (orchestrator) members.unshift(orchestrator.id);
    teams.push({
      name: mainOrchestrator,
      members,
      model: orchestrator?.model ?? null,
    });
  }

  // Group remaining team-keyword agents under an "ad-hoc" team if any exist
  // that weren't already assigned to the main orchestrator.
  const assigned = new Set(teams.flatMap((t) => t.members));
  const remaining = teamAgents.filter((a) => !assigned.has(a.id));
  if (remaining.length > 0) {
    teams.push({
      name: "ad-hoc",
      members: remaining.map((a) => a.id).sort(),
      model: remaining[0]?.model ?? null,
    });
  }

  return teams;
}

// ─── Workflows ───────────────────────────────────────────────────────────────

function extractPhases(body: string): string[] {
  // Match either explicit "## Phase: X" or "## Phase X" headings, or "1.", "2." numbered list items.
  const headingPhases: string[] = [];
  const headingRe = /^##\s+(?:Phase(?:\s+|:)?\s*)(.+?)$/gim;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    headingPhases.push(m[1].trim());
  }
  if (headingPhases.length > 0) return headingPhases;
  const listRe = /^\d+\.\s+(.+?)$/gm;
  const items: string[] = [];
  while ((m = listRe.exec(body)) !== null) items.push(m[1].trim());
  return items;
}

export async function readWorkflows(rootDir: string): Promise<WorkflowDef[]> {
  const out: WorkflowDef[] = [];
  const skills = await readSkills(rootDir);
  for (const skill of skills) {
    if (skill.kind !== "workflow") continue;
    const { body } = parseFrontmatter(skill.path);
    out.push({
      id: skill.id,
      name: skill.name,
      source: "skill",
      path: skill.path,
      description: skill.description,
      phases: extractPhases(body),
    });
  }
  const commands = await readCommands(rootDir);
  for (const cmd of commands) {
    if (!cmd.workflow) continue;
    const { body } = parseFrontmatter(cmd.path);
    out.push({
      id: cmd.id,
      name: cmd.id,
      source: "command",
      path: cmd.path,
      description: cmd.description,
      phases: extractPhases(body),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ─── Activity tail ───────────────────────────────────────────────────────────

interface CursorKey { projectRoot: string; filePath: string; }
type CursorMap = Map<string, { offset: number; mtime: number }>;

const tailCursors: CursorMap = (() => {
  const m = new Map<string, { offset: number; mtime: number }>();
  return m;
})();

function cursorKey(rootDir: string, file: string): string {
  return `${rootDir}::${file}`;
}

interface JsonlRow {
  type?: string;
  timestamp?: string;
  agent?: string;
  agentName?: string;
  sessionId?: string;
  message?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

function mapRowToActivity(row: JsonlRow, fallbackAgent: string, sessionId: string): ActivityEvent | null {
  const kind = typeof row.type === "string" ? row.type : null;
  if (!kind) return null;
  const ts = typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString();
  const agentId = typeof row.agentName === "string"
    ? row.agentName
    : typeof row.agent === "string"
      ? row.agent
      : fallbackAgent;
  const summary = typeof row.message === "string"
    ? row.message
    : typeof row.payload === "object" && row.payload && "summary" in row.payload && typeof (row.payload as { summary?: unknown }).summary === "string"
      ? (row.payload as { summary: string }).summary
      : kind;
  const meta: Record<string, unknown> = { sessionId };
  if (row.payload && typeof row.payload === "object") {
    Object.assign(meta, row.payload as Record<string, unknown>);
  }
  // The ActivityEvent.activityKind allowlist is strict; unknown row types are
  // mapped to "agent.queued" so the UI still shows them, but the original
  // `kind` is preserved in `meta`.
  const allowed: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
    "chat.turn-started",
    "chat.turn-ended",
    "chat.turn-aborted",
    "chat.message-added",
    "task.created",
    "task.moved",
    "task.commented",
    "task.linked",
    "task.deleted",
    "agent.started",
    "agent.ended",
    "agent.queued",
  ]);
  const mappedKind: ActivityKind = allowed.has(kind as ActivityKind)
    ? kind as ActivityKind
    : "agent.queued";
  meta.originalKind = kind;
  return {
    id: `${ts}-${agentId}-${kind}`,
    projectId: sessionId,
    agentId,
    kind: mappedKind,
    status: "info",
    summary,
    meta,
    ts,
  };
}

function listSessionFiles(rootDir: string): { path: string; sessionId: string }[] {
  const projectsDir = join(rootDir, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  let dirs: string[];
  try { dirs = readdirSync(projectsDir); } catch { return []; }
  const out: { path: string; sessionId: string }[] = [];
  for (const dir of dirs) {
    const subdir = join(projectsDir, dir);
    let st;
    try { st = statSync(subdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const sub = join(subdir, "subagents");
    if (!existsSync(sub)) continue;
    let files: string[];
    try { files = readdirSync(sub); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
      out.push({ path: join(sub, f), sessionId: dir });
    }
  }
  return out;
}

function tailJsonl(
  cursor: { offset: number; mtime: number } | undefined,
  path: string,
  rootDir: string,
  fallbackAgent: string,
  sessionId: string,
  out: ActivityEvent[],
): { offset: number; mtime: number } {
  let st;
  try { st = statSync(path); } catch { return cursor ?? { offset: 0, mtime: 0 }; }
  const key = cursorKey(rootDir, path);
  let startOffset = cursor?.offset ?? 0;
  // Reset cursor if file shrank (rotation/truncation)
  if (cursor && st.size < cursor.offset) startOffset = 0;
  // Reset cursor if mtime went backwards
  if (cursor && st.mtimeMs < cursor.mtime) startOffset = 0;
  const fd = (() => {
    try { return readFileSync(path, { encoding: "utf-8" }); }
    catch { return null; }
  })();
  if (fd === null) return cursor ?? { offset: 0, mtime: 0 };
  // Slice from offset
  const slice = fd.slice(startOffset);
  for (const line of slice.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as JsonlRow;
      const ev = mapRowToActivity(row, fallbackAgent, sessionId);
      if (ev) out.push(ev);
    } catch { /* skip malformed line */ }
  }
  const next = { offset: st.size, mtime: st.mtimeMs };
  tailCursors.set(key, next);
  return next;
}

export async function readActivityTail(rootDir: string, sinceMs?: number): Promise<ActivityEvent[]> {
  const files = listSessionFiles(rootDir);
  const events: ActivityEvent[] = [];
  for (const f of files) {
    const cursor = tailCursors.get(cursorKey(rootDir, f.path));
    const fallbackAgent = f.path.split(sep).pop() ?? "agent";
    tailJsonl(cursor, f.path, rootDir, fallbackAgent, f.sessionId, events);
  }
  if (sinceMs !== undefined) {
    const cutoff = new Date(sinceMs).getTime();
    return events.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) ? t > cutoff : true;
    });
  }
  return events;
}

/** Test helper: reset all tail cursors. */
export function resetActivityTail(): void {
  tailCursors.clear();
}

// ─── In-memory activity ring buffer ─────────────────────────────────────────

const RING_MAX = 200;
const ringBuffer: ActivityEvent[] = [];
const ringListeners = new Set<(events: ActivityEvent[]) => void>();

/**
 * Append an event to the bounded ring buffer. Oldest events are evicted once
 * the buffer exceeds `RING_MAX` entries. Listeners are notified after the
 * write so SSE/WS subscribers can broadcast the new rows.
 *
 * Mirrors `recordEvent` in `kanban/agent-activity.ts`; when that file lands
 * on this branch the orchestrator will reconcile the duplicate.
 */
export function recordEvent(event: ActivityEvent): void {
  ringBuffer.push(event);
  while (ringBuffer.length > RING_MAX) ringBuffer.shift();
  for (const fn of ringListeners) {
    try { fn([event]); } catch { /* ignore listener errors */ }
  }
}

/** Read the most-recent ring buffer entries, newest first. */
export function readEvents(limit = RING_MAX): ActivityEvent[] {
  const out = ringBuffer.slice(-limit);
  return out.reverse();
}

/** Subscribe to live updates; returns an unsubscribe handle. */
export function subscribe(fn: (events: ActivityEvent[]) => void): () => boolean {
  ringListeners.add(fn);
  return ringListeners.delete.bind(ringListeners, fn);
}

/** Test helper: clear the entire ring buffer. */
export function resetActivityRing(): void {
  ringBuffer.length = 0;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

function listProjectSessions(rootDir: string): Array<{ id: string; root: string; sessionCount: number }> {
  const projectsDir = join(rootDir, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  let dirs: string[];
  try { dirs = readdirSync(projectsDir); } catch { return []; }
  return dirs.map((d) => {
    const subdir = join(projectsDir, d);
    let count = 0;
    try { count = readdirSync(subdir).filter((f) => f.endsWith(".jsonl")).length; }
    catch { count = 0; }
    return { id: d, root: subdir, sessionCount: count };
  });
}

export async function readSnapshot(rootDir: string): Promise<SnapshotPayload> {
  const [agents, skills, commands, hooks, modelRouter, teams, workflows] = await Promise.all([
    readAgents(rootDir),
    readSkills(rootDir),
    readCommands(rootDir),
    readHooks(rootDir),
    readModelRouter(rootDir),
    readTeams(rootDir),
    readWorkflows(rootDir),
  ]);
  return {
    agents,
    skills,
    commands,
    hooks,
    modelRouter,
    teams,
    workflows,
    projects: listProjectSessions(rootDir),
    serverTs: new Date().toISOString(),
  };
}

// ─── HTTP request handler ───────────────────────────────────────────────────

/** Allowed values for `ActivityKind`. Mirrors the union at the top of this file. */
const ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "chat.turn-started",
  "chat.turn-ended",
  "chat.turn-aborted",
  "chat.message-added",
  "task.created",
  "task.moved",
  "task.commented",
  "task.linked",
  "task.deleted",
  "agent.started",
  "agent.ended",
  "agent.queued",
]);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function asStringBounded(value: unknown, max = 1024): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  return value;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  // Disable proxy buffering so events flush promptly through localhost proxies.
  "X-Accel-Buffering": "no",
};

/**
 * Route dispatcher for `/api/claude/*`. Mirrors the shape of `handleBizarRequest`
 * in `kanban/bizar.ts`. The `rootDir` argument is the user's home directory —
 * readers always look under `<rootDir>/.claude/...`.
 */
export async function handleClaudeRequest(
  rootDir: string,
  req: Request,
  path: string,
): Promise<Response> {
  const url = new URL(req.url);
  const relayEnabled = process.env.CLAUDE_OPENKAN_RELAY === "1";

  try {
    if (req.method === "GET") {
      if (path === "/api/claude/snapshot") {
        const payload = await readSnapshot(rootDir);
        return json(payload);
      }
      if (path === "/api/claude/agents") return json({ agents: await readAgents(rootDir) });
      if (path === "/api/claude/skills") return json({ skills: await readSkills(rootDir) });
      if (path === "/api/claude/commands") return json({ commands: await readCommands(rootDir) });
      if (path === "/api/claude/hooks") return json({ hooks: await readHooks(rootDir) });
      if (path === "/api/claude/teams") return json({ teams: await readTeams(rootDir) });
      if (path === "/api/claude/workflows") return json({ workflows: await readWorkflows(rootDir) });
      if (path === "/api/claude/model-router") return json(await readModelRouter(rootDir));
      if (path === "/api/claude/activity") {
        const since = url.searchParams.get("since");
        const sinceMs = since ? Date.parse(since) : undefined;
        return json({ events: await readActivityTail(rootDir, Number.isFinite(sinceMs) ? sinceMs : undefined) });
      }
      if (path === "/api/claude/ring") return json({ events: readEvents() });
      if (path === "/api/claude/relay-status") {
        return json({ enabled: relayEnabled });
      }
      if (path === "/api/claude/events") return handleClaudeSse(rootDir);
      return err("Not found", 404);
    }

    if (req.method === "POST" && path === "/api/claude/events") {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
      const event = asStringBounded(body.event, 128);
      const sessionId = asStringBounded(body.sessionId, 128);
      const ts = asStringBounded(body.ts, 64);
      if (!event) return err("event is required", 422);
      if (!sessionId) return err("sessionId is required", 422);
      if (!ts) return err("ts is required", 422);
      const kind: ActivityKind = ACTIVITY_KINDS.has(event as ActivityKind)
        ? event as ActivityKind
        : "agent.queued";
      const payload = body.payload && typeof body.payload === "object"
        ? body.payload as Record<string, unknown>
        : {};
      const summary = typeof payload.summary === "string"
        ? payload.summary
        : event;
      const agentId = typeof payload.agent === "string" ? payload.agent : "@user";
      const record: ActivityEvent = {
        id: `${ts}-${agentId}-${event}`,
        projectId: sessionId,
        agentId,
        kind,
        status: "info",
        summary,
        meta: { ...payload, relaySessionId: sessionId, ...(kind === "agent.queued" && event !== "agent.queued" ? { originalKind: event } : {}) },
        ts,
      };
      recordEvent(record);
      return json({ ok: true });
    }

    return err("Not found", 404);
  } catch (e) {
    const message = (e as Error)?.message || String(e);
    return err(message, 500);
  }
}

const TAIL_POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

function handleClaudeSse(rootDir: string): Response {
  const encoder = new TextEncoder();
  // Track the high-water mark (ms) we've already emitted so we only push
  // truly-new rows on each poll tick.
  let lastSeenMs = Date.now();
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => boolean) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); }
        catch { closed = true; }
      };
      safeEnqueue(": connected\n\n");

      const flush = async () => {
        if (closed) return;
        try {
          const sinceMs = lastSeenMs;
          const fresh = await readActivityTail(rootDir, sinceMs);
          if (fresh.length > 0) {
            lastSeenMs = Math.max(
              sinceMs,
              ...fresh
                .map((e) => Date.parse(e.ts))
                .filter((t) => Number.isFinite(t)),
            );
            safeEnqueue(`event: activity\ndata: ${JSON.stringify({ events: fresh })}\n\n`);
          }
          const ring = readEvents();
          if (ring.length > 0) {
            safeEnqueue(`event: ring\ndata: ${JSON.stringify({ events: ring })}\n\n`);
          }
        } catch { /* swallow poll errors */ }
      };

      // Push any events that arrived via the relay hook since server start.
      unsubscribe = subscribe((events) => {
        if (closed) return;
        try {
          safeEnqueue(`event: ring\ndata: ${JSON.stringify({ events })}\n\n`);
        } catch { /* ignore */ }
      });

      // Initial flush, then poll on TAIL_POLL_MS cadence.
      await flush();
      pollTimer = setInterval(() => { void flush(); }, TAIL_POLL_MS);
      pollTimer.unref?.();
      heartbeatTimer = setInterval(() => safeEnqueue(": heartbeat\n\n"), HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } }
      pollTimer = null;
      heartbeatTimer = null;
      unsubscribe = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
