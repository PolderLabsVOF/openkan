// ok/commands/reset.ts — `ok reset [--hard]`.

import { join } from "node:path";
import type { BoardContext } from "../../kanban/board.ts";
import { parseArgs } from "./serve.ts";
import { cmdStop } from "./serve.ts";
import { removeDir } from "../../kanban/io.ts";

export async function cmdReset(ctx: BoardContext, argv: string[]): Promise<void> {
  // parseArgs treats argv[0] as the command name, so prefix before parsing
  // or our flags end up stored as `cmd` instead of `flags`.
  const args = parseArgs(["reset", ...argv]);
  const hard = args.flags["hard"] === true || args.flags["hard"] === "true";
  const yes = args.flags["yes"] === true || args.flags["yes"] === "true";
  // In a non-interactive shell (CI, piped input), the stdin "data" listener
  // never resolves — Node exits with the Promise pending and the user gets
  // no feedback. Require an explicit flag in non-TTY mode.
  if (!process.stdin.isTTY && !hard && !yes) {
    console.error("ok reset: non-interactive shell requires --yes (or --hard). Refusing to prompt.");
    process.exit(1);
  }
  if (process.stdin.isTTY && !hard && !yes) {
    process.stderr.write("Type 'yes' to confirm: ");
    const answer = await new Promise<string>((resolve) => {
      process.stdin.once("data", (d) => resolve(d.toString().trim()));
    });
    if (answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }
  // Stop if running
  try { await cmdStop(ctx); } catch { /* ignore */ }
  const dir = join(ctx.directory, ".ok");
  if (hard) {
    // Wipe tasks and sessions subdirs
    const tasksDir = join(dir, "tasks");
    const sessionsDir = join(dir, "sessions");
    removeDir(tasksDir);
    removeDir(sessionsDir);
  }
  removeDir(dir);
  console.log("Reset complete.");
}
