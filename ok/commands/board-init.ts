// ok/commands/board-init.ts — board-side init (preserved from bin/openkan.ts).
//
// Creates the legacy board.json / tasks.json / openkan.json trio that the
// dashboard reads on first run. `ok init` runs this BEFORE the planning
// init so the server and the planner share `.ok/`.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, configPath, saveConfig } from "./serve.ts";

export async function cmdBoardInit(): Promise<void> {
  const dir = join(process.cwd(), ".ok");
  // Ensure .ok exists (best-effort: the planning init will also create it,
  // but doing it here keeps this command self-contained).
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* already exists or directory created by another command */ }
  const boardFile = join(dir, "board.json");
  if (!existsSync(boardFile)) {
    writeFileSync(
      boardFile,
      JSON.stringify(
        {
          version: 1,
          columns: [
            { id: "backlog", title: "Backlog" },
            { id: "todo", title: "To Do" },
            { id: "doing", title: "In Progress" },
            { id: "review", title: "Review" },
            { id: "done", title: "Done" },
          ],
          tasks: [],
          sessions: {},
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  const tasksIndexFile = join(dir, "tasks.json");
  if (!existsSync(tasksIndexFile)) {
    writeFileSync(tasksIndexFile, JSON.stringify({ tasks: [] }, null, 2), "utf-8");
  }
  const cfg = configPath();
  if (!existsSync(cfg)) {
    saveConfig(DEFAULT_CONFIG);
  }
  console.log("Initialized .ok/ directory.");
}
