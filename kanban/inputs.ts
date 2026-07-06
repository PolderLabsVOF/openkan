// OpenKan — input request CRUD (ask/choice/input/confirm).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./io.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InputType = "ask" | "choice" | "input" | "confirm";

export interface Input {
  id: string; // inp-xxxxxxxx
  taskId: string;
  type: InputType;
  question: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  placeholder?: string;
  blockId?: string;
  status: "pending" | "responded" | "cancelled";
  response?: string;
  responseOptionId?: string;
  createdAt: string;
  respondedAt: string | null;
}

interface InputsStore {
  inputs: Input[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STORE_FILE = "inputs.json";

function storePath(taskDir: string): string {
  return join(taskDir, STORE_FILE);
}

function loadStore(taskDir: string): InputsStore {
  const p = storePath(taskDir);
  if (!existsSync(p)) return { inputs: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as InputsStore;
  } catch {
    return { inputs: [] };
  }
}

function saveStore(taskDir: string, store: InputsStore): void {
  ensureDir(taskDir);
  writeFileSync(storePath(taskDir), JSON.stringify(store, null, 2), "utf-8");
}

function makeId(taskId: string, question: string, blockId: string | undefined): string {
  const input = `${taskId}${question}${blockId ?? ""}${Date.now()}`;
  const sha = createHash("sha1").update(input).digest("hex").slice(0, 12);
  return `inp-${sha}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all inputs for a task, newest first. */
export function listInputs(taskId: string, dir: string): Input[] {
  const taskDir = join(dir, taskId);
  const { inputs } = loadStore(taskDir);
  return inputs.filter((i) => i.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Return the most recent pending input for a task, or null. */
export function getPendingInput(taskId: string, dir: string): Input | null {
  const taskDir = join(dir, taskId);
  const { inputs } = loadStore(taskDir);
  const pending = inputs
    .filter((i) => i.taskId === taskId && i.status === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  return pending[0] ?? null;
}

/** Create and persist a new input. Returns the new Input. */
export function addInput(
  taskId: string,
  dir: string,
  data: Omit<Input, "id" | "taskId" | "status" | "createdAt" | "respondedAt">,
): Input {
  const taskDir = join(dir, taskId);
  ensureDir(taskDir);
  const store = loadStore(taskDir);
  const input: Input = {
    ...data,
    id: makeId(taskId, data.question, data.blockId),
    taskId,
    status: "pending",
    createdAt: new Date().toISOString(),
    respondedAt: null,
  };
  store.inputs.push(input);
  saveStore(taskDir, store);
  return input;
}

/**
 * Record a response to an input.
 * `response` — free-text value (for ask/input/confirm).
 * `optionId` — selected option id (for choice).
 */
export function respondInput(
  taskId: string,
  dir: string,
  inputId: string,
  response: { value?: string; optionId?: string },
): Input {
  const taskDir = join(dir, taskId);
  const store = loadStore(taskDir);
  const idx = store.inputs.findIndex((i) => i.id === inputId && i.taskId === taskId);
  if (idx === -1) throw new Error(`Input ${inputId} not found for task ${taskId}`);
  const input = store.inputs[idx];
  input.status = "responded";
  input.response = response.value ?? null;
  input.responseOptionId = response.optionId ?? null;
  input.respondedAt = new Date().toISOString();
  store.inputs[idx] = input;
  saveStore(taskDir, store);
  return input;
}

/** Cancel a pending input (mark it cancelled). */
export function cancelInput(taskId: string, dir: string, inputId: string): Input {
  const taskDir = join(dir, taskId);
  const store = loadStore(taskDir);
  const idx = store.inputs.findIndex((i) => i.id === inputId && i.taskId === taskId);
  if (idx === -1) throw new Error(`Input ${inputId} not found for task ${taskId}`);
  store.inputs[idx].status = "cancelled";
  saveStore(taskDir, store);
  return store.inputs[idx];
}
