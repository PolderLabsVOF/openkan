// ok/schemas.ts — TypeScript types and validators for every planning entity.
//
// The single source of truth lives in JSDoc-typed TypeScript interfaces and
// is materialised to JSON via the standalone `validate*` helpers below.
// `ok doctor` runs every persisted JSON through these helpers and reports
// the first offending path; consumers that already trust the data should
// still treat the helpers as the contract.

import { idSuffix, isoCompare, nowIso } from "./ids.ts";

// ─── Task ───────────────────────────────────────────────────────────────────

/**
 * A Task is the atomic unit of work. Atomicity is intentional: every
 * Task should be representable in a single commit; multi-commit work
 * is decomposed into multiple Tasks or promoted to a Plan.
 *
 * Lifecycle:  pending → in_progress → review → done
 *                       ↘ cancelled
 *
 * The status transitions are advisory; `ok doctor` does not enforce a
 * DAG. The lock protocol (`ok/lock.ts`) ensures the *write side* is
 * serialised.
 */
export type TaskStatus = "pending" | "in_progress" | "review" | "done" | "cancelled";

export type TaskPriority = "p0" | "p1" | "p2" | "p3";

export interface Task {
  schema: "ok.task.v1";
  /** Stable identifier; `<kind>-<nanoid>` e.g. `tsk-Vn4kRp2x`. */
  id: string;
  /** One-line description, max 200 chars. */
  title: string;
  /** Longer-form rationale, optional. Markdown-lite. */
  description?: string;
  /** Agent or user that owns this task. Free-form; not authenticated. */
  owner?: string;
  /** Lifecycle status. See `TaskStatus`. */
  status: TaskStatus;
  /** Coarse-grained severity (p0 = drop everything). */
  priority?: TaskPriority;
  /** Plan this task contributes to. */
  plan?: string;
  /** Long-horizon PRD this task rolls up to. */
  prd?: string;
  /** Tags/paths/identifiers this task touches. Free-form. */
  scopes?: string[];
  /** Task ids that must complete before this one can start. */
  deps?: string[];
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp; bumped on every write. */
  updatedAt: string;
  /** Set when status first moves to in_progress. */
  startedAt?: string;
  /** Set when status moves to done or cancelled. */
  completedAt?: string;
  /** Free-form evidence: commit shas, file:line refs, URLs. */
  evidence?: string[];
  /** Acceptance criteria bullets (the Definition of Done). */
  acceptance?: string[];
}

export function isTask(obj: unknown): obj is Task {
  if (typeof obj !== "object" || obj === null) return false;
  const t = obj as Record<string, unknown>;
  if (t.schema !== "ok.task.v1") return false;
  if (typeof t.id !== "string" || !/^tsk-[A-Za-z0-9_-]+$/.test(t.id)) return false;
  if (typeof t.title !== "string" || t.title.length === 0 || t.title.length > 200) return false;
  const statuses: TaskStatus[] = ["pending", "in_progress", "review", "done", "cancelled"];
  if (typeof t.status !== "string" || !statuses.includes(t.status as TaskStatus)) return false;
  if (!isIso(t.createdAt) || !isIso(t.updatedAt)) return false;
  if (t.startedAt !== undefined && !isIso(t.startedAt)) return false;
  if (t.completedAt !== undefined && !isIso(t.completedAt)) return false;
  if (t.priority !== undefined && !["p0", "p1", "p2", "p3"].includes(t.priority as string)) return false;
  if (t.description !== undefined && typeof t.description !== "string") return false;
  if (t.owner !== undefined && typeof t.owner !== "string") return false;
  if (t.plan !== undefined && (typeof t.plan !== "string" || !/^pln-/.test(t.plan))) return false;
  if (t.prd !== undefined && (typeof t.prd !== "string" || !/^prd-/.test(t.prd))) return false;
  if (t.scopes !== undefined && !isStringArray(t.scopes)) return false;
  if (t.deps !== undefined && !isStringArray(t.deps)) return false;
  if (t.evidence !== undefined && !isStringArray(t.evidence)) return false;
  if (t.acceptance !== undefined && !isStringArray(t.acceptance)) return false;
  return true;
}

