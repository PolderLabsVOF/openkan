// tests/m19-profiles.test.mts — M19: agents.profiles schema, PATCH route, and CLI stubs.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  validateAgentProfile,
  validateAgentsConfig,
  DEFAULT_AGENTS_CONFIG,
  DEFAULT_AGENT_PROFILE,
} from "../ok/schemas.ts";
import { apiGetConfigSections, apiPatchConfigSection } from "../kanban/server.ts";
import { setProjectRoot } from "../kanban/board.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "openkan-m19-"));
  roots.push(root);
  mkdirSync(join(root, ".ok"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  return root;
}

function writeConfig(root: string, cfg: Record<string, unknown>) {
  writeFileSync(join(root, ".ok", "openkan.json"), JSON.stringify(cfg, null, 2));
}

function readConfig(root: string) {
  return JSON.parse(readFileSync(join(root, ".ok", "openkan.json"), "utf-8"));
}

function makeBizarFixture(root: string) {
  const log = join(root, "bizar-args.jsonl");
  const fake = join(root, "bizar");
  writeFileSync(log, "");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "control" && args[1] === "snapshot") {
  process.stdout.write(JSON.stringify({
    version: 1,
    projectRoot: process.cwd(),
    agents: [{ id: "mike", name: "mike" }, { id: "karen", name: "karen" }],
    tasks: [],
    sessions: [],
    messages: []
  }));
} else if (args[0] === "control" && args[1] === "session" && args[2] === "start") {
  process.stdout.write(JSON.stringify({ session: { sessionId: "ses-m19-1" } }));
}
`);
  chmodSync(fake, 0o755);
  return { log, fake };
}

// ─── Schema validators ───────────────────────────────────────────────────────

test("validateAgentProfile: accepts valid profile", () => {
  const err = validateAgentProfile({
    schema: "openkan.agent-profile.v1",
    id: "claude-code",
    kind: "claude-code",
    bin: "claude",
    description: "Claude Code",
  });
  assert.strictEqual(err, null);
});

test("validateAgentProfile: rejects missing kind", () => {
  const err = validateAgentProfile({
    schema: "openkan.agent-profile.v1",
    id: "test",
    bin: "bin",
  });
  assert.notStrictEqual(err, null);
  assert.strictEqual(err!.path, "kind");
});

test("validateAgentProfile: rejects unknown kind", () => {
  const err = validateAgentProfile({
    schema: "openkan.agent-profile.v1",
    id: "test",
    kind: "unknown-agent",
    bin: "bin",
  });
  assert.notStrictEqual(err, null);
  assert.strictEqual(err!.path, "kind");
});

test("validateAgentProfile: rejects empty bin", () => {
  const err = validateAgentProfile({
    schema: "openkan.agent-profile.v1",
    id: "test",
    kind: "claude-code",
    bin: "   ",
  });
  assert.notStrictEqual(err, null);
  assert.strictEqual(err!.path, "bin");
});

test("validateAgentsConfig: accepts valid config", () => {
  const err = validateAgentsConfig({
    schema: "openkan.agents.v1",
    active: "claude-code",
    profiles: [{ schema: "openkan.agent-profile.v1", id: "claude-code", kind: "claude-code", bin: "claude" }],
  });
  assert.strictEqual(err, null);
});

test("validateAgentsConfig: rejects missing active", () => {
  const err = validateAgentsConfig({
    schema: "openkan.agents.v1",
    profiles: [],
  });
  assert.notStrictEqual(err, null);
  assert.strictEqual(err!.path, "active");
});

test("validateAgentsConfig: rejects profile with empty bin", () => {
  const err = validateAgentsConfig({
    schema: "openkan.agents.v1",
    active: "test",
    profiles: [{ schema: "openkan.agent-profile.v1", id: "test", kind: "claude-code", bin: "" }],
  });
  assert.notStrictEqual(err, null);
  assert.ok(err!.path.startsWith("profiles[0].bin"));
});

test("DEFAULT_AGENTS_CONFIG has claude-code active and one profile", () => {
  assert.strictEqual(DEFAULT_AGENTS_CONFIG.active, "claude-code");
  assert.strictEqual(DEFAULT_AGENTS_CONFIG.profiles.length, 1);
  assert.strictEqual(DEFAULT_AGENTS_CONFIG.profiles[0].id, "claude-code");
  assert.strictEqual(DEFAULT_AGENTS_CONFIG.profiles[0].kind, "claude-code");
});

// ─── Config round-trip ───────────────────────────────────────────────────────

test(".ok/openkan.json round-trip: agents block survives write", async () => {
  const root = makeRoot();
  const cfg = {
    port: 7777,
    host: "127.0.0.1",
    agents: {
      active: "claude-code",
      profiles: [
        { schema: "openkan.agent-profile.v1", id: "claude-code", kind: "claude-code", bin: "claude", description: "Claude Code" },
        { schema: "openkan.agent-profile.v1", id: "codex-cli", kind: "codex-cli", bin: "codex", description: "Codex CLI" },
      ],
    },
    bizar: { enabled: true, projectRoot: "../BizarHarness", command: "../BizarHarness/cli/bin.mjs" },
  };
  writeConfig(root, cfg);

  // Re-read and verify
  const reloaded = readConfig(root);
  assert.strictEqual(reloaded["agents"].active, "claude-code");
  assert.strictEqual(reloaded["agents"].profiles.length, 2);
  assert.strictEqual(reloaded["bizar"].enabled, true);
  assert.strictEqual(reloaded["bizar"].command, "../BizarHarness/cli/bin.mjs");
});

// ─── PATCH /api/config-sections/agents ──────────────────────────────────────

async function startServerWithRoot(root: string): Promise<Server> {
  const log = join(root, "bizar-args.jsonl");
  const fake = join(root, "bizar");
  makeBizarFixture(root);
  setProjectRoot(root);

  const srv = createServer(async (req, res) => {
    // Minimal request handler for config-section routes
    if (req.method === "GET" && req.url === "/api/config-sections") {
      const r = await apiGetConfigSections();
      r.json().then((j: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(j));
      }).catch(() => {
        res.writeHead(500);
        res.end();
      });
      return;
    }
    if (req.method === "PATCH" && req.url?.startsWith("/api/config-sections/")) {
      const sectionId = req.url.slice("/api/config-sections/".length);
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        const r = await apiPatchConfigSection({ directory: root, client: null as any, log: async () => {} }, sectionId, new Request("http://localhost", { method: "PATCH", body }));
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await r.json()));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((res) => srv.listen(0, res));
  return srv;
}

test("PATCH /api/config-sections/agents: sets active profile", async () => {
  const root = makeRoot();
  writeConfig(root, { port: 7777, host: "127.0.0.1" });
  const srv = await startServerWithRoot(root);
  const port = (srv.address() as any).port;
  try {
    const res = await fetch(`http://localhost:${port}/api/config-sections/agents`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ key: "active", value: "claude-code" }]),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { sections: Array<{ id: string; fields: Array<{ key: string; value: unknown }> }> };
    const agentsSection = body.sections.find((s) => s.id === "agents");
    assert.ok(agentsSection, "agents section should be present");
    const activeField = agentsSection!.fields.find((f) => f.key === "active");
    assert.strictEqual(activeField?.value, "claude-code");
  } finally {
    srv.close();
  }
});

