import type { Plugin } from "@opencode-ai/plugin";
import { join } from "path";
import { initBoard } from "../kanban/board.ts";
import { startServer, handleEvent, subscribeEvents, getServer } from "../kanban/server.ts";

export const KanbanPlugin: Plugin = async ({ project, client, $, directory }) => {
  // Capability check — require session + event APIs
  const hasSession = !!(client?.session?.create && client?.session?.promptAsync);
  const hasEvents  = !!(client?.event?.subscribe);
  if (!hasSession || !hasEvents) {
    await (client?.app?.log?.({
      body: { service: "openkan", level: "warn",
        message: "client missing required session/event APIs; plugin disabled" },
    }).catch(() => {}));
    return {};
  }

  const ctx = {
    directory,
    client,
    log: async (lvl: "debug" | "info" | "warn" | "error", msg: string, extra?: unknown) => {
      await (client?.app?.log?.({
        body: { service: "openkan", level: lvl, message: msg, ...(extra ? { extra } : {}) },
      }).catch(() => {}));
    },
  };

  // Initialise board
  await initBoard(ctx);

  // Start HTTP server (idempotent — returns existing if already started)
  const webRoot = join(import.meta.dir, "..", "web");
  await startServer(ctx, { webRoot });

  // Subscribe to opencode events — idempotent via module-level guard in startServer
  const sseAbort = new AbortController();
  subscribeEvents(ctx, sseAbort.signal).catch((e: any) => {
    ctx.log("error", `SSE subscription error: ${e?.message ?? e}`);
  });

  return {
    event: async ({ event }: { event: any }) => {
      await handleEvent(ctx, event);
    },
  };
};

export default KanbanPlugin;
