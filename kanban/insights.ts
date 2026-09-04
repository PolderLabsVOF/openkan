// OpenKan — Insights aggregator. Reads `.ok/changelog.jsonl` and
// produces per-day, per-column move counts for the Insights tab.
//
// `task.moved` payload quirk (see kanban/server.ts:641-646): the existing
// emit writes `payload.from = patch.column`, but at that point `patch.column`
// is the destination, not the source. The aggregator parses the destination
// from the summary string ("moved 'X' to <col>") and infers the source
// from the most recent prior `task.moved` for the same taskId.

import { readEvents } from "./changelog.ts";

export type ColumnId = "backlog" | "todo" | "doing" | "review" | "done";

export const COLUMNS: readonly ColumnId[] = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
] as const;

export interface VelocityBuckets {
  /** YYYY-MM-DD local dates, oldest first. Length === `days`. */
  days: string[];
  backlog: number[];
  todo: number[];
  doing: number[];
  review: number[];
  done: number[];
  /** Window metadata for the response payload. */
  windowDays: number;
  generatedAt: string;
}

const MOVE_DEST_RE = /moved '.*' to (\w+)/;

function zeroBuckets(days: number, generatedAt: string): VelocityBuckets {
  return {
    days: [],
    backlog: new Array<number>(days).fill(0),
    todo: new Array<number>(days).fill(0),
    doing: new Array<number>(days).fill(0),
    review: new Array<number>(days).fill(0),
    done: new Array<number>(days).fill(0),
    windowDays: days,
    generatedAt,
  };
}

/**
 * Build the list of `days` local YYYY-MM-DD strings ending today (inclusive).
 * Oldest first.
 */
function buildDayWindow(days: number, endLocalDate: string): string[] {
  const out: string[] = [];
  // Parse the local YYYY-MM-DD into a Date at noon local time to avoid DST edges.
  const parts = endLocalDate.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  const end = new Date(y, m - 1, d, 12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const t = new Date(end);
    t.setDate(end.getDate() - i);
    const yyyy = t.getFullYear();
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const dd = String(t.getDate()).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}

/** Convert ISO timestamp to local YYYY-MM-DD. Mirrors changelog.ts convention. */
function toLocalDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function indexFor(buckets: VelocityBuckets, localDay: string): number {
  return buckets.days.indexOf(localDay);
}

/** Typed dispatcher: pick the right column-array and add `delta`. */
function addToColumn(b: VelocityBuckets, col: ColumnId, idx: number, delta: number): void {
  if (idx < 0) return;
  switch (col) {
    case "backlog": b.backlog[idx] += delta; return;
    case "todo":    b.todo[idx] += delta; return;
    case "doing":   b.doing[idx] += delta; return;
    case "review":  b.review[idx] += delta; return;
    case "done":    b.done[idx] += delta; return;
  }
}

function isColumn(s: string | undefined): s is ColumnId {
  return !!s && (COLUMNS as readonly string[]).includes(s);
}

/**
 * Compute per-day, per-column move-into counts for the last `days` days,
 * ending today. Reads the changelog via `readEvents`; bad JSONL lines are
 * skipped (parseLine warns and returns null) so one corrupt line does
 * not abort the computation.
 *
 * Returns zero-filled arrays when the changelog is missing or empty.
 */
export function computeVelocity(okDir: string, days: number = 30): VelocityBuckets {
  const window = Math.max(1, Math.floor(days));
  const generatedAt = new Date().toISOString();
  const todayLocal = new Date().toLocaleDateString("en-CA");

  const buckets = zeroBuckets(window, generatedAt);
  buckets.days = buildDayWindow(window, todayLocal);

  // Pull a generous slice of events. readEvents filters in-memory and
  // returns newest first; we filter by kind to keep the working set
  // small and trust parseLine to drop bad lines.
  const { events } = readEvents(okDir, {
    kind: ["task.created", "task.moved"],
    limit: 5000,
  });
  if (events.length === 0) return buckets;

  // Track the most recent destination per task (across ALL events, not
  // just the window — we need the state before the first in-window move
  // to infer the source of that first move). We rebuild this from oldest
  // to newest so "most recent prior" is the previous move in the log.
  const lastDest = new Map<string, ColumnId>();
  // Sort oldest-first for the bucketing pass.
  const ordered = [...events].sort((a, b) => a.ts.localeCompare(b.ts));

  for (const ev of ordered) {
    if (ev.kind === "task.created") {
      const col = (ev.payload as { column?: string }).column;
      if (!isColumn(col)) continue;
      const dayIdx = indexFor(buckets, toLocalDay(ev.ts));
      addToColumn(buckets, col, dayIdx, 1);
      // First move's source is treated as null (task created into col).
      lastDest.set(ev.taskId ?? "_anon", col);
    } else if (ev.kind === "task.moved") {
      const match = MOVE_DEST_RE.exec(ev.summary ?? "");
      const dest = match?.[1];
      if (!dest || !isColumn(dest)) continue;
      const dayIdx = indexFor(buckets, toLocalDay(ev.ts));
      addToColumn(buckets, dest, dayIdx, 1);
      // Decrement the prior column (move-out) on the same day.
      const prior = lastDest.get(ev.taskId ?? "_anon");
      if (prior && prior !== dest) {
        addToColumn(buckets, prior, dayIdx, -1);
      }
      lastDest.set(ev.taskId ?? "_anon", dest);
    }
  }

  return buckets;
}
