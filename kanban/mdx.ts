import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Board, Task, SessionRecord, TaskArtifacts } from "./board.ts";
import { type Input, listInputs } from "./inputs.ts";
import type { Category, Priority, Effort } from "./tags.ts";

export interface ProgressNote { ts: string; text: string; }

export function categoryEmoji(c: Category): string {
  const map: Record<Category, string> = {
    frontend: "🎨", backend: "⚙️",  infra: "☁️",   docs: "📖",
    test: "🧪", design: "✏️", data: "🗄️", security: "🔒", task: "📋",
  };
  return map[c] ?? "📋";
}

export function priorityEmoji(p: Priority): string {
  const map: Record<Priority, string> = {
    urgent: "🚨", high: "⬆️", normal: "➡️", low: "⬇️",
  };
  return map[p] ?? "➡️";
}

const TASKS_DIR = "tasks";
const SESSIONS_DIR = "sessions";
const TRUNCATE_AT = 4000;

// ─── Pure formatters ──────────────────────────────────────────────────────────

export function taskToMarkdown(task: Task, board: Board, extra?: { pendingInputs?: Input[] }): string {
  const col = board.columns.find(c => c.id === task.column);
  const prio = task.priority ?? "normal";
  const effort = task.effort ?? "—";
  const tags = task.tags ?? [];
  const lines: string[] = [
    "---",
    `title: ${task.title}`,
    `id: ${task.id}`,
    `column: ${task.column}`,
    `order: ${task.order}`,
    `state: ${task.state}`,
    `status: ${task.status}`,
    `agent: ${task.agent || "(default)"}`,
    `model: ${task.model ?? "(default)"}`,
    `createdAt: ${task.createdAt}`,
    `updatedAt: ${task.updatedAt}`,
    `tags: [${tags.map(t => `"${t}"`).join(", ")}]`,
    `category: ${task.category ?? "task"}`,
    `priority: ${prio}`,
    `effort: ${effort}`,
    `archived: ${task.archived ? "true" : "false"}`,
    "---",
    "",
    `# ${task.title}`,
    "",
    `> **Category:** \`${task.category ?? "task"}\` · **Priority:** ${priorityEmoji(prio)} ${prio} · **Effort:** ${effort}`,
    `> **Tags:** ${tags.map(t => `\`${t}\``).join(" ")}`,
    "",
  ];

  if (task.description) {
    lines.push(task.description, "");
  }

  if (task.stale) {
    lines.push("> ⚠️ Source has changed since this task was imported. Re-run kanban_import to refresh.", "");
  }

  if (task.source) {
    lines.push(`> 📄 Source: \`${task.source.path}:${task.source.line}\` *(imported from line ${task.source.line})*`, "");
  }

  lines.push(`_agent: ${task.agent || "(default)"} · _state: ${task.state}_`);

  if (task.sessionId) {
    lines.push(`_session: ${task.sessionId}_`);
  }

  if (task.lastError) {
    lines.push("", `**Last error:** ${task.lastError}`);
  }

  if (task.sessionArtifact) {
    lines.push("", `[Session transcript](./sessions/${task.sessionId}.mdx)`);
  }

  // If there are pending inputs, append an "Awaiting input" section
  const pending = extra?.pendingInputs ?? [];
  const unresolved = pending.filter(i => i.status === "pending");
  if (unresolved.length > 0) {
    lines.push("", "## Awaiting input", "");
    for (const inp of unresolved) {
      if (inp.type === "choice" && inp.options) {
        const opts = inp.options.map(o => `- **${o.label}**${o.description ? `: ${o.description}` : ""}`).join("\n");
        lines.push(`<Choice question="${inp.question}" options={${JSON.stringify(inp.options.map(o => ({ id: o.id, label: o.label })))}} />`);
      } else {
        lines.push(`<Ask question="${inp.question}" />`);
      }
      lines.push("");
    }
  }

  // Agent progress section — read from progress.json in the task dir
  const progressFile = join(task.artifacts.mdxPath, "..", "progress.json");
  let progressNotes: ProgressNote[] = [];
  try {
    if (existsSync(progressFile)) {
      progressNotes = JSON.parse(readFileSync(progressFile, "utf-8")) as ProgressNote[];
    }
  } catch { /* ignore */ }

  if (progressNotes.length > 0) {
    lines.push("", "## Agent progress", "");
    for (const note of progressNotes) {
      const time = new Date(note.ts).toLocaleTimeString("en-US", { hour12: false });
      lines.push(`- [${time}] ${note.text}`);
    }
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

/** Write task MDX to per-task directory (tasks/<id>/task.mdx). */
export async function writeTaskMdx(task: Task, dir: string, board: Board): Promise<void> {
  ensureDir(dir, TASKS_DIR);
  const taskDir = join(dir, TASKS_DIR, task.id);
  ensureDir(dir, `${TASKS_DIR}/${task.id}`);
  const path = join(taskDir, "task.mdx");
  // Load pending inputs for the "Awaiting input" section
  let pendingInputs: Input[] = [];
  try {
    pendingInputs = listInputs(task.id, dir);
  } catch {
    // ignore
  }
  const mdxContent = taskToMarkdown(task, board, { pendingInputs });
  writeFileSync(path, mdxContent, "utf-8");
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

// ─── Frontmatter helpers ───────────────────────────────────────────────────────

/**
 * Strip YAML frontmatter from an MDX string and return the body text, trimmed.
 * Handles the common ---...--- delimiter format used in task MDX files.
 */
export function extractDescription(mdx: string): string {
  const match = mdx.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return mdx.trim();
  return match[1].trim();
}

/**
 * Return the mtime of a task's MDX file, or null if it doesn't exist.
 * @param taskId - the task id
 * @param kanbanDir - the .ok directory path
 */
export function statMdxMtime(taskId: string, kanbanDir: string): string | null {
  const mdxPath = join(kanbanDir, "tasks", taskId, "task.mdx");
  try {
    if (existsSync(mdxPath)) {
      return statSync(mdxPath).mtime.toISOString();
    }
  } catch { /* ignore */ }
  return null;
}
