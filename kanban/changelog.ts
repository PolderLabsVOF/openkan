// OpenKan — append-only JSONL changelog.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { writeFileAtomic } from "./io.ts";

export type ChangelogKind =
  | "task.created" | "task.updated" | "task.moved" | "task.deleted"
  | "task.archived" | "task.restored"
  | "task.commented" | "task.comment.resolved" | "task.comment.deleted"
  | "task.input.asked" | "task.input.responded"
  | "task.image-added" | "task.image-deleted"
  | "agent.started" | "agent.ended" | "agent.progress"
  | "git.commit-attributed"
  | "settings.changed" | "kanban.organized" | "kanban.bulk";

export interface ChangelogEvent {
  id: string;           // chg-xxxxxxxx (nanoid)
  ts: string;           // ISO timestamp (local date in byDay)
  kind: ChangelogKind;
  taskId?: string;
  author: string;       // git user.name, "agent:<name>", "user", or "system"
  summary: string;      // one line, e.g. "moved 'Refactor auth' to Review"
  payload: Record<string, unknown>;
}

const CHANGELOG_FILE = "changelog.jsonl";

function changelogPath(kanbanDir: string): string {
  return join(kanbanDir, CHANGELOG_FILE);
}

// Microsecond counter to break timestamp ties (multiple events in same ms)
let _lastTsMs = 0;
let _counter = 0;

function nextCounter(): number {
  const now = Date.now();
  if (now !== _lastTsMs) { _lastTsMs = now; _counter = 0; }
  return _counter++;
}

function makeId(): string {
  return `chg-${nanoid(8)}-${String(nextCounter()).padStart(3, "0")}`;
}

function nowIsoMicro(): string {
  const ts = nextCounter();
  // ISO with 3-digit microseconds appended to millisecond part
  const base = new Date(_lastTsMs).toISOString().replace("Z", "");
  return base + String(ts).padStart(3, "0") + "Z";
}

// ─── Write ─────────────────────────────────────────────────────────────────

/**
 * Append a new event to the changelog.
 * Uses writeFileAtomic only when creating the file for the first time;
 * thereafter uses appendFileSync so a crash mid-write cannot truncate history.
 */
export function recordEvent(
  kanbanDir: string,
  kind: ChangelogKind,
  partial: Omit<ChangelogEvent, "id" | "ts" | "kind">,
): ChangelogEvent {
  const event: ChangelogEvent = {
    id: makeId(),
    ts: nowIsoMicro(),
    kind,
    ...partial,
  };

  const path = changelogPath(kanbanDir);
  const line = JSON.stringify(event) + "\n";

  if (!existsSync(path)) {
    // First write — use atomic to avoid creating a truncated file
    writeFileAtomic(path, line);
  } else {
    // All subsequent writes — append only
    appendFileSync(path, line, "utf-8");
  }

  return event;
}

// ─── Read ──────────────────────────────────────────────────────────────────

/** Parse one non-empty line as JSON; warn to stderr on parse failure. */
function parseLine(line: string): ChangelogEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ChangelogEvent;
  } catch {
    console.warn(`[changelog] Skipping unparseable line: ${trimmed.slice(0, 120)}`);
    return null;
  }
}

/** Kinds that represent terminal / completion events — used for completedOnly filter */
export const COMPLETION_KINDS = new Set<ChangelogKind>([
  "task.deleted",
  "task.archived",
  "task.restored",
  "kanban.organized",
  "git.commit-attributed",
  "agent.ended",
  "settings.changed",
]);

export function readEvents(
  kanbanDir: string,
  opts?: {
    since?: string;
    until?: string;
    kind?: ChangelogKind | ChangelogKind[];
    taskId?: string;
    author?: string;
    limit?: number;
    offset?: number;
    completedOnly?: boolean;  // filter to completion kinds AND tasks currently in "done" column
    kanbanDirForCompletedOnly?: string; // board dir needed to check column state
    reset?: boolean;          // when true, ignore offset and return from start
  },
): { events: ChangelogEvent[]; total: number } {
  const path = changelogPath(kanbanDir);
  if (!existsSync(path)) return { events: [], total: 0 };

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { events: [], total: 0 };
  }

  const all: ChangelogEvent[] = [];
  for (const line of raw.split("\n")) {
    const event = parseLine(line);
    if (event) all.push(event);
  }

  // Filter in-memory; changelog is small enough for v1
  const kinds = opts?.kind
    ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind])
    : null;

  const filtered = all.filter(e => {
    if (opts?.since && e.ts < opts.since) return false;
    if (opts?.until && e.ts > opts.until) return false;
    if (kinds && !kinds.includes(e.kind)) return false;
    if (opts?.taskId && e.taskId !== opts.taskId) return false;
    if (opts?.author && e.author !== opts.author) return false;
    return true;
  });

  // Newest first
  filtered.sort((a, b) => b.ts.localeCompare(a.ts));

  // completedOnly post-filter: only show events for tasks in "done" column, or terminal kinds
  let finalEvents = filtered;
  if (opts?.completedOnly) {
    // Load done-column task IDs from board.json (sync, using already-imported readFileSync)
    const doneTaskIds = new Set<string>();
    if (opts?.kanbanDirForCompletedOnly) {
      try {
        const boardPath = join(opts.kanbanDirForCompletedOnly, "board.json");
        if (existsSync(boardPath)) {
          const board = JSON.parse(readFileSync(boardPath, "utf-8")) as { tasks: Array<{ id: string; column: string }> };
          for (const t of board.tasks) {
            if (t.column === "done") doneTaskIds.add(t.id);
          }
        }
      } catch { /* ignore */ }
    }
    finalEvents = filtered.filter(e => {
      // Always include terminal kinds
      if (COMPLETION_KINDS.has(e.kind)) return true;
      // Include events whose task is currently in done column
      if (e.taskId && doneTaskIds.has(e.taskId)) return true;
      return false;
    });
  }

  const total = finalEvents.length;
  const offset = opts?.reset ? 0 : (opts?.offset ?? 0);
  const limit = opts?.limit ?? 200;
  const events = finalEvents.slice(offset, offset + limit);

  return { events, total };
}

export function readEventById(kanbanDir: string, id: string): ChangelogEvent | null {
  const path = changelogPath(kanbanDir);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  for (const line of raw.split("\n")) {
    const event = parseLine(line);
    if (event && event.id === id) return event;
  }
  return null;
}

// ─── Summary ────────────────────────────────────────────────────────────────

export function readSummary(
  kanbanDir: string,
  opts?: { days?: number },
): {
  byKind: Record<string, number>;
  byAuthor: Record<string, number>;
  byDay: Record<string, number>;  // YYYY-MM-DD (local), not UTC
  total: number;
} {
  const path = changelogPath(kanbanDir);
  const since = opts?.days
    ? new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  const { events } = readEvents(kanbanDir, { since });

  const byKind: Record<string, number> = {};
  const byAuthor: Record<string, number> = {};
  const byDay: Record<string, number> = {}; // YYYY-MM-DD in local time

  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    byAuthor[e.author] = (byAuthor[e.author] ?? 0) + 1;
    // Local date (not UTC) — uses the host timezone
    const d = new Date(e.ts);
    const local = d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
    byDay[local] = (byDay[local] ?? 0) + 1;
  }

  return { byKind, byAuthor, byDay, total: events.length };
}
