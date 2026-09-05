// OpenKan — chat sidebar backend.
//
// This module powers the right-rail chat orchestrator. It owns:
//   1. JSONL session storage under `.ok/sessions/<sid>.jsonl`
//   2. A subprocess wrapper that spawns `claude -p --output-format stream-json
//      --verbose` per user turn, parses the line-delimited JSON event stream,
//      and tracks running PIDs in-memory so an abort request can kill the
//      process.
//   3. An HTTP dispatcher (`handleChatRequest`) registered at `/api/chat/*`.
//
// Design choices:
//   - One process per turn (stateless, no daemon). CLI flags `--model`,
//     `--effort`, `--permission-mode` carry the selector values straight
//     through to the Claude Code binary on $PATH (or $CLAUDE_BIN).
//     `--output-format stream-json --verbose` makes Claude Code emit line-
//     delimited JSON events on stdout, which gives the sidebar real-time
//     visibility into tool calls and incremental text.
//   - SSE for live turn events. Two channels:
//       /api/chat/events                       — every event in the project
//       /api/chat/sessions/<sid>/events        — events scoped to a session
//     Both emit typed events (`text_delta`, `tool_use`, `tool_input_delta`,
//     `tool_result`, `message_done`, `chat.turn`).
//   - All persistence is local: `.ok/sessions/` is gitignored already, so
//     user/assistant transcripts never leak into commits.

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ensureDir, writeFileAtomic } from "./io.ts";
import { readAgents, readModelRouter } from "./claude-state.ts";

import { OPENKAN_AGENT_ID, openkanAgentDefinition } from "./agent-profile.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single turn in a chat session. One JSON object per line in JSONL. */
export interface ChatTurn {
  ts: string;            // ISO timestamp
  role: "user" | "assistant" | "system";
  content: string;
  agent?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  messageId?: string;
  /** Set when this turn was truncated or replaced by an error. */
  status?: "ok" | "error" | "aborted";
  /** Optional free-form error message attached to a system turn. */
  error?: string;
  /**
   * Ordered tool-use blocks produced by the assistant during this turn.
   * Absent on legacy turns written before streaming was added; the
   * reader treats `undefined` as an empty array.
   */
  toolUses?: ToolUseRecord[];
  /** Wall-clock time spent generating this assistant turn. */
  durationMs?: number;
  /** Provider-visible reasoning summary, when the selected CLI exposes one. */
  reasoning?: string;
  /** Task references carried with a user turn without polluting the message text. */
  taskMentions?: ChatTaskMention[];
}

/** Persisted shape of a single tool-use block. */
export interface ToolUseRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "started" | "streaming" | "completed" | "failed" | "aborted";
  /** Truncated preview of the tool result, when known. */
  resultPreview?: string;
  /** True when the tool call returned an error result. */
  isError?: boolean;
  /** Forwarded tool work performed by a Claude Code subagent. */
  source?: "subagent";
  /** Parent Agent tool-use id when `source` is `subagent`. */
  parentToolUseId?: string;
  /** Internal chronological ordering key for persisted activity. */
  sequence?: number;
}

/** Live state held while a turn is in flight, mutated by the stream parser. */
interface TurnState {
  textByBlock: Map<number, string>;
  reasoningByBlock: Map<number, string>;
  toolUses: Map<number, ToolUseRecord>;
  /** tool_use_id -> index in `toolUses` so we can attach results. */
  toolIndexById: Map<string, number>;
  toolResults: Map<string, { content: string; isError: boolean }>;
  /** Tool work reported from forwarded Claude Code subagent streams. */
  subagentToolUses: Map<string, ToolUseRecord>;
  /** Monotonic ordering across parent and subagent tool calls. */
  toolSequence: number;
  /** The most recent `message_delta` stop reason. */
  stopReason: string | null;
}

/** Where a `ChatSessionSummary` originated. `openkan` is the native backend;
 *  `claude-code` was discovered in `~/.claude/projects/<encoded>/` (the file
 *  is still on disk and can be continued); `history-fallback` was found in
 *  `~/.claude/history.jsonl` only — the underlying JSONL is gone, so the
 *  session cannot be continued. */
export type ChatSessionSource = "openkan" | "claude-code" | "history-fallback";

/** Lightweight metadata about a session, returned by listSessions. */
export interface ChatSessionSummary {
  id: string;
  title: string;           // first user message, truncated to 80 chars
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  createdAt: string;       // ISO timestamp of first turn
  lastActivity: string;    // ISO timestamp of latest turn
  turnCount: number;
  archived: boolean;
  /** Provenance of this summary. `openkan` for native sessions; see
   *  `ChatSessionSource` for the other two external cases. */
  readonly source: ChatSessionSource;
}

/** Selector values submitted with a chat message. */
export interface ChatSelectors {
  agent?: string;
  model: string;
  effort: string;
  permissionMode: string;
}

export interface ChatTaskMention {
  id: string;
  title: string;
}

/** Input to sendTurn. */
export interface SendTurnOptions extends ChatSelectors {
  sessionId?: string;
  /** Full private prompt sent to Claude Code. */
  message: string;
  /** Message text rendered and persisted in the user-facing transcript. */
  displayMessage?: string;
  /** Compact task context rendered as a banner rather than prompt text. */
  taskMentions?: ChatTaskMention[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  claudeBin?: string;
  /** Callback invoked for each parsed event and the non-duplicated effect it had. */
  onStreamEvent?: (event: StreamEvent, applied: StreamApplyResult) => void;
  signal?: AbortSignal;
}

/** Result returned by sendTurn. */
export interface SendTurnResult {
  sessionId: string;
  userTurn: ChatTurn;
  assistantTurn: ChatTurn;
}

// ─── Stream event types ──────────────────────────────────────────────────────

/**
 * Subset of the Claude Code `--output-format stream-json` envelope we care
 * about. Anything we don't recognise is passed through with `type` left
 * intact and `raw` carrying the original payload so we never lose data.
 */
export interface StreamEvent {
  type: string;
  index?: number;
  /**
   * Present on messages forwarded from Claude Code subagents. This is the
   * parent Agent tool-use id, so the UI can reconstruct the native agent
   * tree without confusing a child transcript with the parent reply.
   */
  parentToolUseId?: string;
  /** Convenience copy of `event.content_block` when present. */
  contentBlock?: {
    type: "text" | "thinking" | "tool_use" | "tool_result";
    id?: string;
    name?: string;
    tool_use_id?: string;
    input?: Record<string, unknown>;
    content?: string | Array<{ type: string; text?: string }>;
    text?: string;
  };
  /** Convenience copy of `event.delta` when present. */
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  /** Original payload from the stream (untouched). */
  raw: Record<string, unknown>;
}

// ─── Tool-use label mapper ───────────────────────────────────────────────────

/** Truncate a string to `max` chars with an ellipsis suffix. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/** Read a possibly-nested string field from an arbitrary input map. */
function inputString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

/**
 * Map a tool call to a short human-readable label, e.g. `Read`,
 * `Write`, `Bash`. Truncates long arguments so the chip width fits
 * the label without overflowing.
 */
export function toolUseLabel(toolUse: ToolUseRecord): string {
  const input = toolUse.input ?? {};
  switch (toolUse.name) {
    case "Read":
      return `Reading ${basename(inputString(input, "file_path")) || "file"}`;
    case "Write":
      return `Writing ${basename(inputString(input, "file_path")) || "file"}`;
    case "Edit": {
      const file = inputString(input, "file_path");
      return `Editing ${basename(file) || "file"}`;
    }
    case "Bash":
      return `Running ${truncate(inputString(input, "command").replace(/\s+/g, " ").trim(), 60)}`;
    case "Grep":
      return `Searching for "${truncate(inputString(input, "query") || inputString(input, "pattern"), 40)}"`;
    case "Glob":
      return `Finding ${truncate(inputString(input, "pattern"), 60)}`;
    case "WebFetch":
      return `Fetching ${truncate(inputString(input, "url"), 60)}`;
    case "WebSearch":
      return `Searching the web for "${truncate(inputString(input, "query"), 40)}"`;
    case "Agent":
    case "Task":
      return `Delegating to ${inputString(input, "subagent_type") || "subagent"}`;
    default:
      return `Using ${toolUse.name}`;
  }
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const SESSIONS_SUBDIR = "sessions";
const ARCHIVED_SUBDIR = ".archived";
const SESSION_EXT = ".jsonl";

/** Resolve the active sessions dir under `<projectRoot>/.ok/sessions`. */
export function sessionsDir(projectRoot: string): string {
  return join(projectRoot, ".ok", SESSIONS_SUBDIR);
}

/** Resolve the archived sessions dir. */
export function archivedSessionsDir(projectRoot: string): string {
  return join(sessionsDir(projectRoot), ARCHIVED_SUBDIR);
}

function sessionPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}${SESSION_EXT}`);
}

function archivedSessionPath(projectRoot: string, sessionId: string): string {
  return join(archivedSessionsDir(projectRoot), `${sessionId}${SESSION_EXT}`);
}

function ensureSessionsDirs(projectRoot: string): void {
  ensureDir(sessionsDir(projectRoot));
  ensureDir(archivedSessionsDir(projectRoot));
}

// ─── ID helpers ──────────────────────────────────────────────────────────────

/** Generate a unique session id (`ses-<uuid>`). */
export function generateSessionId(): string {
  return `ses-${randomUUID()}`;
}

function newMessageId(): string {
  return `msg-${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── JSONL parsing ───────────────────────────────────────────────────────────

/**
 * Parse a JSONL file into an array of turns. Empty lines and unparseable
 * rows are silently skipped (matches `changelog.ts:parseLine` behaviour but
 * without the stderr warning — chat history is rebuilt incrementally and
 * one bad row should not break a session).
 */
function parseJsonl(raw: string): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as ChatTurn;
      if (obj && typeof obj === "object" && typeof obj.role === "string") {
        // Backwards-compat: legacy turns were written before `toolUses`
        // existed. Normalise absent → empty array so downstream code can
        // safely iterate without checking for `undefined`.
        if (obj.toolUses === undefined) obj.toolUses = [];
        out.push(obj);
      }
    } catch {
      /* skip unparseable row */
    }
  }
  return out;
}