export interface TaskValidationError {
  id?: string;
  reason: string;
}

export function validateTask(obj: unknown): TaskValidationError | null {
  if (typeof obj !== "object" || obj === null) {
    return { reason: "task must be an object" };
  }
  const t = obj as Record<string, unknown>;
  if (t.schema !== "ok.task.v1") return { reason: `unknown schema ${String(t.schema)}` };
  if (typeof t.id !== "string" || !/^tsk-[A-Za-z0-9_-]+$/.test(t.id)) {
    return { id: typeof t.id === "string" ? t.id : undefined, reason: "id must match tsk-<id>" };
  }
  if (typeof t.title !== "string") return { id: t.id, reason: "title must be a string" };
  if (t.title.length === 0 || t.title.length > 200) {
    return { id: t.id, reason: "title must be 1..200 chars" };
  }
  const statuses: TaskStatus[] = ["pending", "in_progress", "review", "done", "cancelled"];
  if (typeof t.status !== "string" || !statuses.includes(t.status as TaskStatus)) {
    return { id: t.id, reason: `status must be one of ${statuses.join("|")}` };
  }
  if (!isIso(t.createdAt)) return { id: t.id, reason: "createdAt must be ISO timestamp" };
  if (!isIso(t.updatedAt)) return { id: t.id, reason: "updatedAt must be ISO timestamp" };
  if (t.startedAt !== undefined && !isIso(t.startedAt)) {
    return { id: t.id, reason: "startedAt must be ISO timestamp when present" };
  }
  if (t.completedAt !== undefined && !isIso(t.completedAt)) {
    return { id: t.id, reason: "completedAt must be ISO timestamp when present" };
  }
  if (t.priority !== undefined && !["p0", "p1", "p2", "p3"].includes(t.priority as string)) {
    return { id: t.id, reason: "priority must be p0|p1|p2|p3 when present" };
  }
  if (t.scopes !== undefined && !isStringArray(t.scopes)) {
    return { id: t.id, reason: "scopes must be string[] when present" };
  }
  if (t.deps !== undefined && !isStringArray(t.deps)) {
    return { id: t.id, reason: "deps must be string[] when present" };
  }
  if (t.evidence !== undefined && !isStringArray(t.evidence)) {
    return { id: t.id, reason: "evidence must be string[] when present" };
  }
  if (t.acceptance !== undefined && !isStringArray(t.acceptance)) {
    return { id: t.id, reason: "acceptance must be string[] when present" };
  }
  if (t.plan !== undefined && (typeof t.plan !== "string" || !/^pln-/.test(t.plan))) {
    return { id: t.id, reason: "plan must be a pln-<id> string when present" };
  }
  if (t.prd !== undefined && (typeof t.prd !== "string" || !/^prd-/.test(t.prd))) {
    return { id: t.id, reason: "prd must be a prd-<id> string when present" };
  }
  return null;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

/**
 * A Plan is a medium-lived container for a cohesive set of Tasks working
 * toward one outcome. Plans typically span 1–20 tasks and finish in days
 * to a few weeks. Plans roll up to a PRD (`prd`); orphaned plans (no
 * PRD) are allowed when the work does not yet map to a north-star goal.
 */
export type PlanStatus = "draft" | "active" | "blocked" | "complete" | "abandoned";

export interface Plan {
  schema: "ok.plan.v1";
  id: string;
  title: string;
  summary: string;
  prd?: string;
  phase?: string;
  status: PlanStatus;
  /** Ordered task ids (the canonical order). */
  tasks: string[];
  /** Plan-level Definition of Done. */
  acceptance: string[];
  createdAt: string;
  updatedAt: string;
}

export function isPlan(obj: unknown): obj is Plan {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj as Record<string, unknown>;
  if (p.schema !== "ok.plan.v1") return false;
  if (typeof p.id !== "string" || !/^pln-[A-Za-z0-9_-]+$/.test(p.id)) return false;
  if (typeof p.title !== "string" || p.title.length === 0) return false;
  if (typeof p.summary !== "string") return false;
  const statuses: PlanStatus[] = ["draft", "active", "blocked", "complete", "abandoned"];
  if (typeof p.status !== "string" || !statuses.includes(p.status as PlanStatus)) return false;
  if (!Array.isArray(p.tasks) || !p.tasks.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(p.acceptance) || !p.acceptance.every((x) => typeof x === "string")) return false;
  if (!isIso(p.createdAt) || !isIso(p.updatedAt)) return false;
  if (p.prd !== undefined && (typeof p.prd !== "string" || !/^prd-/.test(p.prd))) return false;
  if (p.phase !== undefined && typeof p.phase !== "string") return false;
  return true;
}

export function validatePlan(obj: unknown): TaskValidationError | null {
  if (typeof obj !== "object" || obj === null) return { reason: "plan must be an object" };
  const p = obj as Record<string, unknown>;
  if (p.schema !== "ok.plan.v1") return { reason: `unknown schema ${String(p.schema)}` };
  if (typeof p.id !== "string" || !/^pln-[A-Za-z0-9_-]+$/.test(p.id)) {
    return { id: typeof p.id === "string" ? p.id : undefined, reason: "id must match pln-<id>" };
  }
  if (typeof p.title !== "string" || p.title.length === 0) {
    return { id: typeof p.id === "string" ? p.id : undefined, reason: "title required" };
  }
  if (typeof p.summary !== "string") {
    return { id: p.id as string, reason: "summary required" };
  }
  const statuses: PlanStatus[] = ["draft", "active", "blocked", "complete", "abandoned"];
  if (typeof p.status !== "string" || !statuses.includes(p.status as PlanStatus)) {
    return { id: p.id as string, reason: `status must be one of ${statuses.join("|")}` };
  }
  if (!Array.isArray(p.tasks) || !p.tasks.every((x) => typeof x === "string")) {
    return { id: p.id as string, reason: "tasks must be string[]" };
  }
  if (!Array.isArray(p.acceptance) || !p.acceptance.every((x) => typeof x === "string")) {
    return { id: p.id as string, reason: "acceptance must be string[]" };
  }
  if (!isIso(p.createdAt)) return { id: p.id as string, reason: "createdAt must be ISO" };
  if (!isIso(p.updatedAt)) return { id: p.id as string, reason: "updatedAt must be ISO" };
  return null;
}

// ─── PRD ────────────────────────────────────────────────────────────────────

/**
 * A PRD (Product Requirements Document) is the long-horizon container.
 * PRDs span weeks to months and survive across multiple Plans. They
 * capture goals (what we want), non-goals (what we are not doing),
 * success metrics (how we measure), milestones (when), and risks
 * (what could derail us).
 */
export type PrdStatus = "draft" | "active" | "shipped" | "abandoned";

export interface PrdGoal {
  id: string;
  text: string;
  status: "open" | "in_progress" | "met" | "dropped";
}

export interface PrdSuccessMetric {
  name: string;
  target: string;
  current?: string;
}

export interface PrdMilestone {
  id: string;
  title: string;
  dueBy?: string;
  status: "open" | "hit" | "missed" | "dropped";
}

export interface PrdRisk {
  id: string;
  text: string;
  severity: "low" | "med" | "high";
  mitigation?: string;
}

export interface Prd {
  schema: "ok.prd.v1";
  id: string;
  title: string;
  vision: string;
  goals: PrdGoal[];
  nonGoals: string[];
  successMetrics: PrdSuccessMetric[];
  milestones: PrdMilestone[];
  risks: PrdRisk[];
  plans: string[];
  owners: string[];
  reviewCadence?: string;
  status: PrdStatus;
  createdAt: string;
  updatedAt: string;
  nextReviewAt?: string;
}

export function isPrd(obj: unknown): obj is Prd {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj as Record<string, unknown>;
  if (p.schema !== "ok.prd.v1") return false;
  if (typeof p.id !== "string" || !/^prd-[A-Za-z0-9_-]+$/.test(p.id)) return false;
  if (typeof p.title !== "string" || p.title.length === 0) return false;
  if (typeof p.vision !== "string") return false;
  const statuses: PrdStatus[] = ["draft", "active", "shipped", "abandoned"];
  if (typeof p.status !== "string" || !statuses.includes(p.status as PrdStatus)) return false;
  if (!isIso(p.createdAt) || !isIso(p.updatedAt)) return false;
  if (!Array.isArray(p.goals) || !p.goals.every(isGoal)) return false;
  if (!Array.isArray(p.nonGoals) || !p.nonGoals.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(p.successMetrics) || !p.successMetrics.every(isMetric)) return false;
  if (!Array.isArray(p.milestones) || !p.milestones.every(isMilestone)) return false;
  if (!Array.isArray(p.risks) || !p.risks.every(isRisk)) return false;
  if (!Array.isArray(p.plans) || !p.plans.every((x) => typeof x === "string" && /^pln-/.test(x))) return false;
  if (!Array.isArray(p.owners) || !p.owners.every((x) => typeof x === "string")) return false;
  if (p.reviewCadence !== undefined && typeof p.reviewCadence !== "string") return false;
  if (p.nextReviewAt !== undefined && !isIso(p.nextReviewAt)) return false;
  return true;
}

export function validatePrd(obj: unknown): TaskValidationError | null {
  if (typeof obj !== "object" || obj === null) return { reason: "prd must be an object" };
  const p = obj as Record<string, unknown>;
  if (p.schema !== "ok.prd.v1") return { reason: `unknown schema ${String(p.schema)}` };
  if (typeof p.id !== "string" || !/^prd-[A-Za-z0-9_-]+$/.test(p.id)) {
    return { id: typeof p.id === "string" ? p.id : undefined, reason: "id must match prd-<id>" };
  }
  if (typeof p.title !== "string" || p.title.length === 0) {
    return { id: p.id as string, reason: "title required" };
  }
  if (typeof p.vision !== "string") {
    return { id: p.id as string, reason: "vision required" };
  }
  const statuses: PrdStatus[] = ["draft", "active", "shipped", "abandoned"];
  if (typeof p.status !== "string" || !statuses.includes(p.status as PrdStatus)) {
    return { id: p.id as string, reason: `status must be one of ${statuses.join("|")}` };
  }
  if (!Array.isArray(p.goals) || !p.goals.every(isGoal)) {
    return { id: p.id as string, reason: "goals must be well-formed" };
  }
  if (!Array.isArray(p.nonGoals) || !p.nonGoals.every((x) => typeof x === "string")) {
    return { id: p.id as string, reason: "nonGoals must be string[]" };
  }
  if (!Array.isArray(p.successMetrics) || !p.successMetrics.every(isMetric)) {
    return { id: p.id as string, reason: "successMetrics must be well-formed" };
  }
  if (!Array.isArray(p.milestones) || !p.milestones.every(isMilestone)) {
    return { id: p.id as string, reason: "milestones must be well-formed" };
  }
  if (!Array.isArray(p.risks) || !p.risks.every(isRisk)) {
    return { id: p.id as string, reason: "risks must be well-formed" };
  }
  if (!Array.isArray(p.plans) || !p.plans.every((x) => typeof x === "string" && /^pln-/.test(x))) {
    return { id: p.id as string, reason: "plans must be pln-<id> strings" };
  }
  if (!Array.isArray(p.owners) || !p.owners.every((x) => typeof x === "string")) {
    return { id: p.id as string, reason: "owners must be string[]" };
  }
  if (!isIso(p.createdAt)) return { id: p.id as string, reason: "createdAt must be ISO" };
  if (!isIso(p.updatedAt)) return { id: p.id as string, reason: "updatedAt must be ISO" };
  return null;
}

function isGoal(g: unknown): boolean {
  if (typeof g !== "object" || g === null) return false;
  const o = g as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.text !== "string") return false;
  return ["open", "in_progress", "met", "dropped"].includes(o.status as string);
}

