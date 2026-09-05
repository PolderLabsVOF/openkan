import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      AGENTS_HOME: join(home, ".agents"),
      OPENKAN_BIN_DIR: binDir,
      OPENKAN_SKIP_DEPENDENCIES: "1",
      // Force agent install on. CI workflows set OPENKAN_SKIP_AGENT_INSTALL=1
      // globally to suppress postinstall side effects; this test asserts the
      // full install path including the agent copy.
      OPENKAN_SKIP_AGENT_INSTALL: "0",
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
  assert.equal(statSync(join(root, "home", ".codex", "skills", "openkan", "SKILL.md")).isFile(), true);
  assert.equal(statSync(join(root, "home", ".claude", "skills", "openkan", "SKILL.md")).isFile(), true);
  assert.equal(statSync(join(root, "home", ".agents", "skills", "openkan", "SKILL.md")).isFile(), true);

  assert.match(readFileSync(join(root, "home", ".claude", "agents", "openkan.md"), "utf8"), /name: openkan/);

  writeFileSync(join(installRoot, "obsolete-file"), "remove on update\n");
  writeFileSync(join(root, "home", ".codex", "skills", "openkan", "obsolete-file"), "remove on update\n");
  const second = runInstaller(root);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.throws(() => statSync(join(installRoot, "obsolete-file")));
  assert.throws(() => statSync(join(root, "home", ".codex", "skills", "openkan", "obsolete-file")));

  const legacyName = ["open", "code"].join("");
  assert.doesNotMatch(`${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`, new RegExp(legacyName, "i"));
});

test("installer bootstraps the complete source tree when piped to bash", () => {
  const root = mkdtempSync(join(tmpdir(), "openkan-curl-install-"));
  temporaryRoots.push(root);
  const archiveRoot = join(root, "archive", "openkan-main");
  mkdirSync(archiveRoot, { recursive: true });

  for (const directory of ["bin", "commands", "kanban", "ok", "skills", "web", "agents"]) {
    cpSync(join(repoRoot, directory), join(archiveRoot, directory), { recursive: true });
  }
  for (const file of ["install.sh", "package.json", "package-lock.json", "README.md", "CHANGELOG.md", "LICENSE"]) {
    cpSync(join(repoRoot, file), join(archiveRoot, file));
  }

  const archive = join(root, "openkan.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", join(root, "archive"), "openkan-main"], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);

  const home = join(root, "home");
  const dataHome = join(root, "data");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const piped = spawnSync("bash", ["-s", "--"], {
    cwd: root,
    input: readFileSync(join(repoRoot, "install.sh"), "utf8"),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      AGENTS_HOME: join(home, ".agents"),
      OPENKAN_BIN_DIR: binDir,
      OPENKAN_INSTALL_ARCHIVE_URL: pathToFileURL(archive).href,
      OPENKAN_SKIP_DEPENDENCIES: "1",
    },
  });

  assert.equal(piped.status, 0, piped.stderr || piped.stdout);
  assert.match(piped.stdout, /Downloading OpenKan/);
  assert.equal(statSync(join(dataHome, "openkan", "kanban", "server.ts")).isFile(), true);
  assert.equal(lstatSync(join(binDir, "openkan")).isSymbolicLink(), true);
});

test("tracked sources do not carry legacy runtime branding", () => {
  const legacyName = ["open", "code"].join("");
  const result = spawnSync("git", ["grep", "-Iin", legacyName, "--", "."], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stdout || result.stderr);
});
