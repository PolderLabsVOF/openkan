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
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Errors we treat as "transient" when renaming on Windows: antivirus,
// indexer, OneDrive sync, or a file watcher can briefly hold the
// destination and surface EPERM/EBUSY/EACCES. Retry briefly with
// backoff; the async helpers continue retrying without blocking the
// caller. Backoff totals ~250ms (10 + 20 + 40 + 80 + 100ms). POSIX
// keeps the fast path — single sync call, no sleeps.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EAGAIN"]);
const RENAME_BACKOFFS_MS = [10, 20, 40, 80, 100];
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Unique tmp suffix: pid+ts+8-hex so concurrent persists don't collide
// with each other or with a Windows orphan from a previous transient
// failure.
function uniqueTmpPath(path: string): string {
  const rand = randomBytes(4).toString("hex");
  return `${path}.tmp-${process.pid}-${Date.now()}-${rand}`;
}

async function renameWithRetryAsync(from: string, to: string): Promise<void> {
  try {
    renameSync(from, to);
    return;
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code;
    if (!code || !TRANSIENT_RENAME_CODES.has(code)) throw e;
  }
  for (const backoffMs of RENAME_BACKOFFS_MS) {
    await sleep(backoffMs);
    try {
      renameSync(from, to);
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code)) throw e;
    }
  }
  renameSync(from, to);
}

async function unlinkWithRetryAsync(p: string): Promise<void> {
  for (const backoffMs of RENAME_BACKOFFS_MS) {
    try {
      unlinkSync(p);
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code && TRANSIENT_RENAME_CODES.has(code)) {
        await sleep(backoffMs);
        continue;
      }
      return;
    }
  }
}

// Sync unlink-with-busy-spin for use inside synchronous helpers that
// can't yield. Bounded total wait to ~250ms; surfaces last error if the
// file remains held.
function unlinkWithBusySpin(p: string): void {
  for (const backoffMs of RENAME_BACKOFFS_MS) {
    try {
      unlinkSync(p);
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code)) {
        // ENOENT etc. — nothing to clean.
        return;
      }
    }
    const until = Date.now() + backoffMs;
    while (Date.now() < until) {
      // tight busy-spin; only entered when rename/unlink sees a
      // Windows-style transient hold.
    }
  }
}

// Write `data` to `path` atomically:
//  - write to `<path>.tmp-<pid>-<ts>-<rand8>` (avoids collisions
//    between concurrent persists and Windows orphan `.tmp`s from prior
//    failures)
//  - fsync temp file
//  - rename to `path`, retrying briefly on EPERM/EBUSY/EACCES so a
//    momentarily-held destination does not leak the helper's tmp
//  - on unrecoverable rename failure, retry-unlink the tmp so the next
//    persist attempt doesn't collide with the orphaned file.
//
// POSIX behavior unchanged (single renameSync on the happy path).
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = uniqueTmpPath(path);
  writeFileSync(tmp, data, "utf-8");
  try {
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch (_) {
    // best effort
  }

  try {
    renameSync(tmp, path);
    return;
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code;
    if (!code || !TRANSIENT_RENAME_CODES.has(code)) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw e;
    }
  }

  // Slow path: hand the retry/unlink dance off to the runtime so the
  // synchronous caller doesn't block while we back off.
  void (async () => {
    try {
      await renameWithRetryAsync(tmp, path);
    } catch {
      await unlinkWithRetryAsync(tmp);
    }
  })();
}

// Recursively ensure `dir` exists. Analogous to `mkdir -p`.
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Remove any `.tmp` files under `dir` older than `maxAgeMs` (default 1h).
// Matches the legacy `<name>.tmp` and the new
// `<name>.tmp-<pid>-<ts>-<rand>` patterns.
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
    if (!entry.endsWith(".tmp") && !/\.tmp-\d+-\d+-[0-9a-f]+$/.test(entry))
      continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > maxAgeMs) rmSync(full, { force: true });
    } catch {
      // ignore
    }
  }
}

// Remove `dir` (file or directory, recursive). No-op if missing.
export function removeDir(dir: string): void {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

// Move `from` to `to`, replacing any existing destination. Synchronous,
// bounded by ~500ms on worst-case Windows holds.
//
// On POSIX, `renameSync` overwrites the destination atomically. On
// Windows it throws EEXIST, so we unlink the destination first and
// retry briefly on transient EPERM/EBUSY/EACCES from antivirus/indexer
// holds. Throws on unrecoverable failure.
export function moveOver(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(`moveOver: source missing: ${from}`);
  }

  // Fast path: destination does not exist. We still allow retry-on-
  // transient because a brand-new destination can briefly get scanned
  // by AV right after creation.
  if (!existsSync(to)) {
    try {
      renameSync(from, to);
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code && !TRANSIENT_RENAME_CODES.has(code)) throw e;
      // Transient error: drop into the retry path below.
    }
  }

  if (existsSync(to)) {
    // EEXIST on Windows — unlink first, then rename. We tolerate EPERM/
    // EBUSY/EACCES on the unlink by busy-spinning briefly.
    try {
      unlinkSync(to);
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        // raced with another delete — fall through to rename
      } else if (code && TRANSIENT_RENAME_CODES.has(code)) {
        unlinkWithBusySpin(to);
      } else {
        throw e;
      }
    }
  }

  try {
    renameSync(from, to);
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code;
    if (!code || !TRANSIENT_RENAME_CODES.has(code)) throw e;
    // Busy-spin retry to keep this synchronous helper bounded.
    for (const backoffMs of RENAME_BACKOFFS_MS) {
      const until = Date.now() + backoffMs;
      while (Date.now() < until) {
        // tight busy-spin; only entered on Windows holds.
      }
      try {
        renameSync(from, to);
        return;
      } catch (e2: unknown) {
        const c2 = (e2 as { code?: string } | null)?.code;
        if (!c2 || !TRANSIENT_RENAME_CODES.has(c2)) throw e2;
      }
    }
    throw e;
  }
}
