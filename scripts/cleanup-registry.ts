#!/usr/bin/env node
// Run with: node --experimental-strip-types scripts/cleanup-registry.ts [--prune-missing] [--yes]
import { cleanupRegistry, registryPath } from "../kanban/projects.ts";

const args = process.argv.slice(2);
const pruneMissing = args.includes("--prune-missing");
const yes = args.includes("--yes");

console.error(`Registry path: ${registryPath()}`);

const result = cleanupRegistry({ pruneMissing, verbose: true });

console.log(`Registry: ${result.before.length} → ${result.after.length} entries`);
console.log(`  Deduped: ${result.deduped}`);
console.log(`  Pruned:  ${result.pruned} (root no longer exists)`);

if (result.before.length === result.after.length && result.pruned === 0) {
  console.log("Nothing to clean.");
}

if (!yes) {
  console.log("\nPass --yes to actually write the cleaned registry.");
  process.exit(0);
}

// Persist the cleaned registry
cleanupRegistry({ pruneMissing, persist: true });
console.log("\nRegistry cleaned and persisted.");
