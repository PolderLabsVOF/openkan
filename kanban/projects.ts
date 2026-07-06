// OpenKan — multi-project registry stored at ~/.config/openkan/projects.json

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { opendir } from "node:fs/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  id: string;           // e.g. "openkan", "sample-kanban-project"
  name: string;         // human-friendly display name
  root: string;         // absolute path to the project root
  addedAt: string;      // ISO timestamp
  active: boolean;      // exactly one true at any time
}

// ─── Registry path ─────────────────────────────────────────────────────────────

export function registryPath(): string {
  const configDir = join(homedir(), ".config", "openkan");
  return join(configDir, "projects.json");
}

// ─── Low-level load/save ──────────────────────────────────────────────────────

export function loadRegistry(): { projects: ProjectEntry[] } {
  const path = registryPath();
  if (!existsSync(path)) return { projects: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as { projects: ProjectEntry[] };
  } catch {
    return { projects: [] };
  }
}

export function saveRegistry(reg: { projects: ProjectEntry[] }): void {
  const path = registryPath();
  const dir = join(homedir(), ".config", "openkan");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(reg, null, 2), "utf-8");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all registered projects. */
export function listProjects(): ProjectEntry[] {
  return loadRegistry().projects;
}

/** Return the currently active project, or null. */
export function activeProject(): ProjectEntry | null {
  const reg = loadRegistry();
  return reg.projects.find(p => p.active) ?? null;
}

/**
 * Set the active project by id.
 * Returns the PREVIOUS active project (or null if none was active).
 * Returns null if the id doesn't exist.
 */
export function setActiveProject(id: string): ProjectEntry | null {
  const reg = loadRegistry();
  const prev = reg.projects.find(p => p.active) ?? null;
  const target = reg.projects.find(p => p.id === id);
  if (!target) return null;

  reg.projects = reg.projects.map(p => ({ ...p, active: p.id === id }));
  saveRegistry(reg);
  return prev;
}

/**
 * Add a new project to the registry.
 * Auto-derives `id` from `root` basename if not provided.
 * Sets it as active (deactivates any previous).
 */
export function addProject(input: { id?: string; name: string; root: string }): ProjectEntry {
  const id = input.id ?? slugify(basename(input.root));
  const now = new Date().toISOString();

  const reg = loadRegistry();
  // Deactivate all others
  reg.projects = reg.projects.map(p => ({ ...p, active: false }));

  const entry: ProjectEntry = {
    id,
    name: input.name,
    root: input.root,
    addedAt: now,
    active: true,
  };
  reg.projects.push(entry);
  saveRegistry(reg);
  return entry;
}

/** Remove a project by id. Returns true if found and removed. */
export function removeProject(id: string): boolean {
  const reg = loadRegistry();
  const idx = reg.projects.findIndex(p => p.id === id);
  if (idx === -1) return false;

  const wasActive = reg.projects[idx].active;
  reg.projects.splice(idx, 1);

  // If removed was active, activate the first remaining (or none)
  if (wasActive && reg.projects.length > 0) {
    reg.projects[0].active = true;
  }

  saveRegistry(reg);
  return true;
}

/**
 * Resolve a project's openkan dir. Returns null if root doesn't exist.
 * Returns <root>/.openkan
 */
export function projectKanbanDir(p: ProjectEntry): string | null {
  if (!existsSync(p.root)) return null;
  return join(p.root, ".openkan");
}

// ─── Auto-detect interfaces ────────────────────────────────────────────────────

export interface ScanOptions {
  homes?: string[];
  suffixes?: string[];
  maxDepth?: number;
  maxResults?: number;
  skipHidden?: boolean;
  skipDirs?: string[];
  timeout?: number;
}

export interface AutoDetectOptions extends ScanOptions {}

export interface AutoDetectScanResult {
  scanned: string[];
  discovered: ProjectEntry[];
  alreadyKnown: string[];
}

// ─── Auto-detect helpers ──────────────────────────────────────────────────────

const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next",
  ".cache", ".npm", ".local", ".config", "openkan-test",
]);

/**
 * Walk upward from `cwd` looking for a `.git` file or directory.
 * Returns the repo root (parent of `.git`) or null if not found.
 */
