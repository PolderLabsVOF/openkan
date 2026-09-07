// tests/cli-version-layout.test.mjs — regression coverage for `ok --version`
// in the compiled layout.
//
// installedPackageJson() used to probe only __dirname, two parents and
// OPENKAN_ROOT. In the built tree the module lives at dist/ok/commands, so
// package.json (three levels up, at the package root) was never found and
// `node dist/bin/ok.js --version` printed "ok: version unavailable".

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
let root;

before(() => {
  // Mirror the built layout: sources one level deeper than the package root,
  // which is where package.json stays.
  root = mkdtempSync(join(tmpdir(), "ok-dist-layout-"));
  mkdirSync(join(root, "dist"));
  for (const dir of ["bin", "ok", "kanban"]) {
    cpSync(join(repo, dir), join(root, "dist", dir), { recursive: true });
  }
  cpSync(join(repo, "package.json"), join(root, "package.json"));
  // Junction reuses dependencies without copying them or needing elevation.
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("ok --version from a nested (dist) layout", () => {
  it("prints the package name and version", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(root, "dist", "bin", "ok.ts"), "--version"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, OPENKAN_SKIP_AGENT_INSTALL: "1", NODE_NO_WARNINGS: "1" },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${pkg.name} ${pkg.version}`);
  });
});
