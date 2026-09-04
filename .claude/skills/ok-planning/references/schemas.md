# Full schema reference — `ok` planning layer

This document expands the abridged schemas in `SKILL.md` with field-level
descriptions, validation rules, and worked examples.

All entities follow the same pattern:

```jsonc
{
  "schema": "ok.<entity>.v1",
  // ... entity-specific fields ...
}
```

The `schema` discriminator is the only identity you should rely on for
parsing. `ok doctor` checks it before any other validation.

---

## Task — `ok.task.v1`

An atomic unit of work. Atomicity is intentional: every task should be
representable in a single commit; multi-commit work is decomposed into
multiple tasks or promoted to a Plan.

```ts
{
  schema: "ok.task.v1",
  id: string,                  // "tsk-<nanoid-8>"
  title: string,               // 1..200 chars
  description?: string,        // optional markdown-lite
  owner?: string,              // agent/user; free-form
  status: "pending" | "in_progress" | "review" | "done" | "cancelled",
  priority?: "p0" | "p1" | "p2" | "p3",
  plan?: string,               // "pln-<id>"
  prd?: string,                // "prd-<id>"
  scopes?: string[],           // tags / paths / identifiers
  deps?: string[],             // task ids this depends on
  createdAt: string,           // ISO
  updatedAt: string,           // ISO
  startedAt?: string,          // ISO; set on first in_progress
  completedAt?: string,        // ISO; set on done/cancelled
  evidence?: string[],         // commit shas, file:line, URLs
  acceptance?: string[],       // definition-of-done bullets
}
```

### Status transitions

```
pending ──claim──▶ in_progress ──update──▶ review ──update──▶ done
   │                    │                      │                 
   └────cancel──────────┴──────────────────────┘                 
```

- `claim` transitions `pending → in_progress` and writes a lock.
- `update --status review` moves an in-progress task into review.
- `complete` is the only transition to `done`; it requires `--evidence`.
- `cancel` is terminal; it requires `--reason` (recorded as evidence).

The status enum is the canonical lifecycle indicator. Column placement
in OpenKan's UI is a presentation concern and is mapped back to `status`
on read.

### Example

```json
{
  "schema": "ok.task.v1",
  "id": "tsk-9brjCkWa",
  "title": "Implement claim helper",
  "description": "Cover happy path, expired lease, and double-claim.",
  "owner": "alice",
  "status": "in_progress",
  "priority": "p1",
  "plan": "pln-7Hg2Vu3W",
  "prd": "prd-T6g9Pz_X",
  "scopes": ["ok/lock.ts", "tests/ok-lock.test.mts"],
  "deps": [],
  "createdAt": "2026-09-04T10:00:00.000Z",
  "updatedAt": "2026-09-04T10:01:30.000Z",
  "startedAt": "2026-09-04T10:01:30.000Z",
  "acceptance": ["two test cases per branch", "no fcntl dependency"]
}
```

---

## Plan — `ok.plan.v1`

A medium-lived container for a cohesive set of tasks.

```ts
{
  schema: "ok.plan.v1",
  id: string,                   // "pln-<nanoid-8>"
  title: string,
  summary: string,              // 1-2 sentence elevator pitch
  prd?: string,                 // parent PRD id
  phase?: string,               // current phase label (free-form)
  status: "draft" | "active" | "blocked" | "complete" | "abandoned",
  tasks: string[],              // ordered task ids
  acceptance: string[],         // plan-level DoD
  createdAt: string,            // ISO
  updatedAt: string,            // ISO
}
```

### Status transitions

```
draft ──update──▶ active ──update──▶ complete
   │                │
   └─update─────────┴──update──▶ abandoned
   │
   └─update──▶ blocked ──update──▶ active
```

- `draft` is the only state in which a plan can be edited without
  justification (acceptance bullets, task list, phase label).
- `active` plans show up in `ok plan list` defaults.
- `complete` is terminal.

### Example

```json
{
  "schema": "ok.plan.v1",
  "id": "pln-7Hg2Vu3W",
  "title": "v0.1: schemas + storage",
  "summary": "Ship the .ok/ storage layer end-to-end.",
  "prd": "prd-T6g9Pz_X",
  "phase": "M2",
  "status": "active",
  "tasks": ["tsk-9brjCkWa", "tsk-AbCdEfGh", "tsk-IjKlMnOp"],
  "acceptance": ["all schemas validate", "tests green", "doctor returns 0 issues"],
  "createdAt": "2026-09-04T09:55:00.000Z",
  "updatedAt": "2026-09-04T10:01:30.000Z"
}
```

