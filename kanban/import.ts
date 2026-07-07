// OpenKan — checkbox import scanner.
// Scans .md/.mdx files for "- [ ]" checkboxes and produces ScanResult hits.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { createHash } from "node:crypto";

/** Compute a short SHA-256 hex digest (first 16 chars) of file content. */
export function computeSourceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CheckboxHit {
  path: string;       // repo-relative
  line: number;       // 1-indexed
  raw: string;        // text after "- [ ]" or "- [x]", trimmed
  done: boolean;      // true if "- [x]"
}

export interface ScanOptions {
  root: string;
  include?: string[];
  exclude?: string[];
}

export interface ScanResult {
  hits: CheckboxHit[];
  filesScanned: number;
  filesSkipped: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MD_EXTENSIONS = new Set([".md", ".mdx"]);

// Dirs that are always skipped regardless of include/exclude.
const SYSTEM_DIRS = new Set([
  "node_modules", ".git", ".openkan", "dist", ".next",
]);

function isSystemDir(name: string): boolean {
  if (name.startsWith(".") && name !== ".openkan") return true;
  return SYSTEM_DIRS.has(name);
}

/** Recursively collect .md/.mdx files under root, respecting include/exclude. */
export function scanFiles(opts: ScanOptions): { files: string[]; scanned: number; skipped: number } {
  const { root, include = [], exclude = [] } = opts;
  const files: string[] = [];
  let scanned = 0;
  let skipped = 0;

  function matches(pattern: string, name: string): boolean {
    // `**` is a multi-segment wildcard. `*` is a basename wildcard within a segment.
    // We split the pattern at `**` first, then per-segment wildcards go through matchBasename.
    const norm = name.replace(/^\.\//, "");
    const pSegs = pattern.split("/");
    const segs = norm.split("/");
    return matchPath(pSegs, segs);
  }

  function matchPath(pSegs: string[], segs: string[]): boolean {
    if (pSegs.length === 0) return segs.length === 0;
    if (pSegs[0] === "**") {
      for (let k = 0; k <= segs.length; k++) {
        if (matchPath(pSegs.slice(1), segs.slice(k))) return true;
      }
      return false;
    }
    if (segs.length === 0) return false;
    const seg = segs[0];
    if (pSegs[0].includes("*") && !pSegs[0].includes("/")) {
      if (!matchBasename(pSegs[0], seg)) return false;
    } else if (pSegs[0] !== seg) {
      return false;
    }
    return matchPath(pSegs.slice(1), segs.slice(1));
  }

  function matchBasename(pattern: string, name: string): boolean {
    const base = name.split("/").pop() ?? name;
    // Convert glob to anchored regex: `*` → `.*`, `?` → `.`, literals escaped.
    const re = new RegExp(
      "^" + pattern.split("*").map(escapeRegex).join(".*") + "$",
    );
    return re.test(base);
  }

  function escapeRegex(s: string): string {
    return s.replace(/[\\^$.+?()[\]{}|]/g, "\\$&");
  }

  function matchesAny(patterns: string[], relPath: string, baseName: string): boolean {
    for (const p of patterns) {
      if (matches(p, relPath) || matches(p, baseName)) return true;
    }
    return false;
  }

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }

      if (stat.isDirectory()) {
        if (isSystemDir(entry)) { skipped++; continue; }
        walk(full);
      } else if (stat.isFile()) {
        const dot = entry.lastIndexOf(".");
        const ext = dot >= 0 ? entry.slice(dot) : "";
        if (!MD_EXTENSIONS.has(ext)) continue;

        // include/exclude: default to docs/** + *.md + *.mdx
        const defaultInclude = ["docs/**", "*.md", "*.mdx"];
        const effectiveInclude = include.length ? include : defaultInclude;

        const rel = relative(root, full).replace(/\\/g, "/");
        if (effectiveInclude.length && !matchesAny(effectiveInclude, rel, entry)) {
          skipped++; continue;
        }
        if (exclude.length && matchesAny(exclude, rel, entry)) {
          skipped++; continue;
        }
        files.push(full);
        scanned++;
      }
    }
  }

  walk(root);
  return { files, scanned, skipped };
}

// ─── Checkbox parser ─────────────────────────────────────────────────────────

/**
 * Extract all checkbox lines from file content.
 * - Ignores checkboxes inside fenced code blocks (backtick OR tilde fences,
 *   CommonMark style — closing fence must match opener kind).
 * - Matches indented checkboxes (leading whitespace preserved in raw).
 * - `- [x]` (done) → hit.done = true (caller filters as needed).
 */
export function parseCheckboxes(content: string, repoRelPath: string): CheckboxHit[] {
  const hits: CheckboxHit[] = [];
  const lines = content.split("\n");
  // Track which delimiter opened the fence (` for backtick, ~ for tilde),
  // null when not inside a fence. CommonMark: closing fence must use a
  // delimiter that matches the opening one (or any ≥3-length sequence of
  // the same char, but for our purposes same + ≥3 is enough).
  let fenceChar: "`" | "~" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();

    // Detect a fence line: at least three backticks or three tildes, followed by optional info string.
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const opener = fenceMatch[1][0];
      if (fenceChar === null) {
        fenceChar = opener === "`" ? "`" : "~";
        continue;
      }
      // Closing fence must match opener kind.
      if (fenceChar === opener) {
        fenceChar = null;
        continue;
      }
      // Wrong-kind delimiter inside a fence is just content; skip in either case.
      if (fenceChar !== null) continue;
    }
    if (fenceChar !== null) continue;

    // - [ ] or - [x] — allow leading whitespace
    const m = trimmed.match(/^-\s*\[([ x])\]\s*(.*)$/);
    if (!m) continue;

    const done = m[1] === "x";
    const text = m[2].trim();
    hits.push({
      path: repoRelPath,
      line: i + 1,   // 1-indexed
      raw: text,
      done,
    });
  }

  return hits;
}

// ─── Stable ID ───────────────────────────────────────────────────────────────

/** Format a stable, deterministic import ID from a checkbox hit. */
export function stableImportId(hit: CheckboxHit): string {
  const slug = slugFromRaw(hit.raw);
  const input = `${hit.path}:${hit.line}:${slug}`;
  const short = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return `imp-${short}`;
}

/** Derive a URL-safe slug from checkbox raw text. */
export function slugFromRaw(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "untitled";
}
