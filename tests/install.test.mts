import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runInstaller(root: string) {
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  return spawnSync("bash", [join(repoRoot, "install.sh")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      OPENKAN_BIN_DIR: binDir,
      OPENKAN_SKIP_DEPENDENCIES: "1",
    },
  });
}

test("installer creates and atomically updates a dedicated OpenKan home", () => {
  const root = mkdtempSync(join(tmpdir(), "openkan-install-"));
  temporaryRoots.push(root);

  const first = runInstaller(root);
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const installRoot = join(root, "data", "openkan");
  const command = join(root, "bin", "openkan");
  assert.equal(lstatSync(command).isSymbolicLink(), true);
  assert.equal(resolve(dirname(command), readlinkSync(command)), join(installRoot, "bin", "openkan.mjs"));
  assert.equal(statSync(join(installRoot, "kanban", "server.ts")).isFile(), true);
  assert.equal(statSync(join(installRoot, "web", "index.html")).isFile(), true);
  assert.equal(statSync(join(installRoot, "commands", "organize.md")).isFile(), true);
  assert.equal(statSync(join(installRoot, "skills", "openkan", "SKILL.md")).isFile(), true);

  writeFileSync(join(installRoot, "obsolete-file"), "remove on update\n");
  const second = runInstaller(root);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.throws(() => statSync(join(installRoot, "obsolete-file")));

  const legacyName = ["open", "code"].join("");
  assert.doesNotMatch(`${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`, new RegExp(legacyName, "i"));
});

test("tracked sources do not carry legacy runtime branding", () => {
  const legacyName = ["open", "code"].join("");
  const result = spawnSync("git", ["grep", "-Iin", legacyName, "--", "."], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stdout || result.stderr);
});