test("PATCH /api/config-sections/agents: rejects invalid agents config (422)", async () => {
  const root = makeRoot();
  writeConfig(root, { port: 7777, host: "127.0.0.1" });
  const srv = await startServerWithRoot(root);
  const port = (srv.address() as any).port;
  try {
    // Set profiles with an empty bin (invalid)
    const res = await fetch(`http://localhost:${port}/api/config-sections/agents`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        key: "profiles",
        value: JSON.stringify([{ schema: "openkan.agent-profile.v1", id: "bad", kind: "claude-code", bin: "" }]),
      }]),
    });
    assert.strictEqual(res.status, 422);
  } finally {
    srv.close();
  }
});

test("apiPatchConfigSection default arm: returns 404 for unknown section", async () => {
  const root = makeRoot();
  writeConfig(root, { port: 7777, host: "127.0.0.1" });
  const srv = await startServerWithRoot(root);
  const port = (srv.address() as any).port;
  try {
    const res = await fetch(`http://localhost:${port}/api/config-sections/nonexistent-section`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ key: "foo", value: "bar" }]),
    });
    assert.strictEqual(res.status, 404);
  } finally {
    srv.close();
  }
});

// ─── CLI stubs ───────────────────────────────────────────────────────────────

test("cmdOnboard stub: exits 0 and prints hint", () => {
  const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
  const CLI = `node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "openkan.ts")}`;
  const dir = mkdtempSync(join(tmpdir(), "openkan-m19-cli-"));
  try {
    const stdout = execSync(`${CLI} onboard`, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(stdout.includes("M20") || stdout.includes("onboard"));
  } catch (e: any) {
    assert.fail(`Expected exit 0, got: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdMcp stub: exits 1 with not-yet-wired message", () => {
  const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
  const CLI = `node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "openkan.ts")}`;
  const dir = mkdtempSync(join(tmpdir(), "openkan-m19-cli-"));
  try {
    try {
      execSync(`${CLI} mcp`, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      assert.fail("Expected exit 1");
    } catch (e: any) {
      const code = e.status ?? 1;
      assert.strictEqual(code, 1);
      const stderr = e.stderr?.toString() ?? "";
      assert.ok(stderr.includes("not yet wired") || stderr.includes("M21"), `Expected "not yet wired" in stderr, got: ${stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
