#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "../dist/bin/openkan.js");
spawn(process.execPath, [...(existsSync(compiled) ? [compiled] : ["--experimental-strip-types", join(here, "openkan.ts")]), ...process.argv.slice(2)], { stdio: "inherit" })
  .on("error", e => { console.error(e.message); process.exit(1); })
  .on("exit", (c, signal) => signal ? process.kill(process.pid, signal) : process.exit(c ?? 1));
