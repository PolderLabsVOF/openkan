// scripts/migrate-tasks-to-v2.ts — Phase 3 of the unified-task-storage plan.
//
// One-shot script: walks `.ok/tasks/tsk-*.json` (legacy v1 flat files),
// converts each into the v2 directory form (`.ok/tasks/<id>/task.json`),
// and backs up the original as `.ok/tasks/<id>/task.v1.json` inside the
// new directory. Idempotent: a task with both v2 and v1 backup already in
// place is reported as skipped.
//
// Usage:
//   node --experimental-strip-types scripts/migrate-tasks-to-v2.ts [root]
// where `root` is the project root containing `.ok/`. Defaults to cwd.
//
// Exit code is 0 on success, 1 if any task fails to migrate. The script
// never aborts mid-run on a single failure; it logs the error and
// continues so partial progress is preserved and the operator can
// inspect the offending file.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isTask, convertTaskV1ToV2 } from "../ok/schemas.ts";
import { paths as okPaths, writeTaskV2 } from "../ok/storage.ts";

interface MigrationReport {
  root: string;
  scanned: number;
  migrated: number;
  skipped: number;
  errors: Array<{ id: string; reason: string }>;
}

async function listV1FlatFiles(tasksDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(tasksDir);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => /^tsk-[A-Za-z0-9_-]+\.json$/.test(n));
}

export async function migrateTasksToV2(root: string): Promise<MigrationReport> {
  const p = okPaths(root);
  const report: MigrationReport = { root, scanned: 0, migrated: 0, skipped: 0, errors: [] };
  const flat = await listV1FlatFiles(p.tasksDir);
  report.scanned = flat.length;
  for (const file of flat) {
    const id = file.replace(/\.json$/, "");
    const src = path.join(p.tasksDir, file);
    const dir = path.join(p.tasksDir, id);
    const v2File = path.join(dir, "task.json");
    const backup = path.join(dir, "task.v1.json");
    try {
      // Skip if the v2 form already exists — migration was already done.
      try {
        await fs.access(v2File);
        report.skipped += 1;
        continue;
      } catch { /* not yet migrated */ }
      const raw = await fs.readFile(src, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e: any) {
        report.errors.push({ id, reason: `invalid JSON: ${e.message}` });
        continue;
      }
      if (!isTask(parsed)) {
        report.errors.push({ id, reason: "file does not match ok.task.v1 schema" });
        continue;
      }
      // Phase 3: convert v1 → v2 via the schema helper and write the
      // directory form. writeTaskV2 creates the directory and writes
      // task.json atomically. We deliberately do NOT call `writeTask`
      // (which dual-writes) — migration is the v1→v2 promotion step
      // and should leave the legacy flat file as `task.v1.json` (the
      // backup) rather than a duplicate `.ok/tasks/<id>.json`.
      const v2 = convertTaskV1ToV2(parsed);
      await fs.mkdir(dir, { recursive: true });
      await writeTaskV2(p, v2);
      // Move the legacy flat file into the new directory as backup.
      await fs.rename(src, backup);
      report.migrated += 1;
    } catch (e: any) {
      report.errors.push({ id, reason: e?.message ?? String(e) });
    }
  }
  return report;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printReport(report: MigrationReport, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`scanned ${report.scanned} legacy v1 file(s) in ${report.root}/.ok/tasks\n`);
  stream.write(`migrated ${report.migrated}, skipped ${report.skipped}, errors ${report.errors.length}\n`);
  if (report.errors.length > 0) {
    stream.write("\nErrors:\n");
    for (const err of report.errors) {
      stream.write(`  ${err.id}: ${err.reason}\n`);
    }
  }
}

export async function cmdMigrateTasksToV2(argv: string[]): Promise<number> {
  const root = argv[0] ?? process.cwd();
  const report = await migrateTasksToV2(root);
  printReport(report);
  return report.errors.length > 0 ? 1 : 0;
}

// `node --experimental-strip-types scripts/migrate-tasks-to-v2.ts [root]`
if (process.argv[1] && process.argv[1].endsWith("migrate-tasks-to-v2.ts")) {
  cmdMigrateTasksToV2(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`fatal: ${e?.message ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
