// ok/commands/init.ts — `ok init` — create .ok/ in cwd.

import { initIfMissing } from "../storage.ts";

export async function cmdInit(): Promise<number> {
  const root = process.cwd();
  const p = await initIfMissing(root);
  process.stdout.write(`.ok/ initialised at ${p.root}\n`);
  process.stdout.write("  config.json\n");
  process.stdout.write("  index.json\n");
  process.stdout.write(`  ${p.tasksDir.replace(`${p.root}/`, "")}/\n`);
  process.stdout.write(`  ${p.plansDir.replace(`${p.root}/`, "")}/\n`);
  process.stdout.write(`  ${p.prdsDir.replace(`${p.root}/`, "")}/\n`);
  process.stdout.write(`  ${p.sessionsDir.replace(`${p.root}/`, "")}/\n`);
  process.stdout.write(`  ${p.locksDir.replace(`${p.root}/`, "")}/\n`);
  return 0;
}