export async function findClosestGitRepo(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  const root = resolve("/");

  while (dir !== root) {
    try {
      const stat = statSync(join(dir, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        return dir;
      }
    } catch {
      // No .git here, walk up
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Synchronous walk of `dir` up to `maxDepth` levels, returning git repo roots.
 * Respects skipHidden and skipDirs options.
 */
function walkForGitRepos(
  dir: string,
  maxDepth: number,
  currentDepth: number,
  skipHidden: boolean,
  skipDirs: Set<string>,
  results: string[],
  maxResults: number,
): void {
  if (results.length >= maxResults) return;
  if (currentDepth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    // Check hidden
    if (skipHidden && entry.startsWith(".")) continue;

    // Check skip dirs
    if (skipDirs.has(entry)) continue;

    const fullPath = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Check if it's a git repo directly
      const gitPath = join(fullPath, ".git");
      let isGitRepo = false;
      try {
        const gitStat = statSync(gitPath);
        isGitRepo = gitStat.isDirectory() || gitStat.isFile();
      } catch {
        // Not a git repo
      }

      if (isGitRepo) {
        results.push(fullPath);
        // Don't recurse into git repos
        continue;
      }

      // Recurse into subdirectories (at next depth level)
      if (currentDepth < maxDepth) {
        walkForGitRepos(fullPath, maxDepth, currentDepth + 1, skipHidden, skipDirs, results, maxResults);
      }
    }
  }
}

/**
 * Scan common locations for git repositories.
 * Returns the list of discovered repo root paths (not deduplicated).
 */
export async function scanForGitRepos(opts?: ScanOptions): Promise<string[]> {
  const homes = opts?.homes ?? [homedir()];
  const suffixes = opts?.suffixes ?? ["projects", "work", "repos", "src", "code", "Documents"];
  const maxDepth = opts?.maxDepth ?? 2;
  const maxResults = opts?.maxResults ?? 50;
  const skipHidden = opts?.skipHidden ?? true;
  const skipDirs = new Set(opts?.skipDirs ?? [...DEFAULT_SKIP_DIRS]);

  const results: string[] = [];

  // Start from cwd
  const cwd = process.cwd();
  const cwdRepo = await findClosestGitRepo(cwd);
  if (cwdRepo) results.push(cwdRepo);

  // Walk each home directory's suffixes
  for (const home of homes) {
    for (const suffix of suffixes) {
      if (results.length >= maxResults) break;
      const dir = join(home, suffix);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      walkForGitRepos(dir, maxDepth, 0, skipHidden, skipDirs, results, maxResults);
    }
  }

  return results;
}

/**
 * Auto-detect git repositories and register new ones in the project registry.
 * Does NOT make any project active; does NOT modify existing entries.
 */
export async function autoDetectProjects(opts?: AutoDetectOptions): Promise<AutoDetectScanResult> {
  const homes = opts?.homes ?? [homedir()];
  const suffixes = opts?.suffixes ?? ["projects", "work", "repos", "src", "code", "Documents"];
  const maxDepth = opts?.maxDepth ?? 2;
  const maxResults = opts?.maxResults ?? 50;
  const skipHidden = opts?.skipHidden ?? true;
  const skipDirs = new Set(opts?.skipDirs ?? [...DEFAULT_SKIP_DIRS]);

  const registry = loadRegistry();
  const knownRoots = new Set(registry.projects.map((p) => resolve(p.root)));
  const result: AutoDetectScanResult = { scanned: [], discovered: [], alreadyKnown: [] };

  // Start from cwd
  const cwd = process.cwd();
  const cwdRepo = await findClosestGitRepo(cwd);
  if (cwdRepo) result.scanned.push(cwdRepo);

  // Walk each home directory's suffixes
  for (const home of homes) {
    for (const suffix of suffixes) {
      if (result.scanned.length >= maxResults) break;
      const dir = join(home, suffix);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      walkForGitRepos(dir, maxDepth, 0, skipHidden, skipDirs, result.scanned, maxResults);
    }
  }

  // Deduplicate scanned
  const uniqueScanned = [...new Set(result.scanned)];

  // Filter against registry
  for (const repoRoot of uniqueScanned) {
    if (knownRoots.has(resolve(repoRoot))) {
      result.alreadyKnown.push(repoRoot);
      continue;
    }
    const id = slugify(basename(repoRoot));
    const entry: ProjectEntry = {
      id,
      name: basename(repoRoot),
      root: repoRoot,
      addedAt: new Date().toISOString(),
      active: false,
    };
    result.discovered.push(entry);
    if (result.discovered.length >= maxResults) break;
  }

  // Persist new discoveries
  if (result.discovered.length > 0) {
    registry.projects = [...registry.projects, ...result.discovered];
    saveRegistry(registry);
  }

  return result;
}

// ─── Active project root resolution ──────────────────────────────────────────

/**
 * Return the active project's root, or process.cwd() if none is set
 * or the active root doesn't exist on disk.
 */
export function getActiveProjectRoot(): string {
  const active = activeProject();
  if (!active) return process.cwd();
  if (!existsSync(active.root)) return process.cwd();
  return active.root;
}