function readTurnsFile(path: string): ChatTurn[] {
  if (!existsSync(path)) return [];
  try {
    return parseJsonl(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Append a turn to the session JSONL file. Atomic on first write. */
export function appendTurn(
  projectRoot: string,
  sessionId: string,
  turn: ChatTurn,
): void {
  ensureSessionsDirs(projectRoot);
  const path = sessionPath(projectRoot, sessionId);
  const line = JSON.stringify(turn) + "\n";
  if (!existsSync(path)) {
    writeFileAtomic(path, line);
  } else {
    appendFileSync(path, line, "utf-8");
  }
}

/** Read every turn for a session, looking in active and archived dirs. */
export function readSession(
  projectRoot: string,
  sessionId: string,
): ChatTurn[] {
  const active = sessionPath(projectRoot, sessionId);
  if (existsSync(active)) return readTurnsFile(active);
  const archived = archivedSessionPath(projectRoot, sessionId);
  if (existsSync(archived)) return readTurnsFile(archived);
  return [];
}

/** True when the session is in the active dir. */
export function isSessionActive(projectRoot: string, sessionId: string): boolean {
  return existsSync(sessionPath(projectRoot, sessionId));
}

/** True when the session has been archived. */
export function isSessionArchived(projectRoot: string, sessionId: string): boolean {
  return existsSync(archivedSessionPath(projectRoot, sessionId));
}

/**
 * Derive a session summary from the transcript. The title is the first user
 * message truncated to 80 chars.
 */
export function summariseSession(
  sessionId: string,
  turns: ChatTurn[],
  archived: boolean,
): ChatSessionSummary {
  const firstUser = turns.find((t) => t.role === "user");
  const last = turns[turns.length - 1];
  const titleRaw = firstUser?.content?.trim() ?? "(empty session)";
  const title = titleRaw.length > 80 ? titleRaw.slice(0, 79) + "…" : titleRaw;
  const selectorTurn = turns.find((t) => t.role === "assistant" && t.model) ?? firstUser;
  return {
    id: sessionId,
    title,
    model: selectorTurn?.model ?? null,
    effort: selectorTurn?.effort ?? null,
    permissionMode: selectorTurn?.permissionMode ?? null,
    createdAt: turns[0]?.ts ?? nowIso(),
    lastActivity: last?.ts ?? turns[0]?.ts ?? nowIso(),
    turnCount: turns.length,
    archived,
    source: "openkan",
  };
}

/** List every session (active first, then archived) in last-activity order. */
export function listSessions(projectRoot: string): ChatSessionSummary[] {
  const summaries: ChatSessionSummary[] = [];
  if (!existsSync(sessionsDir(projectRoot))) return summaries;
  const activeEntries = readdirSync(sessionsDir(projectRoot))
    .filter((f) => f.endsWith(SESSION_EXT));
  for (const file of activeEntries) {
    const id = file.slice(0, -SESSION_EXT.length);
    if (id.startsWith(".")) continue; // skip hidden (e.g. .archived marker)
    const turns = readTurnsFile(sessionPath(projectRoot, id));
    summaries.push(summariseSession(id, turns, false));
  }
  const archivedDir = archivedSessionsDir(projectRoot);
  if (existsSync(archivedDir)) {
    const archivedEntries = readdirSync(archivedDir)
      .filter((f) => f.endsWith(SESSION_EXT));
    for (const file of archivedEntries) {
      const id = file.slice(0, -SESSION_EXT.length);
      if (id.startsWith(".")) continue;
      const turns = readTurnsFile(archivedSessionPath(projectRoot, id));
      summaries.push(summariseSession(id, turns, true));
    }
  }
  // Sort by lastActivity desc. Active before archived ties are not guaranteed
  // (the caller can filter); we sort by timestamp only and rely on the UI to
  // group them.
  summaries.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return summaries;
}

// ─── External Claude Code session discovery ──────────────────────────────────
//
// Claude Code writes every CLI session transcript to
// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` where `<encoded-cwd>`
// is the absolute cwd with `/` replaced by `-`. A global metadata file at
// `~/.claude/history.jsonl` records `{display, pastedContents, timestamp,
// project, sessionId}` for every past chat, even after the JSONL transcript
// itself is cleaned up. The two sources are merged: the JSONL wins when both
// exist (rich metadata), and `history.jsonl` provides `history-fallback`
// summaries for sessions whose transcripts are gone.

/** Maximum bytes from the start of a JSONL file used to derive the title. */
const DISCOVERY_HEAD_BYTES = 4096;
/** Maximum bytes from the end of a JSONL file used to derive lastActivity. */
const DISCOVERY_TAIL_BYTES = 2048;
/** Hard cap on discovered sessions returned by one call (binds the API). */
const DISCOVERY_CAP = 500;

/** Path encoding used by Claude Code: replace every `/` with `-`. */
export function encodeClaudeProjectDir(projectRoot: string): string {
  const abs = resolve(projectRoot);
  return abs.replace(/\//g, "-");
}

/** `~/.claude/projects/<encoded>/` for the given project root, or empty if HOME is unset. */
export function claudeProjectsDir(projectRoot: string): string | null {
  try {
    const home = homedir();
    if (!home) return null;
    return join(home, ".claude", "projects", encodeClaudeProjectDir(projectRoot));
  } catch {
    return null;
  }
}

/** Global Claude history file (`~/.claude/history.jsonl`). */
export function claudeHistoryPath(): string | null {
  try {
    const home = homedir();
    if (!home) return null;
    return join(home, ".claude", "history.jsonl");
  } catch {
    return null;
  }
}

/**
 * Read up to `headBytes` from the start and `tailBytes` from the end of a
 * file. For files smaller than `headBytes + tailBytes`, the entire file is
 * returned. Used to avoid reading multi-MB transcripts just to summarise.
 */
function readHeadTail(filePath: string, headBytes: number, tailBytes: number): string {
  let total: number;
  try {
    total = statSync(filePath).size;
  } catch {
    return "";
  }
  if (total <= headBytes + tailBytes) {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const head = Buffer.alloc(headBytes);
    readSync(fd, head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    readSync(fd, tail, 0, tailBytes, total - tailBytes);
    return head.toString("utf-8") + "\n" + tail.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Leniently parse one line of a Claude Code session JSONL file. Claude's
 * native shape is `{type, message, timestamp, ...}` where `type` is
 * `user` / `assistant` / ... Returns null for unrecognised lines.
 */
function parseExternalLine(raw: string): { role: "user" | "assistant" | "other"; content: string; ts: string; model?: string } | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    const type = typeof obj.type === "string" ? obj.type : "";
    const message = (obj.message && typeof obj.message === "object") ? obj.message as Record<string, unknown> : null;
    const ts = typeof obj.timestamp === "string" && obj.timestamp
      ? obj.timestamp
      : (typeof obj.ts === "string" ? obj.ts : "");
    let role: "user" | "assistant" | "other" = "other";
    let content = "";
    let model: string | undefined;
    if (type === "user") role = "user";
    else if (type === "assistant") role = "assistant";
    else if (message) {
      const mRole = typeof message.role === "string" ? message.role : "";
      if (mRole === "user") role = "user";
      else if (mRole === "assistant") role = "assistant";
    }
    if (message) {
      const c = message.content;
      if (typeof c === "string") content = c;
      else if (Array.isArray(c)) {
        const parts: string[] = [];
        for (const part of c) {
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") parts.push(p.text);
            else if (typeof p.content === "string") parts.push(p.content);
          }
        }
        content = parts.join("");
      }
    }
    if (typeof obj.model === "string") model = obj.model;
    else if (message && typeof message.model === "string") model = message.model;
    return { role, content, ts, model };
  } catch {
    return null;
  }
}

/**
 * Derive an external-session summary from a Claude Code JSONL file without
 * loading the full transcript. Returns null when the head bytes contain no
 * recognisable user/assistant line (a still-being-written session).
 */
function summariseExternalFile(filePath: string, sessionId: string): ChatSessionSummary | null {
  const head = readHeadTail(filePath, DISCOVERY_HEAD_BYTES, DISCOVERY_TAIL_BYTES);
  if (!head) return null;
  const lines = head.split("\n");
  let firstUser: { content: string; ts: string } | null = null;
  let firstAssistant: { content: string; ts: string; model?: string } | null = null;
  let lastTs = "";
  let userTurnCount = 0;
  let assistantTurnCount = 0;
  let firstTs = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseExternalLine(trimmed);
    if (!parsed) continue;
    if (!firstTs && parsed.ts) firstTs = parsed.ts;
    if (parsed.ts) lastTs = parsed.ts;
    if (parsed.role === "user") {
      userTurnCount++;
      if (!firstUser) firstUser = { content: parsed.content, ts: parsed.ts || firstTs };
    } else if (parsed.role === "assistant") {
      assistantTurnCount++;
      if (!firstAssistant) firstAssistant = { content: parsed.content, ts: parsed.ts || firstTs, model: parsed.model };
    }
  }
  if (!firstUser && !firstAssistant) return null;
  const titleRaw = firstUser?.content?.trim() ?? firstAssistant?.content?.trim() ?? "(empty session)";
  const title = titleRaw.length > 80 ? titleRaw.slice(0, 79) + "…" : titleRaw;
  const ts = firstTs || nowIso();
  const lastActivityTs = lastTs || ts;
  const turnCount = userTurnCount + assistantTurnCount;
  // Selector fields are best-effort — only `model` is reliably emitted by
  // Claude Code in the assistant line. `effort` and `permissionMode` are
  // CLI flags the JSONL doesn't normally carry.
  return {
    id: sessionId,
    title,
    model: firstAssistant?.model ?? null,
    effort: null,
    permissionMode: null,
    createdAt: ts,
    lastActivity: lastActivityTs,
    turnCount,
    archived: false,
    source: "claude-code",
  };
}

/**
 * Read `~/.claude/history.jsonl` and return summaries for entries whose
 * `project` (encoded path) matches the given `projectRoot`. Used as a
 * fallback when the JSONL transcript for a session has been cleaned up.
 */
function readHistoryFallbacks(projectRoot: string): ChatSessionSummary[] {
  const historyPath = claudeHistoryPath();
  if (!historyPath || !existsSync(historyPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(historyPath, "utf-8");
  } catch {
    return [];
  }
  const encoded = encodeClaudeProjectDir(projectRoot);
  const out: ChatSessionSummary[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (!obj || typeof obj !== "object") continue;
      const project = typeof obj.project === "string" ? obj.project : "";
      if (project !== encoded) continue;
      const sid = typeof obj.sessionId === "string" ? obj.sessionId : "";
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const display = typeof obj.display === "string" ? obj.display : "(empty session)";
      const title = display.trim().length > 80 ? display.trim().slice(0, 79) + "…" : display.trim();
      const tsRaw = typeof obj.timestamp === "string" && obj.timestamp
        ? obj.timestamp
        : (typeof obj.lastAccessed === "string" ? obj.lastAccessed : "");
      const ts = tsRaw || nowIso();
      out.push({
        id: sid,
        title: title || "(empty session)",
        model: null,
        effort: null,
        permissionMode: null,
        createdAt: ts,
        lastActivity: ts,
        turnCount: 0,
        archived: false,
        source: "history-fallback",
      });
    } catch {
      /* skip unparseable line */
    }
  }
  return out;
}

/**
 * Discover Claude Code sessions that belong to `projectRoot`. Each candidate
 * JSONL under the encoded Claude project dir is summarised with bounded
 * head+tail reads; sessions whose JSONL is missing are filled in from
 * `~/.claude/history.jsonl`. The returned list may include both
 * `source: "claude-code"` (real transcripts, continueable) and
 * `source: "history-fallback"` (metadata only). The result is sorted by
 * lastActivity desc and capped at `DISCOVERY_CAP`; missing/corrupt files are
 * silently skipped.
 */
export function discoverExternalSessions(projectRoot: string): ChatSessionSummary[] {
  const out: ChatSessionSummary[] = [];
  const dir = claudeProjectsDir(projectRoot);
  if (dir && existsSync(dir)) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(SESSION_EXT) && !f.startsWith("."));
    } catch {
      files = [];
    }
    for (const file of files) {
      const id = file.slice(0, -SESSION_EXT.length);
      if (!id) continue;
      const filePath = join(dir, file);
      try {
        const summary = summariseExternalFile(filePath, id);
        if (summary) out.push(summary);
      } catch {
        /* skip unreadable file */
      }
    }
  }
  // Backfill from history for sessions whose JSONL is gone.
  const have = new Set(out.map((s) => s.id));
  for (const fb of readHistoryFallbacks(projectRoot)) {
    if (!have.has(fb.id)) out.push(fb);
  }
  out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return out;
}

