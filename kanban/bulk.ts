// OpenKan — bulk batch operations across multiple tasks.

import { join } from "path";
import { getBoard, withWrite, renormalizeOrder, nowIso, KANBAN_DIR, type Board, type Task } from "./board.ts";
import { removeDir } from "./io.ts";
import { writeTaskMdx } from "./mdx.ts";
import { recordEvent } from "./changelog.ts";
import type { Priority, Category } from "./tags.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type BulkOperation =
  | { kind: "move"; taskIds: string[]; column: string; order?: number }
  | { kind: "set-priority"; taskIds: string[]; priority: Priority }
  | { kind: "set-category"; taskIds: string[]; category: Category }
  | { kind: "add-tags"; taskIds: string[]; tags: string[] }
  | { kind: "remove-tag"; taskIds: string[]; tag: string }
  | { kind: "assign"; taskIds: string[]; assignee: string }
  | { kind: "archive"; taskIds: string[] }
  | { kind: "restore"; taskIds: string[] }
  | { kind: "delete"; taskIds: string[] };

export interface BulkApplied {
  taskId: string;
  kind: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface BulkSkipped {
  taskId: string;
  kind: string;
  reason: string;
}

export interface BulkSummary {
  moved: number;
  tagged: number;
  archived: number;
  deleted: number;
  skipped: number;
}

export interface BulkResult {
  applied: BulkApplied[];
  skipped: BulkSkipped[];
  summary: BulkSummary;
}

// ─── Apply bulk ─────────────────────────────────────────────────────────────

/**
 * Apply a bulk operation to the board atomically.
 *
 * - Uses `withWrite` for a single atomic board mutation.
 * - Writes per-task MDX for every affected task.
 * - Records ONE `kanban.bulk` changelog event with the full diff.
 */
export async function applyBulk(board: Board, operation: BulkOperation): Promise<BulkResult> {
  const applied: BulkApplied[] = [];
  const skipped: BulkSkipped[] = [];

  // Collect task directories to delete AFTER withWrite (can't delete inside withWrite
  // because the board is still referenced)
  const toDelete: Array<{ taskId: string; before: Record<string, unknown> }> = [];

  await withWrite(async (b) => {
    for (const taskId of operation.taskIds) {
      const t = b.tasks.find(x => x.id === taskId);
      if (!t) {
        skipped.push({ taskId, kind: operation.kind, reason: "Task not found" });
        continue;
      }

      const before = snapshot(t);

      try {
        switch (operation.kind) {
          case "move": {
            t.column = operation.column as Task["column"];
            if (typeof operation.order === "number") t.order = operation.order;
            break;
          }
          case "set-priority": {
            t.priority = operation.priority;
            break;
          }
          case "set-category": {
            t.category = operation.category;
            break;
          }
          case "add-tags": {
            t.tags = [...new Set([...t.tags, ...operation.tags])];
            break;
          }
          case "remove-tag": {
            t.tags = t.tags.filter(tag => tag !== operation.tag);
            break;
          }
          case "assign": {
            if (!t.assignees) t.assignees = [];
            if (!t.assignees.includes(operation.assignee)) {
              t.assignees = [...t.assignees, operation.assignee];
            }
            break;
          }
          case "archive": {
            t.archived = true;
            break;
          }
          case "restore": {
            t.archived = false;
            break;
          }
          case "delete": {
            // Capture before snapshot, then remove from board
            toDelete.push({ taskId, before });
            const idx = b.tasks.findIndex(x => x.id === taskId);
            if (idx !== -1) b.tasks.splice(idx, 1);
            break;
          }
        }

        // Skip setting updatedAt / snapshot for delete — already handled above
        if (operation.kind !== "delete") {
          t.updatedAt = nowIso();
          const after = snapshot(t);
          applied.push({ taskId, kind: operation.kind, before, after });
        }
      } catch (e: unknown) {
        skipped.push({ taskId, kind: operation.kind, reason: String(e) });
      }
    }

    // Renormalize if any move operation occurred
    if (applied.some(a => a.kind === "move")) {
      b.tasks = renormalizeOrder(b.tasks);
    }
  });

  // Write MDX for non-delete operations
  const boardAfter = await getBoard();
  for (const a of applied) {
    const t = boardAfter.tasks.find(x => x.id === a.taskId);
    if (t) {
      await writeTaskMdx(t, KANBAN_DIR, boardAfter);
    }
  }

  // Delete task directories for delete operations
  for (const { taskId } of toDelete) {
    const taskDir = join(KANBAN_DIR, "tasks", taskId);
    removeDir(taskDir);
  }

  // Add delete operations to applied list with before snapshot
  for (const { taskId, before } of toDelete) {
    applied.push({ taskId, kind: "delete", before, after: undefined });
  }

  const summary: BulkSummary = {
    moved: applied.filter(a => a.kind === "move").length,
    tagged: applied.filter(a => ["add-tags", "remove-tag", "set-priority", "set-category", "assign"].includes(a.kind)).length,
    archived: applied.filter(a => ["archive", "restore"].includes(a.kind)).length,
    deleted: toDelete.length,
    skipped: skipped.length,
  };

  if (applied.length > 0) {
    recordEvent(KANBAN_DIR, "kanban.bulk", {
      author: "user",
      summary: `bulk ${operation.kind} on ${applied.length} task(s)`,
      payload: { operation: operation.kind, applied, skipped },
    });
  }

  return { applied, skipped, summary };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function snapshot(t: Task): Record<string, unknown> {
  return {
    column: t.column,
    order: t.order,
    priority: t.priority,
    category: t.category,
    tags: [...t.tags],
    assignees: [...(t.assignees ?? [])],
    archived: t.archived,
    state: t.state,
  };
}
