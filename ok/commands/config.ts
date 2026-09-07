// ok/commands/config.ts — `ok config list|get|set` — manage .ok/openkan.json.

import { loadConfig, saveConfig } from "./serve.ts";

export async function cmdConfig(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "";
  if (sub === "list") {
    console.log(JSON.stringify(loadConfig(), null, 2));
    return;
  }
  if (sub === "get") {
    const key = argv[1];
    if (!key) {
      console.error("Usage: config get <key>");
      process.exit(1);
    }
    const cfg = loadConfig();
    const val = key.split(".").reduce((obj: any, k) => obj?.[k], cfg);
    console.log(typeof val === "object" ? JSON.stringify(val) : String(val ?? ""));
    return;
  }
  if (sub === "set") {
    const key = argv[1];
    const value = argv[2];
    if (!key || value === undefined) {
      console.error("Usage: config set <key> <value>");
      process.exit(1);
    }
    // Parse value as JSON if possible, else string
    let parsed: any;
    try { parsed = JSON.parse(value); } catch { parsed = value; }
    const cfg = loadConfig();
    const keys = key.split(".");
    const last = keys.pop()!;
    const target = keys.reduce((obj: any, k) => { if (!(k in obj)) obj[k] = {}; return obj[k]; }, cfg);
    target[last] = parsed;
    saveConfig(cfg);
    console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
    return;
  }
  console.error("Usage: config list | config get <key> | config set <key> <value>");
  process.exit(1);
}
