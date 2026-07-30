import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

import {
  attachBizarWebSocket,
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
  mkdirSync(join(root, ".openkan"), { recursive: true });
  const log = join(root, "bizar-args.jsonl");
  const fake = join(root, "bizar");
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
  writeFileSync(join(root, ".openkan", "config.json"), JSON.stringify({
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

test("Bizar snapshot crosses only the JSON CLI boundary", () => {
  const { root, log } = fixture();
  const snapshot = getBizarSnapshot(root);
  assert.equal(snapshot.agents[0].id, "mike");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], ["control", "snapshot", "--json"]);
});

test("Bizar task API validates and forwards task creation", async () => {
  const { root, log } = fixture();
  const request = new Request("http://localhost/api/bizar/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "task-1",
      title: "Implement bridge",
      scopes: ["kanban/bizar.ts"],
    }),
  });
  const response = await handleBizarRequest(root, request, "/api/bizar/tasks");
  assert.equal(response.status, 200);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.at(-1), [
    "task", "create", "task-1",
    "--title", "Implement bridge",
    "--scope", "kanban/bizar.ts",
    "--json",
  ]);
});

test("OpenKan board sessions start and stop through Bizar", async () => {
  const { root, log } = fixture();
  setProjectRoot(root);
  const ctx = { directory: root, client: null, log: async () => {} };
  await initBoard(ctx);
  const createdResponse = await apiCreateTask(ctx, new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Run with Bizar", description: "Verify the bridge." }),
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
  assert.equal(started.sessionId, "ses-bizar-1");

  const stoppedResponse = await apiAbortTask(root, created.id);
  assert.equal(stoppedResponse.status, 200);
  const stopped = await stoppedResponse.json() as { state: string };
  assert.equal(stopped.state, "cancelled");

  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((args: string[]) =>
    args[0] === "control" && args[1] === "session" && args[2] === "start"
  ));
  assert.ok(calls.some((args: string[]) =>
    args[0] === "control" && args[1] === "session" && args[2] === "stop"
  ));
});

test("Bizar WebSocket sends an initial snapshot", async () => {
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
  assert.equal(message.data.tasks[0].id, "F-120");
  bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("OpenKan ships a Bizar workspace for all control-plane resources", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "web", "index.html"), "utf8");
  const script = readFileSync(join(import.meta.dirname, "..", "web", "bizar.js"), "utf8");
  assert.match(html, /data-tab="bizar"/);
  assert.match(html, /id="bizar-root"/);
  for (const resource of ["Agents", "Durable tasks", "Sessions", "Messages"]) {
    assert.match(script, new RegExp(resource));
  }
  assert.match(script, /new WebSocket/);
  assert.match(script, /send-session/);
});
