#!/usr/bin/env node
// .claude/hooks/ok-init.mjs — Claude Code SessionStart hook.
//
// On every session start, ensure the project's `.ok/` planning workspace
// exists. Runs `ok init` (idempotent) when `.ok/config.json` is missing.
// Always exits 0: hooks must never block Claude.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (!projectDir) {
  // No project root (e.g. running outside Claude Code) — nothing to do.
  process.exit(0);
}

const okConfig = join(projectDir, ".ok", "config.json");
if (existsSync(okConfig)) {
  // Already initialised — fast path.
  process.exit(0);
}

// Resolve the bin/ok.ts path: this hook lives at <repo>/.claude/hooks/, so
// <repo>/bin/ok.ts is two parents up. When the skill is installed at user
// level, fall back to a global PATH lookup so the operator does not have
// to keep the hook in lockstep with the bin script.
const here = fileURLToPath(import.meta.url);
const projectBinOk = join(here, "..", "..", "bin", "ok.ts");

let cmd;
let args;
if (existsSync(projectBinOk)) {
  cmd = process.execPath;
  args = ["--experimental-strip-types", projectBinOk, "init"];
} else {
  // Try the global launcher (`ok` on PATH).
  cmd = "ok";
  args = ["init"];
}

const res = spawnSync(cmd, args, {
  cwd: projectDir,
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (res.status !== 0) {
  process.stderr.write(`ok-init hook: ok init exited ${res.status}: ${res.stderr ?? ""}\n`);
}

process.exit(0);
