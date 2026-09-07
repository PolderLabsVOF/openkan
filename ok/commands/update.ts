// ok/commands/update.ts — `ok update [--check] [--yes] [--version <semver>]`.

import { spawn, spawnSync } from "node:child_process";
import { installedPackageJson } from "./serve.ts";

export async function cmdUpdate(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  // Reject unknown flags instead of silently forwarding them to npm — keeps
  // the surface small and predictable.
  const KNOWN_FLAGS = new Set(["check", "yes", "version", "help", "h"]);
  if (flags.help === true || flags.h === true) {
    console.log("Usage: ok update [--check] [--yes] [--version <semver>]");
    console.log("");
    console.log("  --check          Report installed vs latest, exit non-zero if outdated, do not install.");
    console.log("  --yes            Skip the interactive confirmation prompt.");
    console.log("  --version <v>    Pin the upgrade to a specific semver instead of `latest`.");
    console.log("  -h, --help       Show this help.");
    return;
  }
  for (const flag of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(flag)) {
      console.error(`ok update: unknown flag --${flag} (known: ${[...KNOWN_FLAGS].map(f => `--${f}`).join(", ")})`);
      process.exit(2);
    }
  }
  if (positionals.length > 0) {
    console.error(`ok update: unexpected positional ${positionals[0]} (this command takes no arguments)`);
    process.exit(2);
  }

  const pkg = installedPackageJson();
  if (!pkg) {
    console.error("ok update: cannot determine the installed package (no package.json found above the entrypoint)");
    process.exit(1);
  }

  // --version <semver> lets scripted callers pin to a known target (e.g.
  // nightly); skip the registry query in that case.
  const pinned = typeof flags.version === "string" ? flags.version : null;
  let target = pinned;

  if (!target) {
    // Query the registry for the latest version on the `latest` dist-tag.
    // We intentionally do not cache or background this; `ok update`
    // is explicit, infrequent, and the user wants to see the decision.
    target = await npmLatestVersion(pkg.name);
    if (!target) {
      console.error(`ok update: failed to query the latest version of ${pkg.name} from npm`);
      process.exit(1);
    }
  }

  if (target === pkg.version) {
    console.log(`${pkg.name} ${pkg.version} is already up to date.`);
    return;
  }

  console.log(`${pkg.name}: installed ${pkg.version}, latest ${target}`);

  if (flags.check) {
    // Just report; the user can re-run without --check to actually upgrade.
    process.exitCode = 1;
    return;
  }

  // Skip the confirmation prompt when --yes was passed (CI / scripted use).
  if (!flags.yes) {
    const proceed = await confirm(`Install ${pkg.name}@${target} now? [Y/n] `);
    if (!proceed) {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`Running: npm install -g ${pkg.name}@${target}`);
  const result = spawnSync("npm", ["install", "-g", `${pkg.name}@${target}`], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

async function npmLatestVersion(name: string): Promise<string | null> {
  // `npm view <pkg> dist-tags.latest` prints the bare semver string; with
  // --json it wraps that single value in a JSON array. Handle both shapes
  // because some npm versions (and some package fields) emit array output
  // even for scalar fields.
  const stdout = await new Promise<string>((resolve) => {
    const child = spawn("npm", ["view", name, "dist-tags.latest"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", (code) => { if (code === 0) resolve(out); else resolve(""); });
  }).then(async (text) => {
    if (text.trim()) return text;
    // Fall back to --json and parse, in case the bare call failed (older
    // npm prints only via --json for dotted paths).
    return await new Promise<string>((resolve) => {
      const child = spawn("npm", ["view", name, "dist-tags.latest", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(out));
    });
  });

  const trimmed = stdout.trim();
  if (!trimmed) return null;

  // Accept `"0.4.1"` (bare) or `["0.4.1"]` (json-wrapped).
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    } catch { return null; }
    return null;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return null; }
  }
  return trimmed;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // No TTY → assume yes in the rare case the user piped `ok update`
    // without --yes; the alternative is silent failure which surprises more.
    return true;
  }
  process.stdout.write(question);
  return await new Promise<boolean>((resolve) => {
    const onData = (data: Buffer) => {
      const answer = data.toString().trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(answer === "" || answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}
