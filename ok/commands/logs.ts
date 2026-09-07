// ok/commands/logs.ts — `ok logs [--tail N] [--follow]`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./serve.ts";

export async function cmdLogs(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const tail = parseInt((args.flags["tail"] as string) ?? "50", 10);
  const follow = args.flags["follow"] === true || args.flags["follow"] === "true";
  const logFile = join(process.cwd(), ".ok", "server.log");
  if (!existsSync(logFile)) {
    console.error("No server.log found.");
    process.exit(1);
  }
  const lines = readFileSync(logFile, "utf-8").split("\n");
  const lastLines = lines.slice(-tail);
  console.log(lastLines.join("\n"));
  if (follow) {
    // Simple tail -f using fs watch
    const { watch } = await import("node:fs");
    let lastSize = readFileSync(logFile, "utf-8").length;
    watch(logFile, async () => {
      const content = readFileSync(logFile, "utf-8");
      if (content.length > lastSize) {
        process.stdout.write(content.slice(lastSize));
        lastSize = content.length;
      }
    });
    // Keep process alive
    await new Promise(() => {});
  }
}