function isMetric(m: unknown): boolean {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.target === "string"
    && (o.current === undefined || typeof o.current === "string");
}

function isMilestone(m: unknown): boolean {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string") return false;
  return ["open", "hit", "missed", "dropped"].includes(o.status as string)
    && (o.dueBy === undefined || isIso(o.dueBy));
}

function isRisk(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.text !== "string") return false;
  return ["low", "med", "high"].includes(o.severity as string)
    && (o.mitigation === undefined || typeof o.mitigation === "string");
}

// ─── Config / Index ─────────────────────────────────────────────────────────

/**
 * Workspace metadata. There is exactly one `config.json` per project and
 * it never holds entity data — only environment-level defaults.
 */
export interface OkConfig {
  schema: "ok.config.v1";
  version: 1;
  defaultOwner?: string;
  createdAt: string;
  updatedAt: string;
}

export function isOkConfig(obj: unknown): obj is OkConfig {
  if (typeof obj !== "object" || obj === null) return false;
  const c = obj as Record<string, unknown>;
  if (c.schema !== "ok.config.v1") return false;
  if (c.version !== 1) return false;
  if (!isIso(c.createdAt) || !isIso(c.updatedAt)) return false;
  if (c.defaultOwner !== undefined && typeof c.defaultOwner !== "string") return false;
  return true;
}

