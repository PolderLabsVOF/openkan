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

function help(): void {
  process.stdout.write(`ok — self-contained planning workspace under .ok/

Usage:
  ok init                           Create .ok/ in cwd (idempotent).
  ok task <subcommand> [args]        Manage tasks.
  ok plan <subcommand> [args]        Manage plans.
  ok prd  <subcommand> [args]        Manage long-horizon PRDs.
  ok index                           Rebuild .ok/index.json from filesystem.
  ok doctor                          Validate every JSON against its schema.
  ok migrate-from-openkan [root]     One-shot import of legacy .ok/ workspace.
  ok help                            Show this message.

Task subcommands:
  ok task add <title>               [--owner X] [--priority p0|p1|p2|p3] [--plan pln-…] [--prd prd-…]
                                    [--scope a,b] [--deps t1,t2] [--description …] [--acceptance a,b]
  ok task list                      [--status pending|in_progress|review|done|cancelled]
                                    [--owner X] [--plan pln-…] [--prd prd-…] [--json]
  ok task show <id>                 [--json]
  ok task update <id>               [--status …] [--owner …] [--priority …] [--evidence …] [--acceptance a,b] [--description …]
  ok task claim <id> --owner X      [--lease-ms N] (default 1h)
  ok task heartbeat <id> --owner X  [--lease-ms N]
  ok task complete <id> --owner X --evidence "<commit/file/url>"
  ok task cancel <id> --owner X --reason "<text>"
  ok task release <id> --owner X    Drop a lock without changing status.

Plan subcommands:
  ok plan add <title>               [--summary …] [--prd prd-…] [--phase …] [--tasks t1,t2,…] [--acceptance a,b]
  ok plan list                      [--status draft|active|blocked|complete|abandoned] [--prd prd-…] [--json]
  ok plan show <id>                 [--json]
  ok plan update <id>               [--status …] [--phase …] [--tasks t1,t2,…] [--append-task t1]

PRD subcommands:
  ok prd add <title>                [--vision …] [--goals g1|g2|g3] [--non-goals n1,n2]
                                    [--milestones m1,m2] [--metrics 'name|target|current']
                                    [--owners o1,o2] [--review-cadence weekly]
  ok prd list                       [--status draft|active|shipped|abandoned] [--json]
  ok prd show <id>                  [--json]
  ok prd update <id>                [--status …] [--goal g1 --goal-status met] [--milestone m1 --milestone-status hit]
                                    [--append-plan pln-…] [--review-cadence …] [--next-review ISO]

Examples:
  ok init
  ok task add "Wire openkan ts typecheck" --owner karen --priority p1
  ok task claim tsk-AbCdEfGh --owner karen
  ok task complete tsk-AbCdEfGh --owner karen --evidence "abc1234 commit, see bin/ok.ts"
  ok prd add "Planning workspace v1" --vision "Self-contained .ok/ tree for any agent" --goals "ship schema|ship CLI|ship skill"
  ok plan add "M1: schemas + storage" --prd prd-AbCdEfGh --tasks tsk-AbCdEfGh,tsk-IjKlMnOp
  ok index
  ok doctor
`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
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