---

## PRD — `ok.prd.v1`

A long-horizon Product Requirements Document.

```ts
{
  schema: "ok.prd.v1",
  id: string,                   // "prd-<nanoid-8>"
  title: string,
  vision: string,               // one paragraph
  goals: PrdGoal[],             // see below
  nonGoals: string[],
  successMetrics: PrdSuccessMetric[],   // see below
  milestones: PrdMilestone[],           // see below
  risks: PrdRisk[],                     // see below
  plans: string[],              // plan ids that contribute
  owners: string[],             // agents/users
  reviewCadence?: string,       // "weekly", "monthly", etc.
  status: "draft" | "active" | "shipped" | "abandoned",
  createdAt: string,
  updatedAt: string,
  nextReviewAt?: string,        // ISO
}
```

### Sub-shapes

```ts
type PrdGoal = { id: string; text: string; status: "open" | "in_progress" | "met" | "dropped" };
type PrdSuccessMetric = { name: string; target: string; current?: string };
type PrdMilestone = { id: string; title: string; dueBy?: string; status: "open" | "hit" | "missed" | "dropped" };
type PrdRisk = { id: string; text: string; severity: "low" | "med" | "high"; mitigation?: string };
```

### Goal / milestone ids

Goal ids default to `g1`, `g2`, … in creation order. Milestone ids
default to `m1`, `m2`, …. Risk ids are auto-assigned by `ok doctor` if
you write the file by hand.

### Example

```json
{
  "schema": "ok.prd.v1",
  "id": "prd-T6g9Pz_X",
  "title": "Self-contained planning workspace",
  "vision": "Every project ships with .ok/ for tasks, plans, and PRDs.",
  "goals": [
    { "id": "g1", "text": "ship CLI", "status": "met" },
    { "id": "g2", "text": "ship skill", "status": "open" },
    { "id": "g3", "text": "ship auto-init", "status": "open" }
  ],
  "nonGoals": ["Windows support", "TUI"],
  "successMetrics": [
    { "name": "active planning workspaces", "target": "20", "current": "0" },
    { "name": "p50 session bootstrap", "target": "< 200ms", "current": "n/a" }
  ],
  "milestones": [
    { "id": "m1", "title": "v0.1 schema", "dueBy": "2026-10-01T00:00:00Z", "status": "open" },
    { "id": "m2", "title": "v1.0 launch", "dueBy": "2026-12-15T00:00:00Z", "status": "open" }
  ],
  "risks": [
    { "id": "r1", "text": "agent role confusion", "severity": "med", "mitigation": "skill body disambiguates triggers" }
  ],
  "plans": ["pln-7Hg2Vu3W"],
  "owners": ["karen", "todd"],
  "reviewCadence": "weekly",
  "status": "active",
  "createdAt": "2026-09-04T09:00:00.000Z",
  "updatedAt": "2026-09-04T10:00:00.000Z",
  "nextReviewAt": "2026-09-11T09:00:00Z"
}
```

---

## Config — `ok.config.v1`

Workspace metadata. One per project. Never carries entity data.

```ts
{
  schema: "ok.config.v1",
  version: 1,
  defaultOwner?: string,
  createdAt: string,
  updatedAt: string,
}
```

`defaultOwner` is applied to new tasks that omit `--owner`. Useful for
single-operator projects.

---

## Index — `ok.index.v1`

A compact pointer file for fast listings. Rebuilt via `ok index`.

```ts
{
  schema: "ok.index.v1",
  tasks: IndexEntry[],          // {id, status, title, updatedAt}
  plans: IndexEntry[],
  prds: IndexEntry[],
  updatedAt: string,
}
```

Each entry is sorted by `updatedAt` descending. Agents that just want
"what is open?" can read this file and skip the per-task JSONs.

---

## Validation rules summary

- All ids must match their kind's regex (`tsk-…`, `pln-…`, `prd-…`).
- `title` on a Task must be 1..200 chars.
- Status enums are exact-match; arbitrary strings are rejected.
- `createdAt` / `updatedAt` must be ISO timestamps (`Date.parse` works).
- Array fields must be string arrays when present.
- Unknown fields are ignored (forward-compat); missing required fields
  are rejected.

If you write the file by hand and want validation feedback, run
`ok doctor` after writing.
