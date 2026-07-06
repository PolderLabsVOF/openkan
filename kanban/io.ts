// OpenKan — low-level filesystem I/O helpers.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Write `data` to `path` atomically:
 * - write to `<path>.tmp`
 * - fsync the temp file
 * - rename to `path`
 * This matches the pattern used in kanban/board.ts:persist.
 */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  try {
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch (_) {}
  renameSync(tmp, path);
}

/** Recursively ensure `dir` exists. Analogous to `mkdir -p`. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Remove any `.tmp` files under `dir` older than `maxAgeMs` (default: 1 hour).
 * Used by initBoard to clean up stale atomic-write temporaries.
 */
export function cleanupStaleTmp(dir: string, maxAgeMs = 60 * 60 * 1000): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".tmp")) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (now - st.mtimeMs > maxAgeMs) {
      try {
        unlinkSync(full);
      } catch {
        // ignore
      }
    }
  }
}

/** Recursively remove a directory (or file), silently ignoring errors. */
export function removeDir(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { force: true, recursive: true });
  } catch {
    // ignore
  }
}
