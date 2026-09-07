#!/usr/bin/env node
// scripts/typecheck.ts — project-wide typecheck driver.
//
// Replaces the `*.ts` glob expression in the original `npm run typecheck`
// script. POSIX shells expand globs; PowerShell on Windows runners does
// not, so `tsc bin/*.ts kanban/*.ts ok/*.ts ok/commands/*.ts` fails on
// Windows with `TS6053: File 'bin/*.ts' not found.` (the literal string
// is treated as one filename). Walking the filesystem with node keeps
// the script shell-agnostic.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const groups = ["bin", "kanban", "ok", "ok/commands"];

const files: string[] = [];
for (const group of groups) {
  collect(join(here, group), group, files);
}

if (files.length === 0) {
  console.error(`typecheck: no input files found under ${groups.join(", ")}`);
  process.exit(2);
}

const tsc = join(here, "node_modules", "typescript", "bin", "tsc");
const args = [
  tsc,
  "--noEmit",
  "--allowImportingTsExtensions",
  "--allowJs",
  "--checkJs",
  "--skipLibCheck",
  "--target", "ES2022",
  "--module", "ESNext",
  "--moduleResolution", "Bundler",
  ...files,
];

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);

function collect(rootAbs: string, rootRel: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(rootAbs);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(rootAbs, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collect(abs, `${rootRel}/${entry}`, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(`${rootRel}/${entry}`.replace(/\\/g, "/"));
    }
  }
}