/**
 * Compact listing of every entity's id, status, title, and updated-at.
 * Rebuilt on demand via `ok index`; used by skill launchers that need to
 * orient quickly without scanning JSON files one by one.
 */
export interface IndexEntry {
  id: string;
  status: string;
  title: string;
  updatedAt: string;
}

export interface OkIndex {
  schema: "ok.index.v1";
  tasks: IndexEntry[];
  plans: IndexEntry[];
  prds: IndexEntry[];
  updatedAt: string;
}

export function isOkIndex(obj: unknown): obj is OkIndex {
  if (typeof obj !== "object" || obj === null) return false;
  const i = obj as Record<string, unknown>;
  if (i.schema !== "ok.index.v1") return false;
  if (!Array.isArray(i.tasks) || !Array.isArray(i.plans) || !Array.isArray(i.prds)) return false;
  if (!isIso(i.updatedAt)) return false;
  for (const arr of [i.tasks, i.plans, i.prds] as unknown[][]) {
    for (const e of arr) {
      if (!e || typeof e !== "object") return false;
      const o = e as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.status !== "string" ||
          typeof o.title !== "string" || typeof o.updatedAt !== "string") {
        return false;
      }
    }
  }
  return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isIso(v: unknown): boolean {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** Bump `updatedAt` to now. Returns a new object. */
export function touch<T extends { updatedAt: string }>(entity: T): T {
  return { ...entity, updatedAt: nowIso() };
}

/** Stable sort by `updatedAt` descending. Returns a new array. */
export function byUpdatedDesc<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => isoCompare(b.updatedAt, a.updatedAt));
}

