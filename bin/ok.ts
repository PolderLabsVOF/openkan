#!/usr/bin/env node
// bin/ok.ts — entry point for the `ok` CLI.
//
// Dispatches to ok/commands/*.ts for each subcommand. Keep the wiring flat
// — one branch per subcommand, no plugin discovery. New subcommands land in
// ok/commands and add a branch here.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BoardContext } from "../kanban/board.ts";
import { initBoard } from "../kanban/board.ts";
import { runTask } from "../ok/commands/task.ts";
import { runPlan } from "../ok/commands/plan.ts";
import { runPrd } from "../ok/commands/prd.ts";
import { runIndex, runDoctor } from "../ok/commands/index.ts";
import { cmdInit } from "../ok/commands/init.ts";
import { cmdMigrateFromOpenkan } from "../ok/migrate.ts";
import { runGoal } from "../ok/commands/goal.ts";
import { runProgress } from "../ok/commands/progress.ts";
import { cmdBoardInit } from "../ok/commands/board-init.ts";
import {
  cmdStart,
  cmdServe,
  cmdStop,
  cmdStatus,
  cmdOpen,
  printHelp,
  printInstalledVersion,
  parseArgs,
} from "../ok/commands/serve.ts";
import { cmdConfig } from "../ok/commands/config.ts";
import { cmdLogs } from "../ok/commands/logs.ts";
import { cmdApi } from "../ok/commands/api.ts";
import { cmdAgent } from "../ok/commands/agent.ts";
import { cmdReset } from "../ok/commands/reset.ts";
import { cmdUpdate } from "../ok/commands/update.ts";
import { cmdSkill } from "../ok/commands/skill.ts";
import { cmdBoard } from "../ok/commands/board.ts";
import { cmdProject } from "../ok/commands/project.ts";
import { cmdImport } from "../ok/commands/import.ts";
import { cmdOnboard } from "../ok/commands/onboard.ts";
import { cmdMcp } from "../ok/commands/mcp.ts";

// Commands that live entirely in ok/commands/index.ts (planning). When the
// caller passes `ok <name>`, we forward the rest of argv straight to that
// module. Bare / help invocations print the per-command help line so we
// don't drop the user into a generic "Usage: …" error.
const PLANNING_COMMANDS = new Set([
  "task", "plan", "prd", "goal", "progress", "doctor", "index",
]);

function help(): void {
  // Multi-line help: enumerate every ok subcommand. The catalogue tables are
  // factored into ok/commands/serve.ts so adding a new subcommand only
  // requires updating one place.
  printHelp();
}

