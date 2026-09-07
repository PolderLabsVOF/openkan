"use strict";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
let root;

before(() => {
  // Copy real entrypoints: changing only cwd would not exercise URL encoding.
  root = mkdtempSync(join(tmpdir(), "ok cli#entry% "));
  for (const dir of ["bin", "ok", "kanban"]) {
    cpSync(join(repo, dir), join(root, dir), { recursive: true });
  }
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  // Junctions reuse dependencies without copying them or requiring Windows elevation.
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Run Node without a shell; bound hangs and retain spawn errors as test failures. */
function run(args) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", NODE_NO_WARNINGS: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

describe("CLI entrypoints in paths containing spaces, # and %", () => {
  for (const entry of ["bin/ok.ts", "bin/ok.mjs"]) {
    it(`${entry} --version prints the installed version`, () => {
      const result = run([join(root, entry), "--version"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `${pkg.name} ${pkg.version}`);
    });
  }

  it("bin/ok.ts --help prints usage", () => {
    const result = run([join(root, "bin/ok.ts"), "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage/i);
  });

  it("bin/ok.ts rejects unknown commands with exit 1", () => {
    const result = run([join(root, "bin/ok.ts"), "definitely-not-a-command"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unknown command: definitely-not-a-command/);
  });

  it("direct task command prints usage and exits 2", () => {
    const result = run([join(root, "ok/commands/task.ts"), "--help"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /usage: ok task </);
  });

  for (const entry of ["bin/ok.ts", "ok/commands/task.ts"]) {
    it(`importing ${entry} without argv[1] has no side effects`, () => {
      const url = pathToFileURL(join(root, entry)).href;
      const files = readdirSync(root);
      const result = run(["--input-type=module", "-e", `
        process.argv = [process.execPath, undefined, "--version"];
        await import(${JSON.stringify(url)});
        process.stdout.write("imported\\n");
      `]);
      // --version prevents an accidental main() call from starting a server.
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "imported\n");
      assert.equal(result.stderr, "");
      assert.deepEqual(readdirSync(root), files);
    });
  }
});
