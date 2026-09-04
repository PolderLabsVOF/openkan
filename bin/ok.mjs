#!/usr/bin/env node
// bin/ok.mjs — Node launcher: forwards everything to bin/ok.ts with
// experimental type stripping. Mirrors bin/openkan.mjs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
spawn(
  process.execPath,
  ["--experimental-strip-types", join(here, "ok.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
).on("exit", (c) => process.exit(c ?? 0));
