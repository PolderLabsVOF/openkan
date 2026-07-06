import type { Plugin } from "@opencode-ai/plugin";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { initBoard, setProjectRoot, getBoard, nowIso, KANBAN_DIR } from "../kanban/board.ts";
import { startServer, handleEvent, subscribeEvents, getServer } from "../kanban/server.ts";
import { writeTaskMdx } from "../kanban/mdx.ts";
import { recordEvent } from "../kanban/changelog.ts";
import { writeFileAtomic } from "../kanban/io.ts";
import { type ProgressNote } from "../kanban/mdx.ts";

// Throttle: at most 1 progress note per second per session
const lastProgressTime = new Map<string, number>();

function appendProgressNote(taskId: string, kanbanDir: string, text: string): void {
  const now = Date.now();
  const last = lastProgressTime.get(taskId) ?? 0;
  if (now - last < 1000) return; // throttle
  lastProgressTime.set(taskId, now);

  const progressFile = join(kanbanDir, "tasks", taskId, "progress.json");
  let notes: ProgressNote[] = [];
  try {
    if (existsSync(progressFile)) {
      notes = JSON.parse(readFileSync(progressFile, "utf-8")) as ProgressNote[];
    }
  } catch { notes = []; }

  const ts = nowIso();
  notes.push({ ts, text });
  writeFileSync(progressFile, JSON.stringify(notes, null, 2), "utf-8");

  // Also append to the task MDX's ## Agent progress section
  appendMdxProgress(kanbanDir, taskId, ts, text);
}

/**
 * Append a one-liner to the task MDX under ## Agent progress.
 * Creates the section if it doesn't exist.
 */
function appendMdxProgress(kanbanDir: string, taskId: string, ts: string, text: string): void {
  const mdxPath = join(kanbanDir, "tasks", taskId, "task.mdx");
  if (!existsSync(mdxPath)) return;

  let content: string;
  try {
    content = readFileSync(mdxPath, "utf-8");
  } catch {
    return;
  }

  const timeStr = new Date(ts).toISOString().replace("T", " ").slice(0, 19);
  const entry = `\n- [${timeStr}] ${text}`;

  // Does ## Agent progress section exist?
  const sectionRe = /(## Agent progress\s*)/i;
  const match = content.match(sectionRe);
  if (match) {
    // Append after the heading
    const pos = match.index! + match[0].length;
    content = content.slice(0, pos) + entry + content.slice(pos);
  } else {
    // Append at end of file
    content = content.trimEnd() + "\n\n## Agent progress\n" + entry + "\n";
  }

  writeFileAtomic(mdxPath, content);
}

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
  setProjectRoot(ctx.directory);

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

      // Auto-progress: when a tool is called or message part arrives in a linked session, note it
      const isToolEvent = event?.type === "session.tool.call" || event?.type === "tool.call";
      const isMessageEvent = event?.type === "message.part.updated";
      if (!isToolEvent && !isMessageEvent) return;

      const sid: string = event.properties?.sessionID ?? event.properties?.sessionId ?? "";
      if (!sid) return;
      const board = await getBoard();
      const rec = board.sessions[sid];
      if (!rec) return;

      let text: string;
      if (isToolEvent) {
        const toolName: string = event.properties?.toolName ?? event.properties?.name ?? "unknown";
        text = `tool: ${toolName}`;
        // Extract extra context if available
        const toolArgs = event.properties?.arguments;
        if (toolArgs && typeof toolArgs === "string" && toolArgs.length > 0) {
          const shortArgs = toolArgs.slice(0, 60);
          text += shortArgs !== toolArgs ? ` — ${shortArgs}…` : ` — ${shortArgs}`;
        }
      } else {
        // message.part.updated
        const partType: string = event.properties?.partType ?? "text";
        const content: string = event.properties?.content ?? "";
        const shortContent = content.length > 80 ? content.slice(0, 80) + "…" : content;
        text = `${partType}: ${shortContent}`;
      }

      appendProgressNote(rec.taskId, KANBAN_DIR, text);
      // Also record a changelog event (throttled to 1/sec in recordEvent is fine)
      recordEvent(KANBAN_DIR, "agent.progress", {
        taskId: rec.taskId,
        author: "agent",
        summary: text.slice(0, 80),
        payload: { sessionId: sid, text },
      });
    },
  };
};

export default KanbanPlugin;
