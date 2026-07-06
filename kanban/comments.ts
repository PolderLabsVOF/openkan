// OpenKan — comment CRUD anchored to MDX blocks.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { ensureDir } from "./io.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Comment {
  id: string;                       // cmt-xxxxxxxx (nanoid)
  taskId: string;
  blockId: string;                  // content-hash block id
  line: number;                     // source line
  text: string;
  author: string;                   // git user.name; "user" if git unavailable; "agent:<name>" if agent
  createdAt: string;                // ISO
  resolved: boolean;
  resolvedBy?: string;              // author who resolved
  resolvedAt?: string;              // ISO
  resolvedReason?: string;          // optional short note on resolve
}

interface CommentsStore {
  comments: Comment[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STORE_FILE = "comments.json";

function storePath(taskDir: string): string {
  return join(taskDir, STORE_FILE);
}

function loadStore(taskDir: string): CommentsStore {
  const p = storePath(taskDir);
  if (!existsSync(p)) return { comments: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CommentsStore;
  } catch {
    return { comments: [] };
  }
}

function saveStore(taskDir: string, store: CommentsStore): void {
  ensureDir(taskDir);
  writeFileSync(storePath(taskDir), JSON.stringify(store, null, 2), "utf-8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all comments for a task, newest first. */
export function listComments(taskId: string, dir: string): Comment[] {
  const taskDir = join(dir, taskId);
  const { comments } = loadStore(taskDir);
  return comments
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Add a new comment. */
export function addComment(
  taskId: string,
  dir: string,
  data: { blockId: string; line: number; text: string; author: string },
): Comment {
  const taskDir = join(dir, taskId);
  ensureDir(taskDir);
  const store = loadStore(taskDir);
  const comment: Comment = {
    id: `cmt-${nanoid(8)}`,
    taskId,
    blockId: data.blockId,
    line: data.line ?? 1,
    text: data.text,
    author: data.author,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  store.comments.push(comment);
  saveStore(taskDir, store);
  return comment;
}

/** Delete a comment by id. Returns true if deleted. */
export function deleteComment(taskId: string, dir: string, commentId: string): boolean {
  const taskDir = join(dir, taskId);
  const store = loadStore(taskDir);
  const before = store.comments.length;
  store.comments = store.comments.filter((c) => !(c.id === commentId && c.taskId === taskId));
  if (store.comments.length === before) return false;
  saveStore(taskDir, store);
  return true;
}

/** Set resolved state of a comment. Returns updated Comment or null if not found. */
export function resolveComment(
  taskId: string,
  dir: string,
  commentId: string,
  resolved: boolean,
  resolvedBy?: string,
  resolvedAt?: string,
  resolvedReason?: string,
): Comment | null {
  const taskDir = join(dir, taskId);
  const store = loadStore(taskDir);
  const idx = store.comments.findIndex((c) => c.id === commentId && c.taskId === taskId);
  if (idx === -1) return null;
  const now = resolvedAt ?? new Date().toISOString();
  store.comments[idx] = {
    ...store.comments[idx],
    resolved,
    ...(resolved ? { resolvedBy: resolvedBy ?? store.comments[idx].author, resolvedAt: now, resolvedReason } : {}),
  };
  saveStore(taskDir, store);
  return store.comments[idx];
}