async function buildCtx(): Promise<BoardContext> {
  // Resolve the nearest .ok/ workspace so commands that need the board
  // (import, reset, start, serve, etc.) operate on the right root even when
  // the user invokes ok from a subdirectory. Bare `ok update` and
  // `ok skill install` skip this because they must not chdir into a
  // workspace or initialise the board.
  let directory = process.cwd();
  while (!existsSync(join(directory, ".ok")) && dirname(directory) !== directory) {
    directory = dirname(directory);
  }
  if (existsSync(join(directory, ".ok"))) {
    try { process.chdir(directory); } catch { /* best effort */ }
  }
  return {
    directory: process.cwd(),
    client: null as any,
    log: async (lvl, msg) => { console.log(`[${lvl}] ${msg}`); },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Bare `ok` (no subcommand) is the friendly entry point: start the server
  // and ask how to run it. Strip the explicit-help branch first so
  // `ok --help` still prints usage.
  if (argv.length === 0) argv = ["serve"];

  if (argv[0] === "-h" || argv[0] === "--help") {
    printHelp(argv[1]);
    return 0;
  }

  // `ok help` — same as `ok --help`. Mirrors the openkan CLI convention.
  if (argv[0] === "help") {
    printHelp(argv[1]);
    return 0;
  }

  // `ok -v` / `ok --version` — print the installed package's name and
  // version from its own package.json so the user always sees the truth,
  // even when the shim is rebuilt separately from the TS source.
  if (argv[0] === "-v" || argv[0] === "--version") {
    printInstalledVersion();
    return 0;
  }

  const { cmd, positionals, flags } = parseArgs(argv);

  // `ok update` runs npm itself; it must NOT chdir into the nearest
  // .ok/ workspace, must NOT initialise the board, and must NOT need a
  // running server.
  if (cmd === "update") {
    await cmdUpdate(positionals, flags);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }

  // Resolve nested invocations without creating a second workspace.
  // `ok task claim` from a subdirectory should walk up to find the parent's
  // .ok/ rather than auto-initialising a fresh one in the leaf. The legacy
  // openkan.ts did the same walk before dispatching planning commands, so
  // planners behave identically from a subdirectory. `ok init` is excluded
  // because the user invokes it to *create* a workspace; `ok config` is
  // excluded because it manages workspace-local config but does not need
  // to be in a workspace.
  if (cmd !== "init" && cmd !== "config") {
    let directory = process.cwd();
    while (!existsSync(join(directory, ".ok")) && dirname(directory) !== directory) {
      directory = dirname(directory);
    }
    if (existsSync(join(directory, ".ok"))) {
      try { process.chdir(directory); } catch { /* best effort */ }
    }
  }

  // Planning commands (task, plan, prd, goal, progress, doctor, index)
  // delegate to the existing ok/commands modules. `--help` / `-h` always
  // prints the help line. Bare invocations of the multi-subcommand planners
  // (task/plan/prd/goal) also print help; the no-arg planners (index/doctor/
  // progress) just run.
  if (PLANNING_COMMANDS.has(cmd)) {
    const NEEDS_SUBCOMMAND = new Set(["task", "plan", "prd", "goal"]);
    if (argv[1] === "-h" || argv[1] === "--help"
        || (NEEDS_SUBCOMMAND.has(cmd) && argv.length === 1)) {
      printHelp(cmd);
      return 0;
    }
    if (cmd === "index") return runIndex();
    if (cmd === "doctor") return runDoctor();
    if (cmd === "task") return runTask(argv.slice(1));
    if (cmd === "plan") return runPlan(argv.slice(1));
    if (cmd === "prd") return runPrd(argv.slice(1));
    if (cmd === "goal") return runGoal(argv.slice(1));
    if (cmd === "progress") return runProgress(argv.slice(1));
    return 1;
  }

  // Special-case the planning workspace migration: it operates on a
  // machine-readable layout the legacy .openkan/ tree, so it must NOT
  // chdir into a nearby .ok/ or initialise the board.
  if (cmd === "migrate-from-openkan") return cmdMigrateFromOpenkan(argv.slice(1));

  // `ok skill install` — install command-first agent guidance into the
  // user's agent directory. Must not rewrite board state.
  if (cmd === "skill") {
    if (positionals[0] !== "install") throw new Error("Usage: ok skill install [--agent codex|claude|all] [--target DIR] [--force]");
    await cmdSkill(positionals, flags);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }

  // Commands/API helpers must not rewrite board state just to read it.
  if (cmd === "api") {
    await cmdApi(argv.slice(1));
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  if (cmd === "agent") {
    await cmdAgent(argv.slice(1));
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  if (cmd === "board") {
    await cmdBoard(argv.slice(1));
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  if (cmd === "project") {
    await cmdProject(argv.slice(1));
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }

  // The remaining commands need a BoardContext. Resolve the nearest .ok/
  // workspace, init the board (auto-init if missing), and dispatch.
  const ctx = await buildCtx();

  if (cmd !== "init" && cmd !== "config") {
    try {
      await initBoard(ctx);
    } catch (e: any) {
      if (e?.message?.includes("not initialised") || e?.message?.includes("Board not initialised")) {
        // Board not yet initialized — init first
        await cmdBoardInit();
        await initBoard(ctx);
      }
    }
  }

  switch (cmd) {
    case "init": {
      await cmdBoardInit();
      const code = await cmdInit();
      return code;
    }
    case "start":   await cmdStart(ctx, argv.slice(1)); break;
    case "serve":   await cmdServe(ctx, argv.slice(1)); break;
    case "stop":    await cmdStop(ctx); break;
    case "status":  await cmdStatus(ctx); break;
    case "open":    await cmdOpen(ctx); break;
    case "config":  await cmdConfig(argv.slice(1)); break;
    case "logs":    await cmdLogs(argv.slice(1)); break;
    case "reset":   await cmdReset(ctx, argv.slice(1)); break;
    case "import":  await cmdImport(ctx, argv.slice(1)); break;
    case "onboard": cmdOnboard(); break;
    case "mcp":     cmdMcp(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      return 1;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((e: any) => {
      console.error(`ok: ${e?.message ?? e}`);
      process.exit(1);
    });
}
