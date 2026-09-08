// ok/commands/board.ts — `ok board list|show|add|move|delete|comment`.

import { resolve } from "node:path";
import { parseArgs } from "./serve.ts";
import { apiBaseUrl, cmdApi } from "./api.ts";

export async function cmdBoard(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const args = parseArgs(["board", ...rest]);
  const [id, ...words] = args.positionals;
  const transport: string[] = ["--json"];
  for (const key of ["host", "port"]) if (args.flags[key] !== undefined) transport.push(`--${key}`, String(args.flags[key]));
  let path = "/api/board";
  let method = "GET";
  let data: Record<string, unknown> | undefined;
  if (sub === "show" && id) path = `/api/tasks/${encodeURIComponent(id)}`;
  else if (sub === "add" && id) {
    if (args.flags.column && !["backlog", "todo", "doing", "review", "done"].includes(String(args.flags.column))) throw new Error("column must be backlog|todo|doing|review|done");
    path = "/api/tasks"; method = "POST";
    data = { title: [id, ...words].join(" "), column: String(args.flags.column || "todo") };
    if (typeof args.flags.description === "string") data.description = args.flags.description;
  } else if (sub === "move" && id && words.length === 1) {
    if (!["backlog", "todo", "doing", "review", "done"].includes(words[0])) throw new Error("column must be backlog|todo|doing|review|done");
    path = `/api/tasks/${encodeURIComponent(id)}`; method = "PATCH"; data = { column: words[0] };
  } else if (sub === "delete" && id) {
    path = `/api/tasks/${encodeURIComponent(id)}`; method = "DELETE";
  } else if (sub === "comment" && id && words.length) {
    path = `/api/tasks/${encodeURIComponent(id)}/comments`; method = "POST";
    data = { text: words.join(" "), blockId: "progress", line: 1, author: String(args.flags.author || "agent:openkan") };
  } else if (sub !== "list") {
    throw new Error("Usage: ok board list | show <id> | add <title> [--column todo] | move <id> <column> | delete <id> | comment <id> <text> [--author agent:NAME]");
  }
  // The dashboard can select another repository; never silently write to it.
  const response = await fetch(`${apiBaseUrl(args)}/api/project`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Cannot verify active project: HTTP ${response.status}`);
  const project = await response.json() as { active?: { root?: string } };
  if (project.active?.root && resolve(project.active.root) !== resolve(process.cwd())) {
    throw new Error(`Dashboard is on ${project.active.root}; select this repository with ok project use <id> before using board commands`);
  }
  await cmdApi([path, "--method", method, ...transport, ...(data ? ["--data", JSON.stringify(data)] : [])]);
}
