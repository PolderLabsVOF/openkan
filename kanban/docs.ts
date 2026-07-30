// OpenKan — docs file tree and read helpers for <projectRoot>/docs/

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Block } from "./mdx-render.ts";
import { renderMdx } from "./mdx-render.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DocEntry {
  path: string;           // relative to docs root, e.g. "milestones/M7.mdx"
  name: string;          // basename
  isDir: boolean;
  size?: number;         // bytes (files only)
  modified?: string;     // ISO mtime (files only)
  children?: DocEntry[]; // directories only
}

export interface DocFile {
  path: string;           // relative path
  html?: string;          // alias for rendered (frontend compatibility)
  rendered?: string;      // rendered HTML (md/mdx) — sanitized
  blocks?: Block[];       // parsed blocks (md/mdx only)
  mtime: string;
  size: number;
  raw?: string;           // raw file contents — only present when render=false
  contentType?: string;   // set when serving raw
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Reject any path that escapes the docs root (contains ".." or resolves outside).
 */
function isSafeRelPath(docsRoot: string, relPath: string): boolean {
  if (relPath.includes("..")) return false;
  const full = resolve(docsRoot, relPath);
  const normalizedRoot = resolve(docsRoot);
  // full must equal the root exactly OR be inside it (start with root + /)
  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + sep)) return false;
  return true;
}

// ─── listDocs ────────────────────────────────────────────────────────────────

function buildEntry(docsRoot: string, relPath: string, depth: number, maxDepth: number): DocEntry | null {
  const full = join(docsRoot, relPath);
  if (!existsSync(full)) return null;

  let st: ReturnType<typeof statSync>;
  try { st = statSync(full); } catch { return null; }

  const name = relPath.split("/").pop() ?? relPath;

  if (!st.isDirectory()) {
    return {
      path: relPath,
      name,
      isDir: false,
      size: st.size,
      modified: st.mtime.toISOString(),
    };
  }

  // Directory
  const children: DocEntry[] = [];
  if (depth < maxDepth) {
    let entries: string[];
    try { entries = readdirSync(full); } catch { entries = []; }
    for (const entry of entries.sort()) {
      // Skip hidden files/dirs
      if (entry.startsWith(".")) continue;
      const childRel = relPath ? `${relPath}/${entry}` : entry;
      const child = buildEntry(docsRoot, childRel, depth + 1, maxDepth);
      if (child) children.push(child);
    }
  }

  return {
    path: relPath,
    name,
    isDir: true,
    children,
  };
}

/**
 * List the docs directory tree.
 * @param opts.root - project root
 * @param opts.docsDir - defaults to "docs"
 * @param opts.maxDepth - defaults to 4
 */
export function listDocs(opts: {
  root: string;
  docsDir?: string;
  maxDepth?: number;
}): { entries: DocEntry[] } {
  const docsRoot = join(opts.root, opts.docsDir ?? "docs");
  const maxDepth = opts.maxDepth ?? 4;

  if (!existsSync(docsRoot)) return { entries: [] };
  if (!isSafeRelPath(docsRoot, ".")) return { entries: [] };

  let entries: DocEntry[] = [];
  let dirEntries: string[];
  try { dirEntries = readdirSync(docsRoot); } catch { return { entries: [] }; }

  for (const entry of dirEntries.sort()) {
    if (entry.startsWith(".")) continue;
    const child = buildEntry(docsRoot, entry, 1, maxDepth);
    if (child) entries.push(child);
  }

  return { entries };
}

// ─── readDoc ─────────────────────────────────────────────────────────────────

/**
 * Read a single doc file, optionally render it.
 * @param opts.root - project root
 * @param opts.relPath - relative to docs root, no leading slash
 * @param opts.render - default true for .md/.mdx
 */
export async function readDoc(opts: {
  root: string;
  docsDir?: string;
  relPath: string;
  render?: boolean;
}): Promise<DocFile> {
  const docsRoot = join(opts.root, opts.docsDir ?? "docs");

  // Security check: reject traversal attempts
  if (!isSafeRelPath(docsRoot, opts.relPath)) {
    throw new Error("Unsafe path");
  }

  const fullPath = resolve(docsRoot, opts.relPath);

  if (!existsSync(fullPath)) throw new Error("File not found");

  let st: ReturnType<typeof statSync>;
  try { st = statSync(fullPath); } catch { throw new Error("File not found"); }
  if (!st.isFile()) throw new Error("Not a file");

  const raw = readFileSync(fullPath, "utf-8");
  const ext = fullPath.split(".").pop()?.toLowerCase() ?? "";
  const doRender = (opts.render ?? true) && (ext === "md" || ext === "mdx");

  const result: DocFile = {
    path: opts.relPath,
    mtime: st.mtime.toISOString(),
    size: st.size,
  };

  if (doRender) {
    const rendered = await renderMdx(raw);
    result.html = rendered.html;
    result.rendered = rendered.html; // back-compat alias
    result.blocks = rendered.blocks;
    result.raw = raw; // keep raw available even in rendered mode
  } else {
    // Raw mode: caller handles content-type; return minimal shape
    result.raw = raw;
    result.contentType = "text/markdown";
  }

  return result;
}
