import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { Board, Task, SessionRecord } from "./board.ts";

const TASKS_DIR = "tasks";
const SESSIONS_DIR = "sessions";
const TRUNCATE_AT = 4000;

// ─── Pure formatters ──────────────────────────────────────────────────────────

export function taskToMarkdown(task: Task, board: Board): string {
  const col = board.columns.find(c => c.id === task.column);
  const lines: string[] = [
    "---",
    `title: ${task.title}`,
    `id: ${task.id}`,
    `column: ${task.column}`,
    `order: ${task.order}`,
    `status: ${task.status}`,
    `agent: ${task.agent || "(default)"}`,
    `model: ${task.model ?? "(default)"}`,
    `createdAt: ${task.createdAt}`,
    `updatedAt: ${task.updatedAt}`,
    `sessionArtifact: ${task.sessionArtifact ?? ""}`,
    "---",
    "",
    `# ${task.title}`,
    "",
  ];

  if (task.description) {
    lines.push(task.description, "");
  }

  lines.push(`_agent: ${task.agent || "(default)"} · _status: ${task.status}_`);

  if (task.sessionId) {
    lines.push(`_session: ${task.sessionId}_`);
  }

  if (task.lastError) {
    lines.push("", `**Last error:** ${task.lastError}`);
  }

  if (task.sessionArtifact) {
    lines.push("", `[Session transcript](./sessions/${task.sessionId}.mdx)`);
  }

  return lines.join("\n");
}

export function sessionToMarkdown(
  sessionId: string,
  rec: SessionRecord,
  task: Task | undefined,
  messages: Array<{ role: string; content: string }>,
  status: string,
): string {
  const lines: string[] = [
    "---",
    `title: Session ${sessionId}`,
    `id: ${sessionId}`,
    `taskId: ${rec.taskId}`,
    `status: ${rec.status}`,
    `startedAt: ${rec.startedAt}`,
    `endedAt: ${rec.endedAt ?? ""}`,
    "---",
    "",
    `# Session ${sessionId}`,
    "",
  ];

  if (task) {
    lines.push(`**Task:** [${task.title}](./${task.id}.mdx)`, "");
  }

  lines.push(
    `**Status:** ${status}`,
    `**Started:** ${rec.startedAt}`,
    rec.endedAt ? `**Ended:** ${rec.endedAt}` : "",
    "",
    "## Transcript",
    "",
  );

  for (const msg of messages) {
    const content = msg.content.length > TRUNCATE_AT
      ? msg.content.slice(0, TRUNCATE_AT) + "\n\n_(truncated — message too long)_"
      : msg.content;
    lines.push(`### ${msg.role}`, "", content, "");
  }

  return lines.join("\n");
}

export function boardToMarkdown(board: Board): string {
  const cols = board.columns;
  const lines: string[] = [
    "---",
    `title: Kanban Board`,
    `generated: ${new Date().toISOString()}`,
    `columns: ${cols.map(c => c.id).join(", ")}`,
    "---",
    "",
    "# Kanban Board",
    "",
  ];

  for (const col of cols) {
    const tasks = board.tasks
      .filter(t => t.column === col.id)
      .sort((a, b) => a.order - b.order);

    lines.push(`## ${col.title}`, "");
    if (tasks.length === 0) {
      lines.push("_No tasks_", "");
    } else {
      for (const t of tasks) {
        const agent = t.agent || "(default)";
        lines.push(`- [${t.id.toUpperCase()}] ${t.title}`);
        lines.push(`  _agent: ${agent} · status: ${t.status}_`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

function ensureDir(dir: string, sub: string): void {
  const p = join(dir, sub);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export async function writeTaskMdx(task: Task, dir: string, board: Board): Promise<void> {
  ensureDir(dir, TASKS_DIR);
  const path = join(dir, TASKS_DIR, `${task.id}.mdx`);
  writeFileSync(path, taskToMarkdown(task, board), "utf-8");
}

export async function writeSessionMdx(
  sessionId: string,
  rec: SessionRecord,
  task: Task | undefined,
  dir: string,
  _client: any, // for future use (e.g. fetching transcript)
): Promise<void> {
  ensureDir(dir, SESSIONS_DIR);
  const path = join(dir, SESSIONS_DIR, `${sessionId}.mdx`);
  // Placeholder — real transcript requires client.session.history() which
  // the SDK may not expose yet. Write a stub; caller can rewrite later.
  const stub = sessionToMarkdown(sessionId, rec, task, [], rec.status);
  writeFileSync(path, stub, "utf-8");
}

export async function writeBoardMdx(board: Board, dir: string): Promise<void> {
  const path = join(dir, "board.mdx");
  writeFileSync(path, boardToMarkdown(board), "utf-8");
}

export async function regenerateAll(board: Board, dir: string): Promise<void> {
  await writeBoardMdx(board, dir);
  for (const task of board.tasks) {
    await writeTaskMdx(task, dir, board);
  }
  for (const [sid, rec] of Object.entries(board.sessions)) {
    const task = board.tasks.find(t => t.id === rec.taskId);
    await writeSessionMdx(sid, rec, task, dir, undefined);
  }
}
