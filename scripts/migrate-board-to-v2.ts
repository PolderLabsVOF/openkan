// scripts/migrate-board-to-v2.ts — Phase 6 of the unified-task-storage plan.
//
// One-shot script: walks the legacy `.ok/board.json` file, converts
// each entry under `tasks[]` into the v2 directory form
// (`.ok/tasks/<id>/task.json`), and backs up the legacy file as
// `.ok/tasks.v1.board.json`. Idempotent: a board.json that's already
// been moved aside is reported as skipped.
//
// Usage:
//   node --experimental-strip-types scripts/migrate-board-to-v2.ts [root]
// where `root` is the project root containing `.ok/`. Defaults to cwd.
//
// This is the board-side counterpart to `scripts/migrate-tasks-to-v2.ts`:
// the latter walks the planning-side flat files (`.ok/tasks/<id>.json`)
// while this script walks the engine-side board.json. They are
// independent and either may run first; together they cover the
// dual-store legacy that Phase 7 retires.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeTaskV2, paths as okPaths } from "../ok/storage.ts";
import { toTaskV2 } from "../kanban/board.ts";

interface LegacyBoardV1 {
  version: number;
  columns: unknown[];
  tasks: Array<{
    id: string;
    title: string;
    description?: string;
    column: "backlog" | "todo" | "doing" | "review" | "done";
    order: number;
    sessionId: string | null;
    agent: string;
    model: string | null;
    status: string;
    state: string;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    artifact: string;
    sessionArtifact: string | null;
    artifacts?: { mdxPath: string; commentsPath: string; inputsPath: string; statePath: string };
    source?: { path: string; line: number; slug: string };
    sourceHash?: string;
    stale?: boolean;
    lastSourceCheck?: string;
    pendingInputs: string[];
    tags: string[];
    category: string;
    priority: string;
    effort: string | null;
    archived: boolean;
    assignees: string[];
    images: string[];
    parentId: string | null;
    subtaskIds: string[];
    offlineMirrorId?: string;
  }>;
  sessions: Record<string, unknown>;
}

interface MigrationReport {
  root: string;
  scanned: number;
  migrated: number;
  skipped: number;
  errors: Array<{ id: string; reason: string }>;
}

export async function migrateBoardToV2(root: string): Promise<MigrationReport> {
  const p = okPaths(root);
  const boardPath = path.join(p.root, "board.json");
  const backupPath = path.join(p.root, "tasks.v1.board.json");
  const report: MigrationReport = { root, scanned: 0, migrated: 0, skipped: 0, errors: [] };

  // Idempotent: if board.json is already gone (moved aside) skip.
  let raw: string;
  try {
    raw = await fs.readFile(boardPath, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return report;
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    report.errors.push({ id: "<board.json>", reason: `invalid JSON: ${e.message}` });
    return report;
  }
  if (!parsed || typeof parsed !== "object") {
    report.errors.push({ id: "<board.json>", reason: "board.json is not an object" });
    return report;
  }
  const board = parsed as LegacyBoardV1;
  const tasks = Array.isArray(board.tasks) ? board.tasks : [];
  report.scanned = tasks.length;

  for (const task of tasks) {
    const id = task.id;
    if (!id || !/^tsk-[A-Za-z0-9_-]+$/.test(id)) {
      report.errors.push({ id: String(id), reason: "task id does not match tsk-<id>" });
      continue;
    }
    const v2File = path.join(p.tasksDir, id, "task.json");
    try {
      // Skip if the v2 form already exists — migration was already done.
      try {
        await fs.access(v2File);
        report.skipped += 1;
        continue;
      } catch { /* not yet migrated */ }
      // Phase 6: use the board.ts `toTaskV2` projection to get a v2
      // record. The projection handles column→status mapping, default
      // values for missing fields, and v2-only field synthesis.
      const v2 = toTaskV2(task as Parameters<typeof toTaskV2>[0]);
      await fs.mkdir(path.join(p.tasksDir, id), { recursive: true });
      await writeTaskV2(p, v2);
      report.migrated += 1;
    } catch (e: any) {
      report.errors.push({ id, reason: e?.message ?? String(e) });
    }
  }

  // Move the legacy board.json aside as a backup. Phase 7's runtime no
  // longer writes tasks to this file; the backup preserves the original
  // state for forensic or rollback purposes until Phase 9 cleanup.
  try {
    await fs.rename(boardPath, backupPath);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      report.errors.push({ id: "<board.json>", reason: `could not move to backup: ${e.message}` });
    }
  }

  return report;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printReport(report: MigrationReport, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`scanned ${report.scanned} task(s) in ${report.root}/.ok/board.json\n`);
  stream.write(`migrated ${report.migrated}, skipped ${report.skipped}, errors ${report.errors.length}\n`);
  if (report.errors.length > 0) {
    stream.write("\nErrors:\n");
    for (const err of report.errors) {
      stream.write(`  ${err.id}: ${err.reason}\n`);
    }
  }
}

export async function cmdMigrateBoardToV2(argv: string[]): Promise<number> {
  const root = argv[0] ?? process.cwd();
  const report = await migrateBoardToV2(root);
  printReport(report);
  return report.errors.length > 0 ? 1 : 0;
}

// `node --experimental-strip-types scripts/migrate-board-to-v2.ts [root]`
if (process.argv[1] && process.argv[1].endsWith("migrate-board-to-v2.ts")) {
  cmdMigrateBoardToV2(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`fatal: ${e?.message ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