/**
 * Cap a list of summaries at `DISCOVERY_CAP`. Returns the trimmed list plus
 * a boolean indicating whether more were available. Used by the unified list
 * endpoint so the API response stays bounded.
 */
export function capSessions<T extends { lastActivity: string }>(list: T[]): { items: T[]; truncated: boolean } {
  if (list.length <= DISCOVERY_CAP) return { items: list, truncated: false };
  return { items: list.slice(0, DISCOVERY_CAP), truncated: true };
}

/**
 * Archive an active session by moving its JSONL file to `.archived/`.
 * Returns true on success, false if the session was not active.
 */
export function archiveSession(projectRoot: string, sessionId: string): boolean {
  const active = sessionPath(projectRoot, sessionId);
  if (!existsSync(active)) return false;
  ensureSessionsDirs(projectRoot);
  const dest = archivedSessionPath(projectRoot, sessionId);
  // renameSync overwrites the destination on POSIX; on Windows it would fail,
  // but OpenKan targets Linux/macOS as the primary platforms.
  renameSync(active, dest);
  return true;
}

/**
 * Permanently remove a session (active or archived). Used by tests; the
 * public API uses `archiveSession` for the user-facing DELETE action.
 */
export function deleteSession(projectRoot: string, sessionId: string): boolean {
  const active = sessionPath(projectRoot, sessionId);
  const archived = archivedSessionPath(projectRoot, sessionId);
  let removed = false;
  if (existsSync(active)) {
    try { unlinkSync(active); removed = true; } catch { /* ignore */ }
  }
  if (existsSync(archived)) {
    try { unlinkSync(archived); removed = true; } catch { /* ignore */ }
  }
  return removed;
}

