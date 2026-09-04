import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

import {
  attachBizarWebSocket,
  executeBizarCommand,
  getBizarSnapshot,
  handleBizarRequest,
  resolveBizarConfig,
} from "../kanban/bizar.ts";
import { initBoard, setProjectRoot } from "../kanban/board.ts";
import { apiAbortTask, apiCreateTask, apiStartTask } from "../kanban/server.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openkan-bizar-"));
  roots.push(root);
  mkdirSync(join(root, ".ok"), { recursive: true });
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
    agents: [{ id: "mike", name: "mike" }],
    tasks: [{ id: "F-120", state: "active" }],
    sessions: [],
    messages: []
  }));
} else if (args[0] === "control" && args[1] === "session" && args[2] === "start") {
  process.stdout.write(JSON.stringify({ session: { sessionId: "ses-bizar-1" } }));
} else if (args.includes("--json")) {
  process.stdout.write(JSON.stringify({ ok: true, args }));
}
`);
  chmodSync(fake, 0o755);
  writeFileSync(join(root, ".ok", "openkan.json"), JSON.stringify({
    bizar: {
      enabled: true,
      projectRoot: ".",
      command: fake,
    },
  }), "utf8");
  return { root, fake, log };
}

test("Bizar config resolves project roots relative to the OpenKan project", () => {
  const { root, fake } = fixture();
  assert.deepEqual(resolveBizarConfig(root), {
    enabled: true,
    projectRoot: root,
    command: fake,
  });
});

test("Bizar snapshot is sourced from native Claude Code readers (no CLI crossing)", async () => {
  const { root, log, fake } = fixture();
  const snapshot = await getBizarSnapshot(root);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.projectRoot, root);
  assert.ok(Array.isArray(snapshot.agents));
  assert.ok(Array.isArray(snapshot.tasks));
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(Array.isArray(snapshot.messages));
  // The fake `bizar` binary must NOT be invoked — verify the log is untouched.
  assert.equal(readFileSync(log, "utf8"), "");
  assert.ok(existsSync(fake));
});

test("Bizar POST endpoints return 410 Gone with /api/claude/* successor", async () => {
  const { root } = fixture();
  for (const path of [
    "/api/bizar/tasks",
    "/api/bizar/sessions",
    "/api/bizar/messages",
  ]) {
    const request = new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await handleBizarRequest(root, request, path);
    assert.equal(response.status, 410, `${path} should return 410`);
    const body = await response.json() as { deprecated: boolean; successor: string };
    assert.equal(body.deprecated, true);
    assert.equal(body.successor, "/api/claude/*");
  }
});

test("executeBizarCommand returns local-session stubs (no CLI spawn)", () => {
  const { root, log } = fixture();
  const started = executeBizarCommand(root, "start-session", { agent: "mike", prompt: "hi" });
  assert.ok(started.session?.sessionId?.startsWith("ses-local-"));
  assert.equal(started.deprecated, true);

  const stopped = executeBizarCommand(root, "stop-session", { sessionId: "ses-x" });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.deprecated, true);

  const claimed = executeBizarCommand(root, "claim-task", { id: "task-1", owner: "mike" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status, 410);

  assert.equal(readFileSync(log, "utf8"), "");
});

test("OpenKan board sessions start and stop via local session stub", async () => {
  const { root, log } = fixture();
  setProjectRoot(root);
  const ctx = { directory: root, client: null, log: async () => {} };
  await initBoard(ctx);
  const createdResponse = await apiCreateTask(ctx, new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Run with native stub", description: "Verify the local stub." }),
  }));
  const created = await createdResponse.json() as { id: string };

  const startedResponse = await apiStartTask(root, created.id, new Request("http://localhost/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "mike" }),
  }));
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json() as { state: string; sessionId: string };
  assert.equal(started.state, "running");
  assert.ok(started.sessionId.startsWith("ses-local-"));

  const stoppedResponse = await apiAbortTask(root, created.id);
  assert.equal(stoppedResponse.status, 200);
  const stopped = await stoppedResponse.json() as { state: string };
  assert.equal(stopped.state, "cancelled");

  // No CLI calls were made during the full lifecycle.
  assert.equal(readFileSync(log, "utf8"), "");
});

test("Bizar WebSocket still sends an initial snapshot from native readers", async () => {
  const { root } = fixture();
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const bridge = attachBizarWebSocket(server, () => root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const message = await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/bizar/ws`);
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
      socket.close();
    });
    socket.once("error", reject);
  });

  assert.equal(message.type, "snapshot");
  assert.equal(message.data.version, 1);
  assert.equal(message.data.projectRoot, root);
  assert.ok(Array.isArray(message.data.agents));
  bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("OpenKan ships an Agents workspace without a Bizar tab", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "web", "index.html"), "utf8");
  const script = readFileSync(join(import.meta.dirname, "..", "web", "claude-pane.js"), "utf8");
  assert.match(html, /data-tab="agents"/);
  assert.match(html, /id="claude-pane-root"/);
  assert.doesNotMatch(html, /data-tab="bizar"/);
  assert.match(script, /OpenKanClaude/);
  assert.match(script, /\/api\/claude\/snapshot/);
});
