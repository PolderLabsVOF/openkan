// OpenKan — image storage helpers.

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { ensureDir } from "./io.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImageMeta {
  name: string;        // file name (incl. extension)
  taskId: string;
  size: number;        // bytes
  contentType: string; // mime type
  uploadedAt: string;  // ISO
  uploadedBy: string;   // author (git name or "user" or "agent:<name>")
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const CONTENT_TYPE_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const STORE_FILE = "images.json";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function imagesStorePath(taskDir: string): string {
  return join(taskDir, STORE_FILE);
}

function loadStore(taskDir: string): { images: ImageMeta[] } {
  const p = imagesStorePath(taskDir);
  if (!existsSync(p)) return { images: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as { images: ImageMeta[] };
  } catch {
    return { images: [] };
  }
}

function saveStore(taskDir: string, store: { images: ImageMeta[] }): void {
  ensureDir(taskDir);
  writeFileSync(imagesStorePath(taskDir), JSON.stringify(store, null, 2), "utf-8");
}

function validateExtension(ext: string): string | null {
  const lower = ext.toLowerCase().replace(/^\./, "");
  if (!ALLOWED_EXTENSIONS.has(lower)) return null;
  return lower;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Return the path to the images directory for a task. */
export function imagesDir(taskId: string, kanbanDir: string): string {
  return join(kanbanDir, "tasks", taskId, "images");
}

/** Ensure the images directory for a task exists and return its path. */
export function ensureImagesDir(taskId: string, kanbanDir: string): string {
  const dir = imagesDir(taskId, kanbanDir);
  ensureDir(dir);
  return dir;
}

/**
 * Save an image buffer to a task's images directory.
 * v1 accepts JSON with base64-encoded data.
 *
 * @returns ImageMeta for the saved file.
 * @throws Error if extension is not allowed or size exceeds 10 MB.
 */
export function saveImage(
  taskId: string,
  kanbanDir: string,
  buffer: Buffer,
  ext: string,
  contentType: string,
  author: string,
): ImageMeta {
  const validExt = validateExtension(ext);
  if (!validExt) {
    throw new Error(`Invalid file extension: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`);
  }
  if (buffer.length > MAX_SIZE_BYTES) {
    throw new Error(`File too large: ${buffer.length} bytes. Maximum allowed: ${MAX_SIZE_BYTES} bytes.`);
  }

  const dir = ensureImagesDir(taskId, kanbanDir);
  const name = `img-${nanoid(8)}.${validExt}`;
  const filePath = join(dir, name);

  // Write atomically
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, buffer);
  try {
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch (_) { /* atomic write best-effort on this filesystem */ }
  renameSync(tmp, filePath);

  const meta: ImageMeta = {
    name,
    taskId,
    size: buffer.length,
    contentType: contentType ?? CONTENT_TYPE_MAP[validExt] ?? "application/octet-stream",
    uploadedAt: new Date().toISOString(),
    uploadedBy: author,
  };

  // Record in images.json
  const taskDir = join(kanbanDir, "tasks", taskId);
  const store = loadStore(taskDir);
  store.images.push(meta);
  saveStore(taskDir, store);

  return meta;
}

/** List all images for a task. */
export function listImages(taskId: string, kanbanDir: string): ImageMeta[] {
  const taskDir = join(kanbanDir, "tasks", taskId);
  const { images } = loadStore(taskDir);
  return images.filter(img => img.taskId === taskId);
}

/** Delete a named image from a task. Returns true if deleted, false if not found. */
export function deleteImage(taskId: string, kanbanDir: string, name: string): boolean {
  const taskDir = join(kanbanDir, "tasks", taskId);
  const dir = imagesDir(taskId, kanbanDir);
  const filePath = join(dir, name);

  const store = loadStore(taskDir);
  const before = store.images.length;
  store.images = store.images.filter(img => !(img.name === name && img.taskId === taskId));
  if (store.images.length === before) return false;

  // Remove file
  try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }

  saveStore(taskDir, store);
  return true;
}

/**
 * Read an image file for serving via HTTP.
 * Returns { buffer, contentType } or null if not found.
 */
export function readImage(
  taskId: string,
  kanbanDir: string,
  name: string,
): { buffer: Buffer; contentType: string } | null {
  const dir = imagesDir(taskId, kanbanDir);
  const filePath = join(dir, name);
  if (!existsSync(filePath)) return null;

  const store = loadStore(join(kanbanDir, "tasks", taskId));
  const meta = store.images.find(img => img.name === name && img.taskId === taskId);
  const contentType = meta?.contentType ?? "application/octet-stream";

  try {
    return { buffer: readFileSync(filePath), contentType };
  } catch {
    return null;
  }
}
