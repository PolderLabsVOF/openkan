// OpenKan — multi-project registry stored at ~/.config/openkan/projects.json

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { opendir } from "node:fs/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  id: string;           // e.g. "openkan", "sample-kanban-project"
  name: string;         // human-friendly display name
  root: string;         // absolute path to the project root
  addedAt: string;      // ISO timestamp
  lastOpenedAt?: string;
  lastActivityAt?: string;
  active: boolean;      // exactly one true at any time
}

// ─── Registry path ─────────────────────────────────────────────────────────────

let _testingRegistryPath: string | null = null;

export function setRegistryPathForTesting(p: string | null): void {
  _testingRegistryPath = p;
}

export function registryPath(): string {
  if (_testingRegistryPath) return _testingRegistryPath;
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
  const dir = dirname(path);
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

function canonicalRoot(root: string): string {
  try { return realpathSync(resolve(root)); } catch { return resolve(root); }
}

function uniqueId(id: string, used: Set<string>): string {
  const base = id || "project";
  let candidate = base;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

function distinctProjects(projects: ProjectEntry[]): ProjectEntry[] {
  const roots = new Map<string, ProjectEntry>();
  for (const project of projects) {
    const root = canonicalRoot(project.root);
    const prior = roots.get(root);
    if (!prior) roots.set(root, { ...project, root });
    else roots.set(root, {
      ...(project.active ? project : prior), root,
      active: prior.active || project.active,
      lastOpenedAt: [prior.lastOpenedAt, project.lastOpenedAt].filter(Boolean).sort().at(-1),
    });
  }
  const ids = new Set<string>();
  return [...roots.values()].map(project => {
    const id = uniqueId(project.id, ids); ids.add(id);
    return { ...project, id };
  });
}

function projectActivity(project: ProjectEntry): number {
  let latest = Date.parse(project.lastOpenedAt || project.addedAt) || 0;
  const files = [".ok/board.json", ".ok/tasks", ".ok/plans", ".ok/prds", ".ok/changelog.jsonl", ".git/index", ".git/logs/HEAD"];
  // Session turns append to existing files; inspect mtimes, never transcript contents.
  try { for (const name of readdirSync(join(project.root, ".ok/sessions"))) files.push(`.ok/sessions/${name}`); } catch { /* no sessions */ }
  for (const file of files) {
    try { latest = Math.max(latest, statSync(join(project.root, file)).mtimeMs); } catch { /* optional activity source */ }
  }
  return Math.min(latest, Date.now());
}

/** List one entry per physical repository, newest activity first. */
export function listProjects(): ProjectEntry[] {
  // Claude worktrees are execution sandboxes, not independent OpenKan
  // projects. Keep legacy registry entries on disk for compatibility, but
  // never surface them in selectors or overview APIs.
  return distinctProjects(loadRegistry().projects)
    .filter((project) => !isWorktreePath(project.root))
    .map(project => ({ ...project, lastActivityAt: new Date(projectActivity(project)).toISOString() }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function isWorktreePath(root: string): boolean {
  const path = root.replace(/\\/g, "/").toLowerCase();
  if (path.includes("/.claude/worktrees/") || path.includes("/.git/worktrees/") || /\/worktrees\/[^/]+$/.test(path) || /\/(?:wt|worktree)-/i.test(path)) return true;
  // Linked Git worktrees store `.git` as a text file pointing into the main
  // repository's `.git/worktrees/<name>` directory, even when their own root
  // has an innocuous name such as `wt-feature`.
  try {
    const git = join(root, ".git");
    if (existsSync(git) && statSync(git).isFile()) {
      return /gitdir:\s+.*[\\/]\.git[\\/]worktrees[\\/]/i.test(readFileSync(git, "utf-8"));
    }
  } catch { /* unreadable entries remain eligible projects */ }
  return false;
}

/** Return the currently active project, or null. */
export function activeProject(): ProjectEntry | null {
  return listProjects().find(p => p.active) ?? null;
}

/**
 * Set the active project by id.
 * Returns the PREVIOUS active project (or null if none was active).
 * Returns null if the id doesn't exist.
 */
export function setActiveProject(id: string): ProjectEntry | null {
  const reg = { projects: distinctProjects(loadRegistry().projects) };
  const prev = reg.projects.find(p => p.active) ?? null;
  const target = reg.projects.find(p => p.id === id);
  if (!target) return null;

  reg.projects = reg.projects.map(p => ({ ...p, active: p.id === id, ...(p.id === id ? { lastOpenedAt: new Date().toISOString() } : {}) }));
  saveRegistry(reg);
  return prev;
}

/**
 * Add a new project to the registry.
 * Auto-derives `id` from `root` basename if not provided.
 * Sets it as active (deactivates any previous).
 */
export function addProject(input: { id?: string; name: string; root: string }): ProjectEntry {
  const root = canonicalRoot(input.root);
  const now = new Date().toISOString();
  const reg = { projects: distinctProjects(loadRegistry().projects) };
  const existing = reg.projects.find(project => project.root === root);
  const id = existing?.id ?? uniqueId(input.id ?? slugify(basename(root)), new Set(reg.projects.map(project => project.id)));
  const entry: ProjectEntry = {
    ...existing, id, name: input.name, root,
    addedAt: existing?.addedAt || now, lastOpenedAt: now, active: true,
  };
  reg.projects = reg.projects.filter(project => project.root !== root).map(project => ({ ...project, active: false }));
  reg.projects.push(entry);
  saveRegistry(reg);
  return entry;
}

/** Remove a project by id. Returns true if found and removed. */
export function removeProject(id: string): boolean {
  const reg = { projects: distinctProjects(loadRegistry().projects) };
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
 * Returns <root>/.ok
 */
export function projectKanbanDir(p: ProjectEntry): string | null {
  if (!existsSync(p.root)) return null;
  return join(p.root, ".ok");
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

  const registry = { projects: distinctProjects(loadRegistry().projects) };
  const knownRoots = new Set(registry.projects.map((p) => canonicalRoot(p.root)));
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

  // Deduplicate scanned by resolved path BEFORE the loop that adds to registry.
  // This prevents the same repo (found via cwd + suffix-walk overlap, or via
  // multiple suffix iterations pointing to the same physical directory) from
  // being registered multiple times in a single run.
  const seenRoots = new Set<string>();
  const uniqueScanned: string[] = [];
  for (const raw of result.scanned) {
    const resolved = canonicalRoot(raw);
    if (seenRoots.has(resolved)) continue;
    seenRoots.add(resolved);
    uniqueScanned.push(resolved); // store resolved form for consistency
  }

  // Filter against registry
  for (const repoRoot of uniqueScanned) {
    if (isWorktreePath(repoRoot)) continue;
    if (knownRoots.has(repoRoot)) {
      result.alreadyKnown.push(repoRoot);
      continue;
    }
    const id = uniqueId(slugify(basename(repoRoot)), new Set([...registry.projects, ...result.discovered].map(project => project.id)));
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

// ─── Registry cleanup ─────────────────────────────────────────────────────────

export interface CleanupResult {
  before: ProjectEntry[];
  after: ProjectEntry[];
  removed: number;
  deduped: number;
  pruned: number;
}

/**
 * Clean the registry:
 * - Dedup by resolved root (keep first occurrence, or one with active:true if tie)
 * - Dedup by id (same tiebreaker)
 * - Optionally prune entries whose root no longer exists on disk
 * - Optionally persist the cleaned registry
 */
export function cleanupRegistry(opts?: {
  pruneMissing?: boolean;
  verbose?: boolean;
  persist?: boolean;
}): CleanupResult {
  const verbose = opts?.verbose ?? false;
  const pruneMissing = opts?.pruneMissing ?? false;
  const persist = opts?.persist ?? false;

  const reg = loadRegistry();
  const before = reg.projects;

  if (verbose) console.error(`[cleanupRegistry] before: ${before.length} entries`);

  // Phase 1: dedup by resolved root — keep first (or active:true) occurrence
  const rootSeen = new Map<string, ProjectEntry>();
  const rootDeduped: number[] = []; // indices of duplicates
  for (let i = 0; i < before.length; i++) {
    const resolved = resolve(before[i].root);
    const existing = rootSeen.get(resolved);
    if (!existing) {
      rootSeen.set(resolved, before[i]);
    } else {
      // Keep the one with active:true if there's a tie
      if (existing.active && !before[i].active) {
        // existing wins — mark current as dup
        rootDeduped.push(i);
        if (verbose) console.error(`[cleanupRegistry] root dedup: ${resolved} (kept existing active)`);
      } else if (!existing.active && before[i].active) {
        // current wins — replace
        rootSeen.set(resolved, before[i]);
        rootDeduped.push(i);
        if (verbose) console.error(`[cleanupRegistry] root dedup: ${resolved} (replaced with active)`);
      } else {
        // Neither active or both active — keep first, mark current as dup
        rootDeduped.push(i);
        if (verbose) console.error(`[cleanupRegistry] root dedup: ${resolved} (kept first)`);
      }
    }
  }
  let after = before.filter((_, i) => !rootDeduped.includes(i));

  // Phase 2: dedup by id — keep first (or active:true)
  const idSeen = new Map<string, ProjectEntry>();
  const idDeduped: number[] = [];
  for (let i = 0; i < after.length; i++) {
    const entry = after[i];
    const existing = idSeen.get(entry.id);
    if (!existing) {
      idSeen.set(entry.id, entry);
    } else {
      // Same id but different root — tiebreak by active
      if (existing.active && !entry.active) {
        idDeduped.push(i);
        if (verbose) console.error(`[cleanupRegistry] id dedup: ${entry.id} (kept existing active)`);
      } else if (!existing.active && entry.active) {
        idSeen.set(entry.id, entry);
        idDeduped.push(i);
        if (verbose) console.error(`[cleanupRegistry] id dedup: ${entry.id} (replaced with active)`);
      } else {
        idDeduped.push(i);
        if (verbose) console.error(`[cleanupRegistry] id dedup: ${entry.id} (kept first)`);
      }
    }
  }
  after = after.filter((_, i) => !idDeduped.includes(i));

  // Phase 3: optional prune of missing roots
  let pruned = 0;
  if (pruneMissing) {
    const beforeCount = after.length;
    after = after.filter(p => {
      const exists = existsSync(p.root);
      if (!exists && verbose) console.error(`[cleanupRegistry] prune: ${p.root} does not exist`);
      return exists;
    });
    pruned = beforeCount - after.length;
  }

  if (verbose) {
    console.error(`[cleanupRegistry] after: ${after.length} entries`);
    console.error(`[cleanupRegistry] deduped: ${rootDeduped.length + idDeduped.length}`);
    console.error(`[cleanupRegistry] pruned: ${pruned}`);
  }

  if (persist) {
    saveRegistry({ projects: after });
    if (verbose) console.error(`[cleanupRegistry] persisted cleaned registry to ${registryPath()}`);
  }

  return {
    before,
    after,
    removed: before.length - after.length,
    deduped: rootDeduped.length + idDeduped.length,
    pruned,
  };
}
