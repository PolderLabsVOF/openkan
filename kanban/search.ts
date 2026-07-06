// OpenKan — pure indexed text search across tasks.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBoard, KANBAN_DIR } from "./board.ts";
import type { Task } from "./board.ts";
import type { Priority, Category } from "./tags.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchOptions {
  kanbanDir: string;
  query?: string;          // free text
  column?: string;
  tags?: string[];         // AND — task must include all
  assignee?: string;
  priority?: Priority | "all";
  category?: Category | "all";
  archived?: boolean;       // default false
  limit?: number;           // default 50
  offset?: number;          // default 0
}

export interface TaskWithMatch extends Task {
  matchIn: string[];  // which fields the query matched in
}

export interface SearchResult {
  results: TaskWithMatch[];
  total: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Case-insensitive substring check. */
function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Load raw MDX content for a task, or "" if not found. */
function loadMdxContent(kanbanDir: string, task: Task): string {
  const mdxPath = join(kanbanDir, task.artifacts.mdxPath);
  if (!existsSync(mdxPath)) return "";
  try {
    return readFileSync(mdxPath, "utf-8");
  } catch {
    return "";
  }
}

/** Find which fields in the task match the query string. */
function findMatchIn(task: Task, query: string, mdxContent: string): string[] {
  const fields: string[] = [];
  const q = query.toLowerCase();
  if (matches(task.title, q)) fields.push("title");
  if (matches(task.description, q)) fields.push("description");
  if (task.tags?.some(t => matches(t, q))) fields.push("tags");
  if (task.assignees?.some(a => matches(a, q))) fields.push("assignees");
  if (matches(mdxContent, q)) fields.push("content");
  return fields;
}

// ─── Core search ────────────────────────────────────────────────────────────

/**
 * Pure search across all tasks.
 *
 * Matching:
 * - `query` — matches against title, description, tags, assignees, and MDX content
 *   (case-insensitive substring on each field)
 * - `column` — filters to that column (default: all)
 * - `tags` — AND filter: task must contain ALL listed tags
 * - `assignee` — task must have this name in assignees
 * - `priority` — must match (or "all" to skip)
 * - `category` — must match (or "all" to skip)
 * - `archived` — include archived tasks (default: false)
 * - `limit/offset` — pagination
 *
 * Returns tasks with a `matchIn` array listing which fields the query matched.
 */
export async function search(opts: SearchOptions): Promise<SearchResult> {
  const {
    kanbanDir,
    query = "",
    column,
    tags,
    assignee,
    priority,
    category,
    archived = false,
    limit = 50,
    offset = 0,
  } = opts;

  const board = await getBoard();

  // Pre-load MDX content for all tasks (avoids N sequential reads)
  const mdxCache = new Map<string, string>();
  if (query) {
    for (const task of board.tasks) {
      mdxCache.set(task.id, loadMdxContent(kanbanDir, task));
    }
  }

  const q = query.trim();

  // Filter + match in one pass
  const matched: TaskWithMatch[] = [];

  for (const task of board.tasks) {
    // archived filter
    if (!archived && task.archived) continue;

    // column filter
    if (column && task.column !== column) continue;

    // priority filter
    if (priority && priority !== "all" && task.priority !== priority) continue;

    // category filter
    if (category && category !== "all" && task.category !== category) continue;

    // assignee filter (case-insensitive)
    if (assignee) {
      const found = task.assignees?.some(a => matches(a, assignee)) ?? false;
      if (!found) continue;
    }

    // AND tags filter
    if (tags && tags.length > 0) {
      const taskTagsLower = (task.tags ?? []).map(t => t.toLowerCase());
      const allMatch = tags.every(tag => taskTagsLower.some(t => matches(t, tag)));
      if (!allMatch) continue;
    }

    // text query
    if (q) {
      const mdxContent = mdxCache.get(task.id) ?? "";
      const matchIn = findMatchIn(task, q, mdxContent);
      if (matchIn.length === 0) continue;
      matched.push({ ...task, matchIn });
    } else {
      // no query — return everything passing filters with empty matchIn
      matched.push({ ...task, matchIn: [] });
    }
  }

  // Sort: active tasks first by column order, then archived
  const colOrder = Object.fromEntries(
    board.columns.map((c, i) => [c.id, i])
  );
  matched.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const ca = colOrder[a.column] ?? 99;
    const cb = colOrder[b.column] ?? 99;
    if (ca !== cb) return ca - cb;
    return a.order - b.order;
  });

  const total = matched.length;
  const paginated = matched.slice(offset, offset + limit);

  return { results: paginated, total };
}
