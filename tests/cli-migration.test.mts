// tests/cli-migration.test.mts — post-cutover invariant suite for the OK
// migration. Locks the repo state after M1 (CLI relocated from bin/openkan.ts
// into ok/commands/*) and M2 (bin/openkan.mjs deleted, package bumped to
// 0.5.0, bin field publishes only `ok`, log prefixes, README, install.sh,
// CHANGELOG). M5 is the only remaining OK migration milestone.
//
// Each test is a single invariant. A future PR that reverts M1 or M2 even
// partially should fail this suite at the corresponding assertion.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ─── M1: bin/openkan.ts deleted ───────────────────────────────────────────────

test("bin/openkan.ts is gone (M1)", () => {
  assert.equal(existsSync("bin/openkan.ts"), false);
});

// ─── M2: bin/openkan.mjs deleted, package renamed to ok@0.5.0 ─────────────────

test("bin/openkan.mjs is gone (M2)", () => {
  assert.equal(existsSync("bin/openkan.mjs"), false);
});

test("package.json version is 0.7.0", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  assert.equal(pkg.version, "0.7.0");
});

test("package.json bin field only publishes ok", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { bin?: Record<string, string> };
  assert.deepEqual(pkg.bin, { ok: "bin/ok.mjs" });
});

test("package.json scripts do not reference bin/openkan.ts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  for (const [name, value] of Object.entries(pkg.scripts)) {
    assert.equal(
      value.includes("bin/openkan.ts"),
      false,
      `script '${name}' still references bin/openkan.ts: ${value}`,
    );
  }
});

test("package.json scripts do not reference bin/openkan.mjs", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  for (const [name, value] of Object.entries(pkg.scripts)) {
    assert.equal(
      value.includes("bin/openkan.mjs"),
      false,
      `script '${name}' still references bin/openkan.mjs: ${value}`,
    );
  }
});

// ─── M1: every bin/openkan.ts subcommand module relocated to ok/commands/* ────

test("ok/commands/ has the expected M1 subcommand modules", () => {
  const expected = [
    "agent", "api", "board", "board-init", "config", "goal", "import",
    "logs", "mcp", "onboard", "project", "reset", "serve", "skill", "update",
  ];
  const present = readdirSync("ok/commands")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
  for (const cmd of expected) {
    assert.equal(present.includes(cmd), true, `missing ok/commands/${cmd}.ts`);
  }
});

test("bin/ok.ts imports and dispatches all expected commands", () => {
  const src = readFileSync("bin/ok.ts", "utf8");
  for (const cmd of [
    "Agent", "Api", "Board", "BoardInit", "Config", "Logs", "Mcp", "Onboard",
    "Reset", "Update", "Skill", "Project", "Import",
  ]) {
    assert.equal(src.includes(`cmd${cmd}`), true, `bin/ok.ts missing cmd${cmd} import`);
  }
  for (const cmd of ["task", "plan", "prd", "goal", "progress", "doctor", "index"]) {
    assert.equal(src.includes(`"${cmd}"`), true, `bin/ok.ts missing planner command '${cmd}'`);
  }
});

// ─── M2: log prefix, docs, install link, CHANGELOG, version smoke ──────────────

test("bin/install-agent.mjs uses [ok] log prefix, not [openkan]", () => {
  const src = readFileSync("bin/install-agent.mjs", "utf8");
  assert.equal(src.includes("[openkan]"), false, "bin/install-agent.mjs still uses [openkan] prefix");
  assert.equal(src.includes("[ok]"), true, "bin/install-agent.mjs missing [ok] prefix");
});

test("README.md does not document openkan CLI usage", () => {
  const src = readFileSync("README.md", "utf8");
  assert.equal(/npx openkan\s/.test(src), false, "README.md still shows 'npx openkan <cmd>'");
  assert.equal(/npm i -g openkan/.test(src), false, "README.md still shows 'npm i -g openkan'");
  assert.equal(/npm install -g openkan/.test(src), false, "README.md still shows 'npm install -g openkan'");
});

test("install.sh links ${BIN_DIR}/ok, not openkan", () => {
  const src = readFileSync("install.sh", "utf8");
  assert.equal(/BIN_DIR.*openkan/.test(src), false, "install.sh still references openkan binary path");
  assert.equal(src.includes("${BIN_DIR}/ok"), true, "install.sh missing ${BIN_DIR}/ok link");
});

test("CHANGELOG.md has a 0.5.0 entry (M2 baseline)", () => {
  const src = readFileSync("CHANGELOG.md", "utf8");
  assert.equal(src.includes("0.5.0"), true, "CHANGELOG.md missing 0.5.0 entry");
});
test("CHANGELOG.md has a 0.6.1 entry (daemon hardening)", () => {
  const src = readFileSync("CHANGELOG.md", "utf8");
  assert.equal(src.includes("0.6.1"), true, "CHANGELOG.md missing 0.6.1 entry");
});

test("bin/ok.ts --version prints a semver version", () => {
  const out = execSync("node --experimental-strip-types bin/ok.ts --version", { encoding: "utf8" });
  assert.match(out, /\d+\.\d+\.\d+/, "bin/ok.ts --version did not print a semver version");
});

test("bin/ok.mjs exists as the published ok entrypoint", () => {
  assert.equal(existsSync("bin/ok.mjs"), true, "bin/ok.mjs missing — package.json bin field would dangle");
});

// ─── Regression sweep: no test file references the legacy bin entrypoints ─────

test("no test file references the legacy bin/openkan.{ts,mjs}", () => {
  const offenders: string[] = [];
  // Compare resolved absolute paths so this self-exclusion survives Windows:
  // walk() joins with platform-native backslashes, but a forward-slash SELF
  // constant never matches and the test would flag its own file as offender.
  const SELF = resolve("tests/cli-migration.test.mts");
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (resolve(full) !== SELF && /\.test\.(mjs|mts)$/.test(entry)) {
        const text = readFileSync(full, "utf8");
        if (text.includes("bin/openkan.ts") || text.includes("bin/openkan.mjs")) {
          offenders.push(full);
        }
      }
    }
  }
  walk("tests");
  assert.deepEqual(offenders, [], `test files still reference bin/openkan: ${offenders.join(", ")}`);
});

test("the offender scan excludes itself on native path separators", () => {
  // Guards the check above: this file mentions the legacy names, so a
  // self-exclusion that only matches forward slashes made the scan flag
  // itself on Windows. Both forms must resolve to the same absolute path.
  const self = resolve("tests/cli-migration.test.mts");
  assert.equal(resolve(join("tests", "cli-migration.test.mts")), self);
  assert.ok(readFileSync(self, "utf8").includes("bin/openkan.ts"));
});