// ─── Subprocess wrapper ──────────────────────────────────────────────────────

/** Validate a chat selector set. Throws on invalid input. */
export function validateSelectors(selectors: ChatSelectors): void {
  if (selectors.agent !== undefined && (typeof selectors.agent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_:./-]{0,127}$/.test(selectors.agent))) throw new Error("Invalid agent identifier");
  const eff = selectors.effort;
  const validEffort = new Set(["low", "medium", "high", "max"]);
  if (!validEffort.has(eff)) {
    throw new Error(`Invalid effort: ${eff}. Expected one of ${[...validEffort].join(", ")}.`);
  }
  const validPerm = new Set<string>(ALLOWED_PERMISSION_MODES);
  if (!validPerm.has(selectors.permissionMode)) {
    throw new Error(
      `Invalid permissionMode: ${selectors.permissionMode}. Expected one of ${[...validPerm].join(", ")}.`,
    );
  }
  if (!selectors.model || typeof selectors.model !== "string") {
    throw new Error("model is required");
  }
}

/** Allowed permission modes for the Claude Code CLI. */
export const ALLOWED_PERMISSION_MODES = [
  "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan",
] as const;

/** One option in the model picker UI. */
export interface PickerModelOption {
  id: string;
  label: string;
}

/** Shape returned by `GET /api/chat/picker-options`. */
export interface PickerOptions {
  agents: { id: string; label: string; description: string }[];
  models: PickerModelOption[];
  efforts: readonly string[];
  permissionModes: readonly string[];
}

/**
 * Derive a picker-style option list (id + label) from a model id. Strips a
 * `provider/` prefix when present so `minimax/MiniMax-M3` displays as
 * `MiniMax-M3` in the UI. Used by both the picker endpoint and tests.
 */
export function toPickerLabel(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Build the picker options payload for `/api/chat/picker-options`. Pulls the
 * model list from `readModelRouter` so the chat UI and the model's routing
 * policy stay in sync without duplicating I/O. Tests can inject a model
 * list via `overrides.models` to avoid filesystem fixture setup.
 */
export async function pickerOptions(
  projectRoot: string,
  overrides: { models?: string[] } = {},
): Promise<PickerOptions> {
  const router = await readModelRouter(projectRoot);
  // Older router files often specify policy defaults but omit the optional
  // `models` array. Expose those configured model ids in the picker rather
  // than leaving the model menu apparently empty.
  const policyModels = Object.values(router.policies ?? {})
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const ids = overrides.models ?? [...router.models, ...policyModels];
  const models: PickerModelOption[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: toPickerLabel(id) });
  }
  const profiles = await readAgents(projectRoot);
  const agents = [
    { id: OPENKAN_AGENT_ID, label: "OpenKan", description: "Planning, structure, goals, and project management" },
    { id: "default", label: "Claude Code", description: "General-purpose assistant without a custom agent profile" },
    ...profiles.filter(profile => profile.id !== OPENKAN_AGENT_ID && profile.id !== "default").map(profile => ({ id: profile.id, label: profile.id, description: String(profile.frontmatter.description || "Custom Claude agent") })),
  ];
  return {
    agents,
    models,
    efforts: ALLOWED_EFFORT_LEVELS,
    permissionModes: ALLOWED_PERMISSION_MODES,
  };
}

/** Allowed effort levels for the Claude Code CLI. */
export const ALLOWED_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;

/** Resolve which Claude binary to invoke. Honours $CLAUDE_BIN. */
export function resolveClaudeBin(override?: string): string {
  if (override && override.trim()) return resolve(override);
  if (process.env.CLAUDE_BIN && process.env.CLAUDE_BIN.trim()) {
    return resolve(process.env.CLAUDE_BIN);
  }
  return "claude";
}

/**
 * Process and live-event identities include the project root. Session IDs are
 * random, but making the scope explicit prevents a project switch from ever
 * sharing an abort target or an SSE event channel with another workspace.
 */
function projectScope(projectRoot: string): string {
  return resolve(projectRoot);
}

function scopedSessionKey(projectRoot: string, sessionId: string): string {
  return `${projectScope(projectRoot)}\u0000${sessionId}`;
}

interface RunningProcess {
  projectRoot: string;
  sessionId: string;
  child: ChildProcess;
}

/** Per-project/session child-process registry. */
const runningProcs = new Map<string, RunningProcess>();

/** Inspect the running process registry (used by tests and the API layer). */
export function listRunningSessions(projectRoot?: string): string[] {
  const scope = projectRoot ? projectScope(projectRoot) : null;
  return [...runningProcs.values()]
    .filter((entry) => !scope || entry.projectRoot === scope)
    .map((entry) => entry.sessionId);
}

function registerProc(projectRoot: string, sessionId: string, child: ChildProcess): void {
  const root = projectScope(projectRoot);
  const key = scopedSessionKey(root, sessionId);
  const existing = runningProcs.get(key)?.child;
  if (existing && !existing.killed) {
    try { existing.kill("SIGTERM"); } catch { /* ignore */ }
  }
  runningProcs.set(key, { projectRoot: root, sessionId, child });
}

function clearProc(projectRoot: string, sessionId: string, child: ChildProcess): void {
  const key = scopedSessionKey(projectRoot, sessionId);
  if (runningProcs.get(key)?.child === child) runningProcs.delete(key);
}

/**
 * Kill the subprocess for a project/session pair. The single-argument form is
 * retained for test/backward compatibility; HTTP calls always pass a project.
 */
