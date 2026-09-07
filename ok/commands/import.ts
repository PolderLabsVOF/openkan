// ok/commands/import.ts — `ok import [--path DIR] [--include PATTERN] [--exclude PATTERN]`.

import type { BoardContext } from "../../kanban/board.ts";
import { getBoard } from "../../kanban/board.ts";
import { runImport } from "../../kanban/import.ts";
import { parseArgs } from "./serve.ts";

export async function cmdImport(ctx: BoardContext, argv: string[]): Promise<void> {
  // parseArgs treats argv[0] as the command name, so prefix before parsing
  // or our flags end up stored as `cmd` instead of `flags`.
  const args = parseArgs(["import", ...argv]);
  const pathFlag = args.flags["path"] as string | undefined;
  const includeFlag = args.flags["include"] as string | undefined;
  const excludeFlag = args.flags["exclude"] as string | undefined;

  // Surface typos in flag names — npm/wget behaviour. The import surface is
  // small and stable: only --path, --include, --exclude.
  const KNOWN_IMPORT_FLAGS = new Set(["path", "include", "exclude"]);
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_IMPORT_FLAGS.has(flag)) {
      console.warn(`ok import: warning: unknown flag --${flag} (known: ${[...KNOWN_IMPORT_FLAGS].map((f) => `--${f}`).join(", ")})`);
    }
  }

  // ctx.directory must be set
  if (!ctx.directory) {
    console.error("ok import: no project directory set — run 'ok start' first or set --path");
    process.exit(1);
  }

  const targetDir = pathFlag ?? ctx.directory;
  const importCtx = { ...ctx, directory: targetDir };

  const include = includeFlag ? includeFlag.split(",").map((s) => s.trim()) : undefined;
  const exclude = excludeFlag ? excludeFlag.split(",").map((s) => s.trim()) : undefined;

  const result = await runImport(importCtx, { include, exclude });

  if (result.imported.length === 0) {
    console.log("No unchecked checkboxes found.");
    return;
  }

  console.log(`imported ${result.imported.length} tasks`);
  const board = await getBoard();
  for (const id of result.imported) {
    const task = board.tasks.find((t) => t.id === id);
    if (task && task.source) {
      console.log(`  created ${id} at ${task.source.path}:${task.source.line}`);
    } else {
      console.log(`  created ${id}`);
    }
  }
}
