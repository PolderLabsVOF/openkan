#!/usr/bin/env node
// scripts/sanity-check.ts
// OpenKan board sanity check. Catches:
//   - duplicate task IDs
//   - missing source paths (when task has source.path)
//   - stale tasks sitting in `done` column with stale=true
//   - orphaned per-task directories on disk (no matching v2 entry)
//   - dangling references between tasks (parent/subtask links)
// Exits non-zero on any error.
//
// Phase 7: reads the canonical v2 directory form
// (`.ok/tasks/<id>/task.json`) instead of the legacy `board.tasks`
// array. Tasks no longer live on board.json post-Phase-7; board.json
// is metadata-only (columns, sessions, version).
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

let board: any = {};
try {
  board = JSON.parse(readFileSync(join(KANBAN_DIR, "board.json"), "utf-8"));
} catch {
  // board.json may be missing in fresh repos; don't fail the scan.
  board = {};
}

// Phase 7: load tasks from .ok/tasks/<id>/task.json. Falls back to the
// legacy board.tasks array so older boards still produce a meaningful
// scan until the migration runs.
const tasks: any[] = [];
const tasksDir = join(KANBAN_DIR, "tasks");
if (existsSync(tasksDir)) {
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const v2File = join(tasksDir, entry.name, "task.json");
    try {
      const t = JSON.parse(readFileSync(v2File, "utf-8"));
      if (t && t.id) tasks.push(t);
    } catch { /* malformed — skip */ }
  }
}
if (tasks.length === 0 && Array.isArray(board.tasks)) {
  for (const t of board.tasks) tasks.push(t);
}

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

// 4. Orphaned per-task directories (no matching v2 entry). The check
// excludes legacy v1 flat files (`.ok/tasks/<id>.json`) and the
// already-validated v2 dirs that contain a `task.json`.
if (existsSync(tasksDir)) {
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!ids.has(entry.name)) {
      warnings.push(`orphaned per-task directory: tasks/${entry.name} (no matching v2 task entry)`);
    }
  }
}

// 5. Dangling parentId / subtaskIds references
for (const t of tasks) {
  if (t.parentId && !ids.has(t.parentId)) {
    errors.push(`task ${t.id} has dangling parentId: ${t.parentId}`);
  }
  for (const sid of t.subtaskIds ?? []) {
    if (!ids.has(sid)) {
      errors.push(`task ${t.id} has dangling subtaskId: ${sid}`);
    }
  }
}

// Report
console.log(`Sanity check: ${tasks.length} tasks scanned`);
console.log(`  Errors:   ${errors.length}`);
console.log(`  Warnings: ${warnings.length}`);
for (const e of errors) console.log(`  ERROR: ${e}`);
for (const w of warnings) console.log(`  WARN:  ${w}`);
process.exit(errors.length > 0 ? 1 : 0);