export function abortSession(projectRootOrSessionId: string, maybeSessionId?: string): boolean {
  const entry = maybeSessionId
    ? runningProcs.get(scopedSessionKey(projectRootOrSessionId, maybeSessionId))
    : [...runningProcs.values()].find((candidate) => candidate.sessionId === projectRootOrSessionId);
  if (!entry) return false;
  const { child } = entry;
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  // Force-kill after a grace period if it has not exited.
  setTimeout(() => {
    const key = scopedSessionKey(entry.projectRoot, entry.sessionId);
    if (runningProcs.get(key)?.child === child) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 2000).unref?.();
  return true;
}

const TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Stream parser ───────────────────────────────────────────────────────────

/**
 * Parse one NDJSON line into a typed StreamEvent. Returns null when the
 * line is empty / not an object — caller should treat that as "no event
 * for this chunk" and continue. Exported so unit tests can exercise the
 * parser without spawning a child process.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  // `--include-partial-messages` wraps Anthropic-style deltas as
  // `{type:"stream_event",event:{...}}`. Normalise that documented envelope
  // before parsing, while retaining its original payload for diagnostics.
  const envelope = raw;
  if (raw.type === "stream_event" && raw.event && typeof raw.event === "object") {
    raw = raw.event as Record<string, unknown>;
  }
  let type = typeof raw.type === "string" ? raw.type : "unknown";
  const parentFrom = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const id = record.parent_tool_use_id ?? record.parentToolUseId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  };
  const event: StreamEvent = { type, raw: { ...raw, _envelope: envelope.type === "stream_event" ? envelope : undefined } };
  // `--forward-subagent-text` annotates forwarded assistant/user messages
  // with this id. Claude Code has shipped it both on the outer record and on
  // `message`, so accept either documented shape (and the partial envelope).
  event.parentToolUseId = parentFrom(raw)
    ?? parentFrom(raw.message)
    ?? parentFrom(envelope)
    ?? parentFrom((envelope as Record<string, unknown>).message);

  if (typeof raw.index === "number") event.index = raw.index;

  // Claude Code's current stream-json format emits completed assistant
  // snapshots (`{type:"assistant", message:{content:[...]}}`) instead of
  // Anthropic content_block_delta records. Normalise visible text into the
  // same delta shape so the UI and persisted turn never go blank.
  if (type === "assistant") {
    const content = (raw.message as Record<string, unknown> | undefined)?.content;
    const text = Array.isArray(content)
      ? content.filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
        .map((part) => String((part as Record<string, unknown>).text ?? "")).join("")
      : "";
    if (text) {
      type = "content_block_delta";
      event.type = type;
      event.index = 0;
      event.delta = { type: "text_delta", text };
      return event;
    }
  }
  // The terminal result carries a reliable text fallback for providers that
  // do not emit a separate assistant-text record.
  if (type === "result" && typeof raw.result === "string" && raw.result) {
    event.type = "content_block_delta";
    event.index = 0;
    event.delta = { type: "text_delta", text: raw.result };
    return event;
  }

  // content_block_start carries the block descriptor under `content_block`.
  const cb = raw.content_block;
  if (cb && typeof cb === "object") {
    const block = cb as Record<string, unknown>;
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "text" || blockType === "thinking" || blockType === "tool_use" || blockType === "tool_result") {
      event.contentBlock = {
        type: blockType,
        id: typeof block.id === "string" ? block.id : undefined,
        name: typeof block.name === "string" ? block.name : undefined,
        tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        input: block.input && typeof block.input === "object"
          ? block.input as Record<string, unknown>
          : undefined,
        content: typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content as Array<{ type: string; text?: string }>
            : undefined,
        text: typeof block.text === "string" ? block.text : undefined,
      };
    }
  }

  // content_block_delta / message_delta carry the delta under `delta`.
  const d = raw.delta;
  if (d && typeof d === "object") {
    const delta = d as Record<string, unknown>;
    event.delta = {
      type: typeof delta.type === "string" ? delta.type : "",
      text: typeof delta.text === "string" ? delta.text : undefined,
      thinking: typeof delta.thinking === "string" ? delta.thinking : undefined,
      partial_json: typeof delta.partial_json === "string" ? delta.partial_json : undefined,
      stop_reason: typeof delta.stop_reason === "string" ? delta.stop_reason : undefined,
    };
  }

  return event;
}

/** Apply a parsed stream event to the in-memory TurnState. Returns the
 *  list of chip-friendly events (tool_use, tool_result, text_delta) that
 *  were produced, so callers can fan them out over SSE without re-parsing.
 *  Exported for unit tests.
 */
function nextToolSequence(state: TurnState): number {
  state.toolSequence = (state.toolSequence ?? 0) + 1;
  return state.toolSequence;
}

/** Preserve subagent file/tool work in the final parent activity audit while
 * deliberately excluding forwarded text and thinking from the parent reply. */
function applyForwardedToolEvent(state: TurnState, event: StreamEvent): void {
  const parentToolUseId = event.parentToolUseId;
  const block = event.contentBlock;
  if (!parentToolUseId || !block) return;
  const tools = state.subagentToolUses ??= new Map<string, ToolUseRecord>();
  if (block.type === "tool_use" && block.id) {
    const key = `${parentToolUseId}:${block.id}`;
    tools.set(key, {
      id: `subagent:${key}`,
      name: block.name ?? "unknown",
      input: block.input ?? {},
      status: "started",
      source: "subagent",
      parentToolUseId,
      sequence: nextToolSequence(state),
    });
    return;
  }
  if (block.type !== "tool_result" || !block.tool_use_id) return;
  const existing = tools.get(`${parentToolUseId}:${block.tool_use_id}`);
  if (!existing) return;
  const text = typeof block.content === "string"
    ? block.content
    : Array.isArray(block.content)
      ? block.content.map((item) => item.text ?? "").join("")
      : "";
  const rawBlock = event.raw.content_block as Record<string, unknown> | undefined;
  existing.status = rawBlock?.is_error ? "failed" : "completed";
  existing.resultPreview = text.slice(0, 200);
  existing.isError = Boolean(rawBlock?.is_error);
  tools.set(`${parentToolUseId}:${block.tool_use_id}`, existing);
}

export type StreamApplyResult = { toolUseIndex: number; toolUse: ToolUseRecord }
  | { toolResult: ToolUseRecord }
  | { textDelta: string }
  | { reasoningDelta: string }
  | { stopReason: string }
  | null;

/**
 * Merge a text event without replaying Claude's assistant snapshots after
 * incremental stream deltas. The return value is exactly the new suffix that
 * belongs in the live SSE transcript.
 */
function mergeText(state: TurnState, index: number, text: string, snapshot: boolean): string {
  const previous = state.textByBlock.get(index) ?? "";
  if (!snapshot) {
    state.textByBlock.set(index, previous + text);
    return text;
  }
  if (!previous) {
    state.textByBlock.set(index, text);
    return text;
  }
  if (previous === text || previous.endsWith(text) || previous.startsWith(text)) return "";
  if (text.startsWith(previous)) {
    state.textByBlock.set(index, text);
    return text.slice(previous.length);
  }
  // An assistant snapshot should supersede a partial stream rather than
  // duplicate it. It is intentionally not emitted as a second live delta.
  state.textByBlock.set(index, text);
  return "";
}

export function applyStreamEvent(
  state: TurnState,
  event: StreamEvent,
): StreamApplyResult {
  // Forwarded child text and thinking stay out of the parent reply, while
  // their real tool effects remain available in the completed audit trail.
  if (event.parentToolUseId) {
    applyForwardedToolEvent(state, event);
    return null;
  }
  // `result` is a fallback for providers that skip assistant text events.
  // Do not append it when a normal assistant snapshot has already supplied text.
  if (event.raw.type === "result" && [...state.textByBlock.values()].some(Boolean)) return null;
  switch (event.type) {
    case "content_block_start": {
      const cb = event.contentBlock;
      if (!cb) return null;
      if (cb.type === "text" && typeof event.index === "number") {
        state.textByBlock.set(event.index, "");
        return null;
      }
      if (cb.type === "thinking" && typeof event.index === "number") {
        state.reasoningByBlock.set(event.index, cb.text ?? "");
        return null;
      }
      if (cb.type === "tool_use" && typeof event.index === "number" && cb.id) {
        const toolUse: ToolUseRecord = {
          id: cb.id,
          name: cb.name ?? "unknown",
          input: cb.input ?? {},
          status: "started",
          sequence: nextToolSequence(state),
        };
        state.toolUses.set(event.index, toolUse);
        state.toolIndexById.set(cb.id, event.index);
        return { toolUseIndex: event.index, toolUse };
      }
      if (cb.type === "tool_result" && cb.tool_use_id) {
        const text = typeof cb.content === "string"
          ? cb.content
          : Array.isArray(cb.content)
            ? cb.content.map((c) => c.text ?? "").join("")
            : "";
        const isError = Boolean((event.raw.content_block as Record<string, unknown>)?.is_error);
        state.toolResults.set(cb.tool_use_id, { content: text, isError });
        const idx = state.toolIndexById.get(cb.tool_use_id);
        if (idx !== undefined) {
          const existing = state.toolUses.get(idx);
          if (existing) {
            existing.status = isError ? "failed" : "completed";
            existing.resultPreview = text.slice(0, 200);
            existing.isError = isError;
            state.toolUses.set(idx, existing);
            return { toolResult: { ...existing } };
          }
        }
      }
      return null;
    }
    case "content_block_delta": {
      const d = event.delta;
      if (!d) return null;
      if (d.type === "text_delta" && typeof event.index === "number") {
        const text = mergeText(state, event.index, d.text ?? "", event.raw.type === "assistant");
        return { textDelta: text };
      }
      if ((d.type === "thinking_delta" || d.type === "reasoning_delta") && typeof event.index === "number") {
        const text = d.thinking ?? d.text ?? "";
        state.reasoningByBlock.set(event.index, (state.reasoningByBlock.get(event.index) ?? "") + text);
        return { reasoningDelta: text };
      }
      if (d.type === "input_json_delta" && typeof event.index === "number") {
        const existing = state.toolUses.get(event.index);
        if (existing) {
          existing.status = "streaming";
          state.toolUses.set(event.index, existing);
        }
        return null;
      }
      return null;
    }
    case "message_delta": {
      const reason = event.delta?.stop_reason;
      if (typeof reason === "string") {
        state.stopReason = reason;
        return { stopReason: reason };
      }
      return null;
    }
    case "message_stop": {
      // Mark any started/streaming tool calls that never received a result
      // as aborted (the upstream was cut short).
      for (const [, tool] of state.toolUses) {
        if (tool.status === "started" || tool.status === "streaming") {
          tool.status = "aborted";
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** Assemble the persisted assistant turn from a finished TurnState. */
export function assembleAssistantTurn(
  state: TurnState,
  opts: ChatSelectors,
  assistantTs: string,
  status: ChatTurn["status"] = "ok",
  error?: string,
): ChatTurn {
  // Concatenate text blocks in index order.
  const orderedIndexes = [...state.textByBlock.keys()].sort((a, b) => a - b);
  const content = orderedIndexes.map((i) => state.textByBlock.get(i) ?? "").join("");
  const reasoning = [...state.reasoningByBlock.keys()].sort((a, b) => a - b)
    .map((i) => state.reasoningByBlock.get(i) ?? "").join("");

  // Concatenate tool uses in the order they were opened (index order).
  const toolUses: ToolUseRecord[] = [
    ...[...state.toolUses.entries()].sort((a, b) => a[0] - b[0]).map(([, tool]) => tool),
    ...[...(state.subagentToolUses ?? new Map()).values()],
  ].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  const turn: ChatTurn = {
    ts: assistantTs,
    role: status === "ok" ? "assistant" : "system",
    content,
    agent: opts.agent ?? OPENKAN_AGENT_ID,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    messageId: newMessageId(),
    status: status ?? "ok",
    toolUses,
  };
  if (reasoning) turn.reasoning = reasoning;
  if (error) turn.error = error;
  return turn;
}

/**
 * Spawn `claude -p "<message>" --output-format stream-json --verbose` and
 * stream parsed NDJSON events back via the provided callback. Returns once
 * the subprocess exits and the final assistant turn has been persisted.
 */
export async function sendTurn(
  projectRoot: string,
  opts: SendTurnOptions,
): Promise<SendTurnResult> {
  validateSelectors(opts);
  const sessionId = opts.sessionId ?? generateSessionId();
  const messageId = newMessageId();
  const startedAtMs = Date.now();
  const ts = nowIso();
  const userTurn: ChatTurn = {
    ts,
    role: "user",
    content: opts.displayMessage ?? opts.message,
    taskMentions: opts.taskMentions,
    agent: opts.agent ?? OPENKAN_AGENT_ID,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    messageId,
  };
  appendTurn(projectRoot, sessionId, userTurn);

  const bin = resolveClaudeBin(opts.claudeBin);
  const args = [
    "-p",
    opts.message,
    "--model", opts.model,
    "--effort", opts.effort,
    "--permission-mode", opts.permissionMode,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--forward-subagent-text",
  ];

  const selectedAgent = opts.agent ?? OPENKAN_AGENT_ID;
  if (selectedAgent !== "default") {
    // The bundled default also works with --ignore-scripts or a read-only home.
    // Existing user/project profiles retain their normal Claude precedence.
    if (selectedAgent === OPENKAN_AGENT_ID && !(await readAgents(projectRoot)).some(profile => profile.id === OPENKAN_AGENT_ID)) {
      args.push("--agents", JSON.stringify({ [OPENKAN_AGENT_ID]: openkanAgentDefinition() }));
    }
    args.push("--agent", selectedAgent);
  }
  const child = spawn(bin, args, {
    cwd: opts.cwd ?? projectRoot,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerProc(projectRoot, sessionId, child);

  const abortHandler = () => {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }

  let stderrBuf = "";
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }, TURN_TIMEOUT_MS);
  timeout.unref?.();

  // Line-buffer for NDJSON. Chunks from stdout are appended to `lineBuf`
  // and split on `\n` so we never lose a partial line straddling chunks.
  let lineBuf = "";
  const state: TurnState = {
    textByBlock: new Map(),
    reasoningByBlock: new Map(),
    toolUses: new Map(),
    toolIndexById: new Map(),
    toolResults: new Map(),
    subagentToolUses: new Map(),
    toolSequence: 0,
    stopReason: null,
  };

  // Child-exit promise. We capture both `code` and `signal` because aborts
  // via SIGTERM/SIGKILL exit with code `null` and a signal name.
  const exitInfo: { code: number | null; signal: NodeJS.Signals | null } = await new Promise(
    (resolveP, rejectP) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        lineBuf += text;
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          const event = parseStreamLine(line);
          if (!event) continue;
          const applied = applyStreamEvent(state, event);
          opts.onStreamEvent?.(event, applied);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf-8");
      });
      child.on("error", (err) => rejectP(err));
      child.on("exit", (code, signal) => resolveP({ code, signal }));
    },
  );
  // Drain any trailing line that did not end in \n (e.g. partial write).
  if (lineBuf.trim()) {
    const event = parseStreamLine(lineBuf);
    if (event) {
      const applied = applyStreamEvent(state, event);
      opts.onStreamEvent?.(event, applied);
    }
  }

  const exitCode = exitInfo.code;
  const exitSignal = exitInfo.signal;

  clearTimeout(timeout);
  if (opts.signal) opts.signal.removeEventListener("abort", abortHandler);
  clearProc(projectRoot, sessionId, child);

  const assistantTs = nowIso();
  const killedBySignal = exitCode === null && exitSignal !== null;
  const aborted = opts.signal?.aborted || timedOut || killedBySignal;

  let assistantTurn: ChatTurn;
  if (aborted) {
    const assembled = assembleAssistantTurn(state, opts, assistantTs, "aborted");
    assembled.role = "system";
    if (!assembled.content) assembled.content = "(assistant turn aborted before completion)";
    assistantTurn = assembled;
  } else if (exitCode !== 0) {
    assistantTurn = assembleAssistantTurn(
      state,
      opts,
      assistantTs,
      "error",
      stderrBuf.trim() || `exit code ${exitCode}`,
    );
    assistantTurn.role = "system";
    if (!assistantTurn.content) {
      assistantTurn.content = stderrBuf.trim() || `claude exited with code ${exitCode}`;
    }
  } else {
    assistantTurn = assembleAssistantTurn(state, opts, assistantTs, "ok");
  }
  assistantTurn.durationMs = Date.now() - startedAtMs;
  appendTurn(projectRoot, sessionId, assistantTurn);

  return { sessionId, userTurn, assistantTurn };
}

// ─── HTTP dispatcher ─────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Project-scoped SSE channels; switching workspaces must never fan out activity across projects. */
const chatSseControllers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

/** Per-project/session SSE channel. */
const sessionChatSseControllers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

function controllersForProject(projectRoot: string): Set<ReadableStreamDefaultController<Uint8Array>> {
  const scope = projectScope(projectRoot);
  let controllers = chatSseControllers.get(scope);
  if (!controllers) {
    controllers = new Set();
    chatSseControllers.set(scope, controllers);
  }
  return controllers;
}

function broadcastChat(projectRoot: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of chatSseControllers.get(projectScope(projectRoot)) ?? []) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch { /* ignore */ }
  }
}

/** Push an event only to subscribers of this project/session pair. */
function broadcastChatSession(projectRoot: string, sessionId: string, event: string, data: unknown): void {
  const ctrls = sessionChatSseControllers.get(scopedSessionKey(projectRoot, sessionId));
  if (!ctrls) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of ctrls) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch { /* ignore */ }
  }
}