// ─── Agent profiles ──────────────────────────────────────────────────────────

export type AgentKind = "claude-code" | "codex-cli" | "cursor" | "cline" | "custom";

export interface AgentProfile {
  schema: "openkan.agent-profile.v1";
  /** Unique identifier for this profile, e.g. "claude-code", "codex-cli". */
  id: string;
  /** Discriminator matching the agent runtimes this profile targets. */
  kind: AgentKind;
  /** Path or command to the agent binary. Required; must be non-empty. */
  bin: string;
  /** Optional description shown in the UI. */
  description?: string;
  /** Arbitrary extra fields; engines may add their own keys. */
  meta?: Record<string, unknown>;
}

export interface AgentsConfig {
  schema: "openkan.agents.v1";
  /** The currently active profile id. */
  active: string;
  /** All registered profiles. */
  profiles: AgentProfile[];
}

export function isAgentProfile(v: unknown): v is AgentProfile {
  return (
    typeof v === "object" && v !== null &&
    (v as AgentProfile).schema === "openkan.agent-profile.v1"
  );
}

export function isAgentsConfig(v: unknown): v is AgentsConfig {
  return (
    typeof v === "object" && v !== null &&
    (v as AgentsConfig).schema === "openkan.agents.v1"
  );
}

const VALID_KINDS = new Set<AgentKind>(["claude-code", "codex-cli", "cursor", "cline", "custom"]);

