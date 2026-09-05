#!/usr/bin/env node
// bin/ok.ts — entry point for the `ok` CLI.
//
// Mirrors bin/openkan.ts shape: dispatches to ok/commands/*.ts for each
// subcommand. Keep the wiring flat — one branch per subcommand, no
// plugin discovery. New subcommands land in ok/commands and add a branch
// here.

import { runTask } from "../ok/commands/task.ts";
import { runPlan } from "../ok/commands/plan.ts";
import { runPrd } from "../ok/commands/prd.ts";
import { runIndex, runDoctor } from "../ok/commands/index.ts";
import { cmdInit } from "../ok/commands/init.ts";
import { cmdMigrateFromOpenkan } from "../ok/migrate.ts";
import { runGoal } from "../ok/commands/goal.ts";
import { runProgress } from "../ok/commands/progress.ts";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

function help(): void {
  // Multi-line help: enumerate every ok subcommand. Mirrors the compact
  // `cmd  description` layout that `openkan --help` produces (Usage header,
  // aligned rows, Flags note, Examples block). The catalogue tables are
  // factored out so adding a new subcommand only requires updating one place.
  const TOP: Array<[string, string]> = [
    ["init", "Create .ok/ in cwd (idempotent)."],
    ["task add|list|show|update|claim|heartbeat|complete|cancel|release", "Durable offline tasks."],
    ["plan add|list|show|update", "Plans and phases."],
    ["prd add|list|show|update", "Long-horizon scope (PRDs)."],
    ["goal list|add|show|update", "Goals within a PRD."],
    ["progress [--prd ID] [--json]", "Tasks / plans / PRD / goal rollups without a server."],
    ["index", "Rebuild .ok/index.json from filesystem."],
    ["doctor", "Validate every JSON against its schema."],
    ["migrate-from-openkan [--path DIR] [root] [--list]", "One-shot import of legacy .openkan/ workspace."],
    ["help", "Show this message."],
  ];
  const TASK: string[] = [
    "ok task add <title> [--status pending|in_progress|review|done|cancelled] [--owner X] [--priority p0|p1|p2|p3] [--plan pln-...] [--prd prd-...] [--scope a,b] [--deps t1,t2] [--description ...] [--acceptance a,b]",
    "ok task list [--status ...] [--owner X] [--plan pln-...] [--prd prd-...] [--json]",
    "ok task show <id> [--json]",
    "ok task update <id> [--status ...] [--owner ...] [--priority ...] [--evidence ...] [--acceptance a,b] [--description ...]",
    "ok task claim <id> --owner X [--lease-ms N]",
    "ok task heartbeat <id> --owner X [--lease-ms N]",
    "ok task complete <id> --owner X --evidence \"<commit/file/url>\"",
    "ok task cancel <id> --owner X --reason \"<text>\"",
    "ok task release <id> --owner X",
  ];
  const PLAN: string[] = [
    "ok plan add <title> [--summary ...] [--prd prd-...] [--phase ...] [--tasks t1,t2,...] [--acceptance a,b]",
    "ok plan list [--status draft|active|blocked|complete|abandoned] [--prd prd-...] [--json]",
    "ok plan show <id> [--json]",
    "ok plan update <id> [--status ...] [--phase ...] [--tasks t1,t2,...] [--append-task t1]",
  ];
  const PRD: string[] = [
    "ok prd add <title> [--vision ...] [--goals g1|g2|g3] [--non-goals n1,n2] [--milestones m1,m2] [--metrics 'name|target|current'] [--owners o1,o2] [--review-cadence weekly]",
    "ok prd list [--status draft|active|shipped|abandoned] [--json]",
    "ok prd show <id> [--json]",
    "ok prd update <id> [--status ...] [--goal g1 --goal-status met] [--milestone m1 --milestone-status hit] [--append-plan pln-...] [--review-cadence ...] [--next-review ISO]",
  ];
  const w = Math.max(...TOP.map(([cmd]) => cmd.length));
  const lines: string[] = [];
  lines.push("Usage: ok <command> [args...]");
  lines.push("");
  for (const [cmd, desc] of TOP) {
    lines.push(`  ${cmd.padEnd(w)}  ${desc}`);
  }
  lines.push("");
  lines.push("Flags: --flag=value or --flag value, can appear before or after positionals.");
  lines.push("");
  lines.push("Task subcommands:");
  for (const cmd of TASK) lines.push(`  ${cmd}`);
  lines.push("");
  lines.push("Plan subcommands:");
  for (const cmd of PLAN) lines.push(`  ${cmd}`);
  lines.push("");
  lines.push("PRD subcommands:");
  for (const cmd of PRD) lines.push(`  ${cmd}`);
  lines.push("");
  lines.push("Examples:");
  lines.push("  ok init");
  lines.push('  ok task add "Wire openkan ts typecheck" --owner karen --priority p1');
  lines.push("  ok task claim tsk-AbCdEfGh --owner karen");
  lines.push('  ok task complete tsk-AbCdEfGh --owner karen --evidence "abc1234 commit, see bin/ok.ts"');
  lines.push('  ok prd add "Planning workspace v1" --vision "Self-contained .ok/ tree for any agent" --goals "ship schema|ship CLI|ship skill"');
  lines.push("  ok plan add \"M1: schemas + storage\" --prd prd-AbCdEfGh --tasks tsk-AbCdEfGh,tsk-IjKlMnOp");
  lines.push("  ok migrate-from-openkan --path /legacy/workspace --list");
  lines.push("  ok index");
  lines.push("  ok doctor");
  process.stdout.write(lines.join("\n") + "\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let root = resolve(process.cwd());
  while (!existsSync(`${root}/.ok`) && dirname(root) !== root) root = dirname(root);
  if (existsSync(`${root}/.ok`)) process.chdir(root);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      return 0;
    case "init":
      return cmdInit();
    case "task":
      return runTask(rest);
    case "plan":
      return runPlan(rest);
    case "prd":
      return runPrd(rest);
    case "goal":
      return runGoal(rest);
    case "progress":
      return runProgress(rest);
    case "index":
      return runIndex();
    case "doctor":
      return runDoctor();
    case "migrate-from-openkan":
      return cmdMigrateFromOpenkan(rest);
    default:
      process.stderr.write(`ok: unknown command "${cmd ?? ""}"\n`);
      help();
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((e: any) => {
      process.stderr.write(`ok: ${e?.message ?? e}\n`);
      process.exit(1);
    });
}