function isHighSignalActivity(event: StreamEvent): boolean {
  const raw = event.raw;
  const hook = raw.hook_event_name ?? raw.hookEventName;
  const subtype = typeof raw.subtype === "string" ? raw.subtype.toLowerCase() : "";
  if (event.parentToolUseId && event.contentBlock?.type === "tool_use") return true;
  if (hook || raw.mcp_server_name || raw.mcp_tool_name) return true;
  if (subtype.includes("retry") || subtype.includes("team") || subtype.includes("workflow") || subtype.includes("agent")) return true;
  return event.type === "error" || raw.type === "error";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "del", "code", "pre",
  "ul", "ol", "li", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
  "a", "hr", "img", "span", "div",
];
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  code: ["class"],
  img: ["src", "alt", "title"],
};

/**
 * Server-side markdown rendering for chat messages. Mirrors the
 * `renderArtifact` pipeline in `server.ts` so the chat sidebar can show
 * sanitised HTML without bundling `marked` into the browser.
 */
async function renderMarkdown(raw: string): Promise<string> {
  const [{ marked }, sanitizeHtmlMod] = await Promise.all([
    import("marked"),
    import("sanitize-html"),
  ]);
  const html = await marked(raw);
  const sanitizeHtml = (sanitizeHtmlMod as { default: (html: string, opts: Record<string, unknown>) => string }).default;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
  });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * HTTP dispatcher for `/api/chat/*`. Mirrors the shape of `handleBizarRequest`
 * / `handleClaudeRequest`: returns a `Response` for every request.
 */
