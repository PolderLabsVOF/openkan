#!/usr/bin/env node
// bin/ok.mjs — Node launcher: forwards everything to bin/ok.ts with
// experimental type stripping. Mirrors bin/openkan.mjs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "../dist/bin/ok.js");
spawn(
  process.execPath,
  [...(existsSync(compiled) ? [compiled] : ["--experimental-strip-types", join(here, "ok.ts")]), ...process.argv.slice(2)],
  { stdio: "inherit" },
).on("error", (e) => { console.error(e.message); process.exit(1); })
 .on("exit", (c, signal) => signal ? process.kill(process.pid, signal) : process.exit(c ?? 1));
