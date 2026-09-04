#!/usr/bin/env node
// bin/ok-install.ts — install the ok-planning skill at user level.
//
// Copies `.claude/skills/ok-planning/` to `~/.claude/skills/ok-planning/`
// so the skill follows the operator across projects. Idempotent.
//
// Flags:
//   --force      overwrite an existing install
//   --dry-run    print actions without writing
//   --target <p> override the install target (default ~/.claude/skills/ok-planning)

import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const skillSrc = join(repoRoot, ".claude", "skills", "ok-planning");

if (!existsSync(skillSrc)) {
  process.stderr.write(`source skill not found at ${skillSrc}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let force = false;
let dryRun = false;
let target: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const tok = argv[i];
  if (tok === "--force") force = true;
  else if (tok === "--dry-run") dryRun = true;
  else if (tok === "--target") target = argv[++i];
}

const installRoot = target ?? join(homedir(), ".claude", "skills", "ok-planning");

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

if (existsSync(installRoot)) {
  if (!force) {
    process.stderr.write(`${installRoot} already exists. Use --force to overwrite.\n`);
    process.exit(1);
  }
  if (dryRun) {
    log(`would remove ${installRoot}`);
  } else {
    rmSync(installRoot, { recursive: true, force: true });
    log(`removed ${installRoot}`);
  }
}

if (dryRun) {
  log(`would copy ${skillSrc} -> ${installRoot}`);
  process.exit(0);
}

mkdirSync(dirname(installRoot), { recursive: true });
cpSync(skillSrc, installRoot, { recursive: true });
log(`installed ok-planning skill to ${installRoot}`);
