// OpenKan — archive / restore helpers.

import { type Task, withWrite, getBoard, nowIso } from "./board.ts";
import { writeTaskMdx } from "./mdx.ts";
import { recordEvent } from "./changelog.ts";

export async function archiveTask(task: Task, kanbanDir: string, author: string): Promise<Task> {
  let updated: Task | undefined;
  await withWrite(async (board) => {
    const t = board.tasks.find(x => x.id === task.id);
    if (!t) return;
    t.archived = true;
    t.updatedAt = nowIso();
    updated = { ...t };
  });

  if (!updated) return task;

  // Write the task MDX so frontmatter reflects archived state
  const board = await getBoard();
  await writeTaskMdx(updated, kanbanDir, board);

  recordEvent(kanbanDir, "task.archived", {
    taskId: task.id,
    author,
    summary: `archived '${task.title}'`,
    payload: {},
  });

  return updated;
}

export async function restoreTask(task: Task, kanbanDir: string, author: string): Promise<Task> {
  let updated: Task | undefined;
  await withWrite(async (board) => {
    const t = board.tasks.find(x => x.id === task.id);
    if (!t) return;
    t.archived = false;
    t.updatedAt = nowIso();
    updated = { ...t };
  });

  if (!updated) return task;

  const board = await getBoard();
  await writeTaskMdx(updated, kanbanDir, board);

  recordEvent(kanbanDir, "task.restored", {
    taskId: task.id,
    author,
    summary: `restored '${task.title}'`,
    payload: {},
  });

  return updated;
}
