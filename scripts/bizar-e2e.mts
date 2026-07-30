#!/usr/bin/env node

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

import { initBoard, setProjectRoot, type BoardContext } from "../kanban/board.ts";
import { startOrAttach } from "../kanban/server.ts";

const root = resolve(import.meta.dirname, "..");
const checks: string[] = [];
const ctx: BoardContext = {
  directory: root,
  client: null as any,
  log: async () => {},
};

function pass(name: string): void {
  checks.push(name);
  process.stdout.write(`  ✓ ${name}\n`);
}

async function websocketSnapshot(url: string): Promise<any> {
  return new Promise((resolveMessage, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Bizar WebSocket snapshot timed out"));
    }, 10_000);
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type !== "snapshot") return;
      clearTimeout(timeout);
      socket.close();
      resolveMessage(event.data);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

process.stdout.write("\n  OPENKAN × BIZAR E2E\n\n");
setProjectRoot(root);
await initBoard(ctx);
const server = await startOrAttach(ctx, {
  host: "127.0.0.1",
  port: 18777,
  maxPortTries: 20,
  webRoot: join(root, "web"),
  _autoDetect: false,
});

try {
  assert.equal(server.isPrimary, true, "E2E requires its own primary server");
  pass("OpenKan server starts");

  const response = await fetch(`${server.url}/api/bizar/snapshot`);
  assert.equal(response.status, 200);
  const snapshot = await response.json() as any;
  assert.ok(snapshot.agents.length >= 1);
  assert.ok(Array.isArray(snapshot.features));
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(Array.isArray(snapshot.messages));
  pass("REST snapshot exposes Bizar state");

  const ws = await websocketSnapshot(server.url.replace("http:", "ws:") + "/api/bizar/ws");
  assert.equal(ws.projectRoot, snapshot.projectRoot);
  assert.equal(ws.agents.length, snapshot.agents.length);
  pass("WebSocket streams the same project");

  const html = await (await fetch(server.url)).text();
  const script = await (await fetch(`${server.url}/bizar.js`)).text();
  assert.match(html, /data-tab="bizar"/);
  assert.match(script, /start-session/);
  assert.match(script, /send-session/);
  pass("Bizar workspace assets are served");

  const integrationFeature = snapshot.features.find((feature: any) => feature.id === "F-120");
  assert.equal(integrationFeature?.state, "passing");
  pass("completed Bizar feature is visible");
} finally {
  await server.stop();
}

process.stdout.write(`\n  ${checks.length}/${checks.length} checks passed\n\n`);