export interface AgentProfileValidationError {
  path: string;
  reason: string;
}

/**
 * Validate a single AgentProfile.
 * Returns null on success, or the first error found.
 */
export function validateAgentProfile(obj: unknown): AgentProfileValidationError | null {
  if (typeof obj !== "object" || obj === null) {
    return { path: "", reason: "expected object" };
  }
  const o = obj as Record<string, unknown>;

  if (typeof o["id"] !== "string" || !o["id"]) {
    return { path: "id", reason: "required, non-empty string" };
  }
  if (!o["kind"] || !VALID_KINDS.has(o["kind"] as AgentKind)) {
    return { path: "kind", reason: `required, must be one of: ${[...VALID_KINDS].join(", ")}` };
  }
  if (typeof o["bin"] !== "string" || !o["bin"].trim()) {
    return { path: "bin", reason: "required, non-empty string" };
  }
  if (o["description"] !== undefined && typeof o["description"] !== "string") {
    return { path: "description", reason: "optional, must be string" };
  }
  if (o["meta"] !== undefined && (typeof o["meta"] !== "object" || o["meta"] === null || Array.isArray(o["meta"]))) {
    return { path: "meta", reason: "optional, must be object" };
  }
  return null;
}

/**
 * Validate an AgentsConfig object.
 * Returns null on success, or the first error found.
 */
export function validateAgentsConfig(obj: unknown): AgentProfileValidationError | null {
  if (typeof obj !== "object" || obj === null) {
    return { path: "", reason: "expected object" };
  }
  const o = obj as Record<string, unknown>;

  if (typeof o["active"] !== "string" || !o["active"]) {
    return { path: "active", reason: "required, non-empty string" };
  }
  if (!Array.isArray(o["profiles"])) {
    return { path: "profiles", reason: "required, must be array" };
  }
  for (let i = 0; i < (o["profiles"] as unknown[]).length; i++) {
    const err = validateAgentProfile((o["profiles"] as unknown[])[i]);
    if (err) {
      err.path = `profiles[${i}].${err.path}`;
      return err;
    }
  }
  return null;
}

/** Default agent profile registered when no profiles exist yet. */
export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  schema: "openkan.agent-profile.v1",
  id: "claude-code",
  kind: "claude-code",
  bin: "claude",
  description: "Default Claude Code agent profile",
};

/** Default agents config used when none exists. */
export const DEFAULT_AGENTS_CONFIG: AgentsConfig = {
  schema: "openkan.agents.v1",
  active: "claude-code",
  profiles: [DEFAULT_AGENT_PROFILE],
};

/** Strip the id prefix from each id-suffix in the array, for logging. */
export function suffixList<T extends { id: string }>(items: T[]): string[] {
  return items.map((i) => idSuffix(i.id) ?? i.id);
}
