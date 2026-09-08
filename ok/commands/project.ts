// ok/commands/project.ts — `ok project list|use <id>|clean`.

import { resolve } from "node:path";
import { parseArgs } from "./serve.ts";
import { apiBaseUrl, cmdApi } from "./api.ts";
import { listProjects, cleanupRegistry, loadRegistry, saveRegistry, canonicalRoot } from "../../kanban/projects.ts";
import { existsSync } from "node:fs";

export async function cmdProject(argv: string[]): Promise<void> {
  if (argv[0] === "list") return cmdApi(["/api/projects", "--json", ...argv.slice(1)]);
  if (argv[0] === "use" && argv[1]) {
    const args = parseArgs(["use", ...argv.slice(1)]);
    const id = args.positionals[0];
    if (!id) throw new Error("Usage: ok project use <id>");
    // Verify the active project matches cwd before mutating dashboard state.
    const response = await fetch(`${apiBaseUrl(args)}/api/project`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Cannot verify active project: HTTP ${response.status}`);
    const project = await response.json() as { active?: { root?: string } };
    if (project.active?.root && resolve(project.active.root) !== resolve(process.cwd())) {
      throw new Error(`Dashboard is on ${project.active.root}; cannot switch it from this repository.`);
    }
    return cmdApi([`/api/projects/${encodeURIComponent(id)}/active`, "--method", "PATCH", "--json", ...argv.slice(2)]);
  }
  if (argv[0] === "clean") return cmdProjectClean(argv.slice(1));
  throw new Error("Usage: ok project list | use <id> | clean [--dry-run|--apply] [--all]");
}

/**
 * Clean up stale or inactive registry entries.
 * --dry-run (default): show what would be removed without persisting.
 * --apply: actually remove entries.
 * --all: also remove non-active entries (not just stale ones).
 */
export async function cmdProjectClean(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const dryRun = args.flags["dry-run"] !== true && args.flags["apply"] !== true;
  const apply = args.flags["apply"] === true;
  const all = args.flags["all"] === true;
  
  if (dryRun) {
    // Dry run: manually categorize and report
    const projects = listProjects();
    const reg = loadRegistry();
    const activeEntry = projects.find(p => p.active);
    const activeRoot = activeEntry ? canonicalRoot(activeEntry.root) : null;
    
    const stale: typeof reg.projects = [];
    const nonActive: typeof reg.projects = [];
    const valid: typeof reg.projects = [];
    
    for (const entry of reg.projects) {
      const root = canonicalRoot(entry.root);
      const exists = existsSync(root);
      const isActive = entry.active || root === activeRoot;
      
      if (!exists) {
        stale.push(entry);
      } else if (all && !isActive) {
        nonActive.push(entry);
      } else {
        valid.push(entry);
      }
    }
    
    const toRemove = [...stale, ...nonActive];
    
    console.log(`\nRegistry cleanup report:`);
    console.log(`  Total entries: ${reg.projects.length}`);
    console.log(`  Stale (path missing): ${stale.length}`);
    if (all) {
      console.log(`  Non-active (--all): ${nonActive.length}`);
    }
    console.log(`  Would remove: ${toRemove.length}`);
    console.log(`  Would keep: ${valid.length}`);
    
    if (toRemove.length === 0) {
      console.log(`\nNo entries to remove.\n`);
      return;
    }
    
    console.log(`\nDry run — no changes made. Pass --apply to remove entries.\n`);
    for (const entry of toRemove) {
      const status = stale.includes(entry) ? "(stale)" : "(non-active)";
      console.log(`  - ${entry.name} (${entry.root}) ${status}`);
    }
    console.log("");
    return;
  }
  
  // Apply the cleanup using the built-in function
  const result = cleanupRegistry({
    pruneMissing: true,
    pruneInactive: all,
    verbose: false,
    persist: apply,
  });
  
  console.log(`\nRegistry cleanup report:`);
  console.log(`  Total entries: ${result.before.length}`);
  console.log(`  Removed: ${result.removed}`);
  if (all) {
    console.log(`  Pruned (stale + inactive): ${result.pruned}`);
  } else {
    console.log(`  Pruned (stale only): ${result.pruned}`);
  }
  console.log(`  After: ${result.after.length}\n`);
}
