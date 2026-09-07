// ok/commands/skill.ts — `ok skill install [--agent codex|claude|all]`.

import { cpSync, existsSync, writeFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OPENKAN_ROOT } from "./serve.ts";

export async function cmdSkill(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (positionals[0] !== "install") throw new Error("Usage: ok skill install [--agent codex|claude|all] [--target DIR] [--force]");
  const agent = String(flags.agent || "all");
  if (!["all", "claude", "codex"].includes(agent)) throw new Error("--agent must be codex, claude, or all");
  const targets = typeof flags.target === "string"
    ? [resolve(flags.target)]
    : (agent === "all" ? ["claude", "codex"] : [agent]).map((name) => join(homedir(), `.${name}`, "skills", "openkan"));
  for (const target of targets) {
    if (!existsSync(target)) {
      // cpSync would create parents and silently succeed; reject early so
      // the user does not end up with a target at a typo'd path.
      throw new Error(`--target ${target} does not exist`);
    }
    const st = statSync(target);
    if (!st.isDirectory()) throw new Error(`--target ${target} is not a directory`);
    // Probe writability with a temp file rather than access() — file-mode
    // checks are unreliable on WSL/macOS sandbox paths.
    const probe = join(target, `.openkan-write-probe-${process.pid}`);
    try { writeFileSync(probe, ""); } catch { throw new Error(`--target ${target} is not writable`); }
    try { rmSync(probe, { force: true }); } catch { /* best effort */ }
    if (existsSync(target) && !flags.force) throw new Error(`${target} already exists; use --force to update`);
  }
  for (const target of targets) {
    cpSync(join(OPENKAN_ROOT, "skills", "openkan"), target, { recursive: true });
    console.log(`Installed openkan skill: ${target}`);
  }
}
