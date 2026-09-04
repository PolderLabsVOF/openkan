#!/usr/bin/env node
// scripts/sanity-check.ts
// OpenKan board sanity check. Catches:
//   - duplicate task IDs
//   - missing source paths (when task has source.path)
//   - stale tasks sitting in `done` column with stale=true
//   - orphaned per-task files on disk (no matching task in board.json)
//   - dangling references in tasks.json / board.json
// Exits non-zero on any error.
//
// Supports OPENKAN_DIR env var for testing (defaults to <cwd>/.ok).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KANBAN_DIR = process.env.OPENKAN_DIR
  ? join(process.env.OPENKAN_DIR)
  : join(process.cwd(), ".ok");

// Project root is the parent of KANBAN_DIR (or cwd when OPENKAN_DIR is not set)
const PROJECT_ROOT = process.env.OPENKAN_DIR
  ? join(process.env.OPENKAN_DIR, "..")
  : process.cwd();

let board: any;
try {
  board = JSON.parse(readFileSync(join(KANBAN_DIR, "board.json"), "utf-8"));
} catch {
  console.error("ERROR: Could not read .ok/board.json");
  process.exit(1);
}

const tasks = board.tasks ?? [];

const errors: string[] = [];
const warnings: string[] = [];

// 1. Duplicate IDs
const ids = new Set<string>();
for (const t of tasks) {
  if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
  ids.add(t.id);
}

// 2. Missing source paths
for (const t of tasks) {
  if (t.source?.path) {
    const abs = join(PROJECT_ROOT, t.source.path);
    if (!existsSync(abs)) {
      errors.push(`task ${t.id} references missing source ${t.source.path}`);
    }
  }
}

// 3. Stale-in-done
for (const t of tasks) {
  if (t.column === "done" && t.stale) {
    errors.push(`task ${t.id} is Done but stale=true; re-import or re-derive`);
  }
}

// 4. Orphaned per-task files
const tasksDir = join(KANBAN_DIR, "tasks");
if (existsSync(tasksDir)) {
  for (const dir of readdirSync(tasksDir)) {
    if (!ids.has(dir)) {
      warnings.push(`orphaned per-task directory: tasks/${dir} (no matching board entry)`);
    }
  }
}

// 5. Dangling references (board references a task id not in tasks)
for (const t of tasks) {
  if (!ids.has(t.id)) errors.push(`board entry references unknown id: ${t.id}`);
}

// Report
console.log(`Sanity check: ${tasks.length} tasks scanned`);
console.log(`  Errors:   ${errors.length}`);
console.log(`  Warnings: ${warnings.length}`);
for (const e of errors) console.log(`  ERROR: ${e}`);
for (const w of warnings) console.log(`  WARN:  ${w}`);
process.exit(errors.length > 0 ? 1 : 0);
