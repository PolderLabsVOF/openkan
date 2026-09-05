import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const directory of ['web', 'skills', 'commands', 'agents']) {
  cpSync(new URL(`../${directory}/`, import.meta.url), new URL(directory, dist), { recursive: true });
}
mkdirSync(new URL('.claude/skills/', dist), { recursive: true });
cpSync(new URL('../.claude/skills/ok-planning/', import.meta.url), new URL('.claude/skills/ok-planning/', dist), { recursive: true });
