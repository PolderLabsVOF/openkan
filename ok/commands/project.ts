// ok/commands/project.ts — `ok project list|use <id>`.

import { resolve } from "node:path";
import { parseArgs } from "./serve.ts";
import { apiBaseUrl, cmdApi } from "./api.ts";

export async function cmdProject(argv: string[]): Promise<void> {
  if (argv[0] === "list") return cmdApi(["/api/projects", "--json", ...argv.slice(1)]);
  if (argv[0] === "use" && argv[1]) {
    const args = parseArgs(["use", ...argv.slice(1)]);
    const id = args.positionals[0];
    if (!id) throw new Error("Usage: ok project use <id>");
    // Verify the active project matches cwd before mutating dashboard state.
    const response = await fetch(`${apiBaseUrl(args)}/api/project`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Cannot verify active project: HTTP ${response.status}`);
    const project = await response.json() as { active?: { root?: string } };
    if (project.active?.root && resolve(project.active.root) !== resolve(process.cwd())) {
      throw new Error(`Dashboard is on ${project.active.root}; cannot switch it from this repository.`);
    }
    return cmdApi([`/api/projects/${encodeURIComponent(id)}/active`, "--method", "PATCH", "--json", ...argv.slice(2)]);
  }
  throw new Error("Usage: ok project list | use <id>");
}
