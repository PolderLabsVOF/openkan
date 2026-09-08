// scripts/cleanup-v1-backups.ts — Remove v1 backup files after confirmed migration.
//
// This script removes legacy v1 flat-file backups from the .ok/ directory.
// Run this after confirming all tasks have been migrated to v2 directory form.
//
// Usage:
//   npx tsx scripts/cleanup-v1-backups.ts [--dry-run] [--root <path>]
//
// Options:
//   --dry-run  Print files that would be deleted without actually deleting
//   --root     Path to the project root (default: cwd)

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

const V1_PATTERNS = [
  /\.v1\.json$/,           // e.g., task.v1.json
  /\.v1\.board\.json$/,    // e.g., tasks.v1.board.json
  /\.v1\.json$/,           // e.g., tasks.v1.json
  /^tasks\.v1\.json$/,     // Top-level tasks.v1.json
  /^tasks\.v1\.board\.json$/, // Top-level tasks.v1.board.json
];

interface Args {
  dryRun: boolean;
  root: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  return {
    dryRun: args.includes("--dry-run"),
    root: rootIndex >= 0 ? args[rootIndex + 1] : process.cwd(),
  };
}

async function findV1Files(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);

      // Check if this is a v1 file we should remove
      const relativePath = relative(dir, fullPath);
      const shouldRemove =
        /\.v1\.json$/.test(entry) ||
        entry === "tasks.v1.json" ||
        entry === "tasks.v1.board.json";

      if (shouldRemove) {
        results.push(fullPath);
        continue;
      }

      // Recurse into directories (but skip task directories)
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory() && !entry.startsWith("tsk-")) {
          await walk(fullPath);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  await walk(dir);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const okDir = join(args.root, ".ok");

  console.log(`Scanning ${okDir} for v1 backup files...`);
  console.log(`Mode: ${args.dryRun ? "DRY RUN (no files will be deleted)" : "LIVE"}`);
  console.log("");

  const v1Files = await findV1Files(okDir);

  if (v1Files.length === 0) {
    console.log("No v1 backup files found.");
    return;
  }

  console.log(`Found ${v1Files.length} v1 file(s):\n`);
  for (const file of v1Files) {
    console.log(`  ${file}`);
  }
  console.log("");

  if (args.dryRun) {
    console.log("Dry run complete. No files were deleted.");
    return;
  }

  // Delete the files
  console.log(`Deleting ${v1Files.length} file(s)...`);
  let deleted = 0;
  for (const file of v1Files) {
    try {
      await fs.unlink(file);
      deleted++;
    } catch (e) {
      console.error(`  Failed to delete ${file}: ${e}`);
    }
  }
  console.log(`\nDeleted ${deleted} file(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