export async function handleChatRequest(
  projectRoot: string,
  req: Request,
  path: string,
): Promise<Response> {
  void new URL(req.url); // reserved for future query filters; suppress lint
  try {
    // GET /api/chat/sessions — list every session summary
    if (req.method === "GET" && path === "/api/chat/sessions") {
      return jsonResponse({ sessions: listSessions(projectRoot) });
    }

    // GET /api/chat/sessions/:sid — full transcript
    const getOne = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
    if (getOne && req.method === "GET") {
      const sid = decodeURIComponent(getOne[1]);
      const turns = readSession(projectRoot, sid);
      if (turns.length === 0) {
        return errResponse(`Session not found: ${sid}`, 404);
      }
      const archived = isSessionArchived(projectRoot, sid);
      return jsonResponse({
        session: summariseSession(sid, turns, archived),
        running: listRunningSessions(projectRoot).includes(sid),
        turns,
      });
    }

    // DELETE /api/chat/sessions/:sid — archive
    const delOne = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
    if (delOne && req.method === "DELETE") {
      const sid = decodeURIComponent(delOne[1]);
      if (!isSessionActive(projectRoot, sid) && !isSessionArchived(projectRoot, sid)) {
        return errResponse(`Session not found: ${sid}`, 404);
      }
      // If active, move to archived; if already archived, hard-delete.
      if (isSessionActive(projectRoot, sid)) {
        archiveSession(projectRoot, sid);
      } else {
        deleteSession(projectRoot, sid);
      }
      broadcastChat(projectRoot, "chat.session-archived", { sessionId: sid });
      return jsonResponse({ ok: true, sessionId: sid, archived: true });
    }

    // POST /api/chat/sessions/:sid/abort — kill running subprocess
    const abortMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/abort$/);
    if (abortMatch && req.method === "POST") {
      const sid = decodeURIComponent(abortMatch[1]);
      const killed = abortSession(projectRoot, sid);
      return jsonResponse({ ok: true, sessionId: sid, killed });
    }

    // GET /api/chat/sessions/:sid/events — SSE stream scoped to one session
    const eventsMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const sid = decodeURIComponent(eventsMatch[1]);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          // Subscribe to BOTH the global and per-session channel so the
          // sidebar receives `chat.turn` rollups and per-event tool/text
          // updates on the same stream.
          controllersForProject(projectRoot).add(ctrl);
          const sessionKey = scopedSessionKey(projectRoot, sid);
          let set = sessionChatSseControllers.get(sessionKey);
          if (!set) {
            set = new Set();
            sessionChatSseControllers.set(sessionKey, set);
          }
          set.add(ctrl);
          ctrl.enqueue(encoder.encode(
            `event: chat.session-connected\ndata: ${JSON.stringify({ sessionId: sid })}\n\n`,
          ));
        },
        cancel() {
          const controllers = chatSseControllers.get(projectScope(projectRoot));
          controllers?.delete(this);
          const sessionKey = scopedSessionKey(projectRoot, sid);
          const set = sessionChatSseControllers.get(sessionKey);
          if (set) {
            for (const c of set) {
              if (c === this) set.delete(c);
            }
            if (set.size === 0) sessionChatSseControllers.delete(sessionKey);
          }
        },
      });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    // POST /api/chat/send — send a new turn
    if (req.method === "POST" && path === "/api/chat/send") {
      const body = await readJsonBody(req);
      if (!body) return errResponse("Invalid JSON body", 400);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const taskMentions: ChatTaskMention[] = Array.isArray(body.taskMentions)
        ? body.taskMentions
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({
            id: typeof item.id === "string" ? item.id.trim() : "",
            title: typeof item.title === "string" ? item.title.trim() : "",
          }))
          .filter((item) => item.id.length > 0)
          .slice(0, 12)
        : [];
      if (!message && taskMentions.length === 0) return errResponse("message or task reference is required", 422);
      const taskContext = taskMentions.length
        ? `\n\nReferenced OpenKan tasks (use these as project context):\n${taskMentions.map((task) => `- ${task.id}: ${task.title || "Untitled task"}`).join("\n")}`
        : "";
      const agentMessage = `${message || "Please help with the referenced task."}${taskContext}`;
      const legacyPermissionModes: Record<string, string> = {
        "accept-edits": "acceptEdits", default: "auto", "bypass-permissions": "bypassPermissions",
      };
      const requestedPermissionMode = typeof body.permissionMode === "string" && body.permissionMode
        ? body.permissionMode : "bypassPermissions";
      const selectors: ChatSelectors = {
        agent: body.agent === undefined ? OPENKAN_AGENT_ID : typeof body.agent === "string" ? body.agent : "",
        model: typeof body.model === "string" && body.model ? body.model : "default",
        effort: typeof body.effort === "string" && body.effort ? body.effort : "high",
        permissionMode: legacyPermissionModes[requestedPermissionMode] ?? requestedPermissionMode,
      };
      try {
        validateSelectors(selectors);
        if (selectors.agent !== OPENKAN_AGENT_ID && selectors.agent !== "default" && !(await readAgents(projectRoot)).some(profile => profile.id === selectors.agent)) throw new Error("Selected agent is unavailable. Choose an installed agent.");
      } catch (e) {
        return errResponse((e as Error).message, 422);
      }
      const sessionId = typeof body.sessionId === "string" && body.sessionId
        ? body.sessionId
        : generateSessionId();
      try {
        // Start immediately and return an acknowledgement. The browser can now
        // subscribe to this session before Claude's first streamed event,
        // rather than staring at an empty composer until the process exits.
        broadcastChatSession(projectRoot, sessionId, "chat.status", { sessionId, phase: "thinking", label: "Thinking" });
        const running = sendTurn(projectRoot, {
          sessionId,
          message: agentMessage,
          displayMessage: message,
          taskMentions,
          agent: selectors.agent,
          model: selectors.model,
          effort: selectors.effort,
          permissionMode: selectors.permissionMode,
          onStreamEvent: (event, applied) => {
            // Live activity remains intentionally quiet: lifecycle changes and
            // the current subagent tool are useful while work is running;
            // individual thinking/text tokens are retained nowhere in the UI.
            if (isHighSignalActivity(event)) {
              broadcastChatSession(projectRoot, sessionId, "chat.activity", {
                sessionId,
                type: event.type,
                subtype: typeof event.raw.subtype === "string" ? event.raw.subtype : undefined,
                parentToolUseId: event.parentToolUseId,
                raw: event.raw,
                ts: nowIso(),
              });
            }
            // Subagent output belongs to the nested activity tree. Never
            // stream it into the parent assistant bubble.
            if (event.parentToolUseId) return;
            // Per-session channel: stream typed events for chips + bubbles.
            switch (event.type) {
              case "content_block_start": {
                const cb = event.contentBlock;
                if (cb?.type === "tool_use" && cb.id && event.index !== undefined) {
                  broadcastChatSession(projectRoot, sessionId, "chat.tool-use", {
                    sessionId,
                    id: cb.id,
                    name: cb.name ?? "unknown",
                    input: cb.input ?? {},
                    status: "started",
                    index: event.index,
                  });
                }
                break;
              }
              case "content_block_delta": {
                const d = event.delta;
                if (d?.type === "text_delta" && applied && "textDelta" in applied && applied.textDelta) {
                  broadcastChatSession(projectRoot, sessionId, "chat.text-delta", {
                    sessionId,
                    text: applied.textDelta,
                  });
                } else if ((d?.type === "thinking_delta" || d?.type === "reasoning_delta") && typeof (d.thinking ?? d.text) === "string") {
                  broadcastChatSession(projectRoot, sessionId, "chat.reasoning-delta", {
                    sessionId,
                    text: d.thinking ?? d.text,
                  });
                } else if (d?.type === "input_json_delta" && typeof event.index === "number") {
                  broadcastChatSession(projectRoot, sessionId, "chat.tool-input-delta", {
                    sessionId,
                    index: event.index,
                    partialJson: d.partial_json ?? "",
                  });
                }
                break;
              }
              case "message_delta": {
                if (event.delta?.stop_reason) {
                  broadcastChatSession(projectRoot, sessionId, "chat.message-delta", {
                    sessionId,
                    stopReason: event.delta.stop_reason,
                  });
                }
                break;
              }
              case "message_stop": {
                broadcastChatSession(projectRoot, sessionId, "chat.message-done", {
                  sessionId,
                  stopReason: event.delta?.stop_reason ?? null,
                });
                break;
              }
              default:
                break;
            }
          },
        });
        void running.then((result) => {
          broadcastChat(projectRoot, "chat.turn", { sessionId: result.sessionId, userTurn: result.userTurn, assistantTurn: result.assistantTurn });
          broadcastChatSession(projectRoot, result.sessionId, "chat.turn", { sessionId: result.sessionId, userTurn: result.userTurn, assistantTurn: result.assistantTurn });
        }).catch((error) => {
          broadcastChatSession(projectRoot, sessionId, "chat.status", { sessionId, phase: "error", label: "Chat failed", error: error instanceof Error ? error.message : String(error) });
        });
        const userTurn = readSession(projectRoot, sessionId).at(-1);
        return jsonResponse({ sessionId, accepted: true, userTurn }, 202);
      } catch (e) {
        const message = (e as Error)?.message || "sendTurn failed";
        return errResponse(message, 500);
      }
    }

    // GET /api/chat/events — SSE stream of every chat event in the project
    if (req.method === "GET" && path === "/api/chat/events") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          controllersForProject(projectRoot).add(ctrl);
          ctrl.enqueue(encoder.encode("event: chat.connected\ndata: {}\n\n"));
        },
        cancel(ctrl) {
          const scope = projectScope(projectRoot);
          const controllers = chatSseControllers.get(scope);
          controllers?.delete(ctrl);
          if (controllers?.size === 0) chatSseControllers.delete(scope);
        },
      });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    // GET /api/chat/selectors — server-side allowed values for the UI
    if (req.method === "GET" && path === "/api/chat/selectors") {
      return jsonResponse({
        efforts: ALLOWED_EFFORT_LEVELS,
        permissionModes: ALLOWED_PERMISSION_MODES,
      });
    }

    // GET /api/chat/picker-options — model list (sourced from the project
    // model-router) + allowed effort + permission modes. Used by the chat
    // sidebar's model pill popover.
    if (req.method === "GET" && path === "/api/chat/picker-options") {
      return jsonResponse(await pickerOptions(projectRoot));
    }

    // POST /api/chat/render-markdown — sanitised HTML for chat messages
    if (req.method === "POST" && path === "/api/chat/render-markdown") {
      const body = await readJsonBody(req);
      if (!body) return errResponse("Invalid JSON body", 400);
      const md = typeof body.markdown === "string" ? body.markdown : "";
      const html = await renderMarkdown(md);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return errResponse("Not found", 404);
  } catch (e) {
    const message = (e as Error)?.message || String(e);
    return errResponse(message, 500);
  }
}

// Test-only export so tests can wipe the registry between runs.
export function _resetRunningProcsForTests(): void {
  for (const { child } of runningProcs.values()) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
  runningProcs.clear();
  chatSseControllers.clear();
  sessionChatSseControllers.clear();
}
