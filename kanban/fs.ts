// kanban/fs.ts — file-system helpers for the browser

import { readdirSync, statSync, lstatSync, readlinkSync, realpathSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FsEntry {
  name: string;           // basename
  path: string;           // absolute
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;           // bytes; 0 for dirs
  mtime: string;          // ISO
  children?: FsEntry[];  // only if isDir && recurse
}

export interface FsListOptions {
  root: string;            // absolute path
  depth?: number;          // default 1; 0 = just root entry
  includeHidden?: boolean; // default false
  followSymlinks?: boolean; // default false — security: symlinks are NOT followed
  maxEntries?: number;    // default 500 per directory
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Realpath but returns undefined on error (e.g. broken symlink). */
function safeRealpath(p: string): string | undefined {
  try { return realpathSync(p); }
  catch { return undefined; }
}

/** Build a single FsEntry from a path (without children). */
function entryFromPath(absPath: string): FsEntry | null {
  try {
    // Use lstatSync to detect symlinks without following them
    const lst = lstatSync(absPath, { throwIfNoEntry: false });
    if (!lst) return null;
    const isSymlink = lst.isSymbolicLink();
    // Use statSync to get the type of the target (follows symlinks)
    const st = statSync(absPath, { throwIfNoEntry: false });
    if (!st) return null;

    return {
      name: basename(absPath),
      path: absPath,
      isDir: st.isDirectory(),
      isFile: st.isFile(),
      isSymlink,
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Scan a single directory and return sorted FsEntry[] (no children).
 * Caps at maxEntries.
 */
function scanDir(
  dirPath: string,
  includeHidden: boolean,
  maxEntries: number,
): FsEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath, { encoding: "utf8", withFileTypes: false });
  } catch {
    return [];
  }

  const result: FsEntry[] = [];
  const sorted = [...entries].sort();

  for (const name of sorted) {
    if (result.length >= maxEntries) break;
    // Skip . and .. entries returned by readdirSync
    if (name === "." || name === "..") continue;
    if (!includeHidden && name.startsWith(".")) continue;

    const absPath = join(dirPath, name);
    const entry = entryFromPath(absPath);
    if (entry) result.push(entry);
  }

  return result;
}

// ─── Security helpers ─────────────────────────────────────────────────────────

const DENY_LIST = ["/etc", "/proc", "/sys", "/dev", "/boot", "/root"] as const;

export type DenyPrefix = typeof DENY_LIST[number];

/** Check if a path starts with a deny-listed prefix. */
export function isDenyListed(path: string): boolean {
  const abs = resolve(path);
  return (DENY_LIST as readonly string[]).some(prefix => abs === prefix || abs.startsWith(prefix + "/"));
}

/** Canonicalize a symlink and check if it resolves inside an allowed tree. */
export function realPathIfAllowed(path: string): { realPath: string; allowed: boolean } {
  const abs = resolve(path);
  const real = safeRealpath(abs);
  if (!real) return { realPath: abs, allowed: false };
  if (isDenyListed(real)) return { realPath: real, allowed: false };
  return { realPath: real, allowed: true };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Walk a directory tree up to `depth` levels.
 * - Hidden files (starting with `.`) excluded by default.
 * - Symlinks are noted but NOT followed (security).
 * - Each directory caps at `maxEntries` entries.
 */
export async function listFs(opts: FsListOptions): Promise<FsEntry> {
  const {
    root,
    depth = 1,
    includeHidden = false,
    followSymlinks = false,
    maxEntries = 500,
  } = opts;

  const absRoot = resolve(root);

  function buildEntry(absPath: string, currentDepth: number): FsEntry | null {
    const entry = entryFromPath(absPath);
    if (!entry) return null;

    if (entry.isDir && currentDepth < depth) {
      const children = scanDir(absPath, includeHidden, maxEntries);
      entry.children = children.flatMap(child => {
        const built = buildEntry(child.path, currentDepth + 1);
        return built !== null ? [built] : [];
      });
    }

    return entry;
  }

  const rootEntry = buildEntry(absRoot, 0);
  if (!rootEntry) {
    return {
      name: basename(absRoot),
      path: absRoot,
      isDir: false,
      isFile: false,
      isSymlink: false,
      size: 0,
      mtime: new Date(0).toISOString(),
      children: [],
    };
  }

  return rootEntry;
}

/**
 * Return the user's home directory and its top-level entries (depth 1).
 */
export async function readHome(): Promise<{ home: string; entries: FsEntry[] }> {
  const home = os.homedir();
  const absHome = resolve(home);

  const rootEntry = await listFs({
    root: absHome,
    depth: 1,
    includeHidden: false,
    followSymlinks: false,
    maxEntries: 500,
  });

  return {
    home: absHome,
    entries: rootEntry.children ?? [],
  };
}

/**
 * Return ancestor entries for `path` up to `maxDepth` levels (each depth 0, no children).
 * Used for breadcrumb display.
 * Note: The path itself is NOT included — only its parent directories.
 */
export function parents(path: string, maxDepth: number): FsEntry[] {
  const absPath = resolve(path);

  // Split by "/" to get segments (works on all platforms since absPath uses forward slashes)
  const raw = absPath.split("/").filter(Boolean);
  // raw = ["home", "drb0rk", "Projects", "openkan", ".ok"] for /home/drb0rk/Projects/openkan/.ok

  const result: FsEntry[] = [];

  // Build each ancestor by accumulating segments from root
  for (let i = 0; i < raw.length - 1 && result.length < maxDepth; i++) {
    // Skip raw.length-1 (the leaf) so we only get ancestors
    const accumulated = "/" + raw.slice(0, i + 1).join("/");
    const entry = entryFromPath(accumulated);
    if (entry) result.push(entry);
  }

  return result;
}
