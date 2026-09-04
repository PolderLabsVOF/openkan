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
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, writeFileAtomic } from "./io.ts";
import { readModelRouter } from "./claude-state.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single turn in a chat session. One JSON object per line in JSONL. */
export interface ChatTurn {
  ts: string;            // ISO timestamp
  role: "user" | "assistant" | "system";
  content: string;
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
}

/** Live state held while a turn is in flight, mutated by the stream parser. */
interface TurnState {
  textByBlock: Map<number, string>;
  toolUses: Map<number, ToolUseRecord>;
  /** tool_use_id -> index in `toolUses` so we can attach results. */
  toolIndexById: Map<string, number>;
  toolResults: Map<string, { content: string; isError: boolean }>;
  /** The most recent `message_delta` stop reason. */
  stopReason: string | null;
}

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
}

/** Selector values submitted with a chat message. */
export interface ChatSelectors {
  model: string;
  effort: string;
  permissionMode: string;
}

/** Input to sendTurn. */
export interface SendTurnOptions extends ChatSelectors {
  sessionId?: string;
  message: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  claudeBin?: string;
  /** Callback invoked for every parsed stream event (chat-side use only). */
  onStreamEvent?: (event: StreamEvent) => void;
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
  /** Convenience copy of `event.content_block` when present. */
  contentBlock?: {
    type: "text" | "tool_use" | "tool_result";
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
  const eff = selectors.effort;
  const validEffort = new Set(["low", "medium", "high", "max"]);
  if (!validEffort.has(eff)) {
    throw new Error(`Invalid effort: ${eff}. Expected one of ${[...validEffort].join(", ")}.`);
  }
  const validPerm = new Set([
    "accept-edits", "default", "plan", "bypass-permissions",
  ]);
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
  "accept-edits", "default", "plan", "bypass-permissions",
] as const;

/** One option in the model picker UI. */
export interface PickerModelOption {
  id: string;
  label: string;
}

/** Shape returned by `GET /api/chat/picker-options`. */
export interface PickerOptions {
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
  const ids = overrides.models ?? (await readModelRouter(projectRoot)).models;
  const models: PickerModelOption[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    models.push({ id, label: toPickerLabel(id) });
  }
  return {
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

/** Per-session child-process registry. Abort looks the session up here. */
const runningProcs = new Map<string, ChildProcess>();

/** Inspect the running-proc registry (used by tests and the API layer). */
export function listRunningSessions(): string[] {
  return [...runningProcs.keys()];
}

function registerProc(sessionId: string, child: ChildProcess): void {
  const existing = runningProcs.get(sessionId);
  if (existing && !existing.killed) {
    try { existing.kill("SIGTERM"); } catch { /* ignore */ }
  }
  runningProcs.set(sessionId, child);
}

function clearProc(sessionId: string, child: ChildProcess): void {
  const current = runningProcs.get(sessionId);
  if (current === child) runningProcs.delete(sessionId);
}

/** Kill the running subprocess for `sessionId`, if any. */
export function abortSession(sessionId: string): boolean {
  const child = runningProcs.get(sessionId);
  if (!child) return false;
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  // Force-kill after a grace period if it has not exited.
  setTimeout(() => {
    if (runningProcs.get(sessionId) === child) {
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
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const event: StreamEvent = { type, raw };

  if (typeof raw.index === "number") event.index = raw.index;

  // content_block_start carries the block descriptor under `content_block`.
  const cb = raw.content_block;
  if (cb && typeof cb === "object") {
    const block = cb as Record<string, unknown>;
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "text" || blockType === "tool_use" || blockType === "tool_result") {
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
export function applyStreamEvent(
  state: TurnState,
  event: StreamEvent,
): { toolUseIndex: number; toolUse: ToolUseRecord } | { toolResult: ToolUseRecord } | { textDelta: string } | { stopReason: string } | null {
  switch (event.type) {
    case "content_block_start": {
      const cb = event.contentBlock;
      if (!cb) return null;
      if (cb.type === "text" && typeof event.index === "number") {
        state.textByBlock.set(event.index, "");
        return null;
      }
      if (cb.type === "tool_use" && typeof event.index === "number" && cb.id) {
        const toolUse: ToolUseRecord = {
          id: cb.id,
          name: cb.name ?? "unknown",
          input: cb.input ?? {},
          status: "started",
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
        const prev = state.textByBlock.get(event.index) ?? "";
        const next = prev + (d.text ?? "");
        state.textByBlock.set(event.index, next);
        return { textDelta: d.text ?? "" };
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

  // Concatenate tool uses in the order they were opened (index order).
  const toolUses: ToolUseRecord[] = [...state.toolUses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t);

  const turn: ChatTurn = {
    ts: assistantTs,
    role: status === "ok" ? "assistant" : "system",
    content,
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    messageId: newMessageId(),
    status: status ?? "ok",
    toolUses,
  };
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
  const ts = nowIso();
  const userTurn: ChatTurn = {
    ts,
    role: "user",
    content: opts.message,
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
  ];

  const child = spawn(bin, args, {
    cwd: opts.cwd ?? projectRoot,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerProc(sessionId, child);

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
    toolUses: new Map(),
    toolIndexById: new Map(),
    toolResults: new Map(),
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
          if (applied && opts.onStreamEvent) opts.onStreamEvent(event);
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
      applyStreamEvent(state, event);
      if (opts.onStreamEvent) opts.onStreamEvent(event);
    }
  }

  const exitCode = exitInfo.code;
  const exitSignal = exitInfo.signal;

  clearTimeout(timeout);
  if (opts.signal) opts.signal.removeEventListener("abort", abortHandler);
  clearProc(sessionId, child);

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

/** SSE channel for chat: new turn events push to subscribers as they land. */
const chatSseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

/** Per-session SSE channel. Maps sessionId -> controller set. */
const sessionChatSseControllers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

function broadcastChat(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of chatSseControllers) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch { /* ignore */ }
  }
}

/** Push an event to every subscriber of a particular session. */
function broadcastChatSession(sessionId: string, event: string, data: unknown): void {
  const ctrls = sessionChatSseControllers.get(sessionId);
  if (!ctrls) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of ctrls) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch { /* ignore */ }
  }
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
      broadcastChat("chat.session-archived", { sessionId: sid });
      return jsonResponse({ ok: true, sessionId: sid, archived: true });
    }

    // POST /api/chat/sessions/:sid/abort — kill running subprocess
    const abortMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/abort$/);
    if (abortMatch && req.method === "POST") {
      const sid = decodeURIComponent(abortMatch[1]);
      const killed = abortSession(sid);
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
          chatSseControllers.add(ctrl);
          let set = sessionChatSseControllers.get(sid);
          if (!set) {
            set = new Set();
            sessionChatSseControllers.set(sid, set);
          }
          set.add(ctrl);
          ctrl.enqueue(encoder.encode(
            `event: chat.session-connected\ndata: ${JSON.stringify({ sessionId: sid })}\n\n`,
          ));
        },
        cancel() {
          chatSseControllers.delete(this);
          const set = sessionChatSseControllers.get(sid);
          if (set) {
            for (const c of set) {
              if (c === this) set.delete(c);
            }
            if (set.size === 0) sessionChatSseControllers.delete(sid);
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
      if (!message) return errResponse("message is required", 422);
      const selectors: ChatSelectors = {
        model: typeof body.model === "string" && body.model ? body.model : "default",
        effort: typeof body.effort === "string" && body.effort ? body.effort : "high",
        permissionMode: typeof body.permissionMode === "string" && body.permissionMode
          ? body.permissionMode
          : "default",
      };
      try {
        validateSelectors(selectors);
      } catch (e) {
        return errResponse((e as Error).message, 422);
      }
      const sessionId = typeof body.sessionId === "string" && body.sessionId
        ? body.sessionId
        : generateSessionId();
      try {
        const result = await sendTurn(projectRoot, {
          sessionId,
          message,
          model: selectors.model,
          effort: selectors.effort,
          permissionMode: selectors.permissionMode,
          onStreamEvent: (event) => {
            // Per-session channel: stream typed events for chips + bubbles.
            switch (event.type) {
              case "content_block_start": {
                const cb = event.contentBlock;
                if (cb?.type === "tool_use" && cb.id && event.index !== undefined) {
                  broadcastChatSession(sessionId, "chat.tool-use", {
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
                if (d?.type === "text_delta" && typeof d.text === "string") {
                  broadcastChatSession(sessionId, "chat.text-delta", {
                    sessionId,
                    text: d.text,
                  });
                } else if (d?.type === "input_json_delta" && typeof event.index === "number") {
                  broadcastChatSession(sessionId, "chat.tool-input-delta", {
                    sessionId,
                    index: event.index,
                    partialJson: d.partial_json ?? "",
                  });
                }
                break;
              }
              case "message_delta": {
                if (event.delta?.stop_reason) {
                  broadcastChatSession(sessionId, "chat.message-delta", {
                    sessionId,
                    stopReason: event.delta.stop_reason,
                  });
                }
                break;
              }
              case "message_stop": {
                broadcastChatSession(sessionId, "chat.message-done", {
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
        broadcastChat("chat.turn", {
          sessionId: result.sessionId,
          userTurn: result.userTurn,
          assistantTurn: result.assistantTurn,
        });
        broadcastChatSession(result.sessionId, "chat.turn", {
          sessionId: result.sessionId,
          userTurn: result.userTurn,
          assistantTurn: result.assistantTurn,
        });
        return jsonResponse(result, 200);
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
          chatSseControllers.add(ctrl);
          ctrl.enqueue(encoder.encode("event: chat.connected\ndata: {}\n\n"));
        },
        cancel(ctrl) { chatSseControllers.delete(ctrl); },
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
  for (const child of runningProcs.values()) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
  runningProcs.clear();
  chatSseControllers.clear();
  sessionChatSseControllers.clear();
}
