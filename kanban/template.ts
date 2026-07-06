// OpenKan — canonical task MDX template + helpers.

import type { Priority, Category } from "./tags.ts";

// ─── Template ────────────────────────────────────────────────────────────────

/**
 * The canonical task MDX template.
 * Agents fill this in when creating a new task via kanban_add without a description.
 *
 * The template uses placeholder comments so agents can detect
 * unfilled sections via extractTemplate().
 */
export const TASK_MDX_TEMPLATE = `---
title: {/* Task title — replace with a short, descriptive name */}
column: todo
order: 0
state: idle
status: idle
agent: {/* opencode agent name, e.g. "build" */}
model: {/* provider/model, e.g. "opencode/default" */}
createdAt: {/* ISO timestamp */}
updatedAt: {/* ISO timestamp */}
tags: []
category: task
priority: normal
effort: null
archived: false
---

# {/\* Task title \*/}

{/* Add the task title above, then fill in the sections below. */}

## Goal

{/* What does "done" look like? Describe the end state in 1-3 sentences.
    Example: "Users can reset their password via a secure email link." */}

## Context

{/* Add background context, links to relevant issues/files, and why this task exists.
    Example: "Related to #42 — the current reset flow has no rate limiting." */}

## Acceptance criteria

{/* Replace this checklist with concrete, testable conditions. */}
- [ ] {/* Criterion 1 */}
- [ ] {/* Criterion 2 */}
- [ ] {/* Criterion 3 */}

## Files to touch

{/* List specific files/functions/UI components to change. */}
{/* Example: src/auth/reset-password.ts, web/components/PasswordReset.tsx */}

## Safety

{/* Any non-functional requirements: performance, security, backwards compat, rollback plan. */}
{/* Example: "Database migration must be reversible. Rate-limit to 5 attempts per IP." */}

## Agent progress

{/* Agents append timestamped one-liners here as they work.
    Format: "- [YYYY-MM-DD HH:MM:SS] <tool or action description>" */}

## MDX components

{/* Available interactive components — embed in the task MDX when needed: */}

{/* <Ask question="Your question here" /> */}
{/* <Choice question="Pick one:" options={[{id:"a",label:"Option A"},{id:"b",label:"Option B"}]} /> */}
{/* <Input label="Enter value" placeholder="e.g. foo" /> */}
{/* <Confirm question="Proceed?" /> */}
{/* <Preview tsx="<button>Click me</button>" /> */}
`;

/**
 * Render the task template with field values filled in.
 * Fields not provided retain their placeholder comments.
 */
export function renderTaskTemplate(fields: {
  title: string;
  goal?: string;
  context?: string;
  acceptance?: string[];
  safety?: string[];
  tags?: string[];
}): string {
  const {
    title,
    goal = "{/* Describe the goal of this task */}",
    context = "{/* Add context: why this task exists, links, background */}",
    acceptance = ["{/* Acceptance criterion */}"],
    safety = [],
    tags = [],
  } = fields;

  const acceptanceLines = acceptance
    .map(c => (c.startsWith("- [ ]") ? c : `- [ ] ${c}`))
    .join("\n");

  const safetyLines = safety.length > 0
    ? safety.map(s => (s.startsWith("-") ? s : `- ${s}`)).join("\n")
    : "{/* Safety considerations (optional) */}";

  return `---
title: ${title}
column: todo
order: 0
state: idle
status: idle
agent:
model:
createdAt: ${new Date().toISOString()}
updatedAt: ${new Date().toISOString()}
tags: [${tags.map(t => `"${t}"`).join(", ")}]
category: task
priority: normal
effort: null
archived: false
---

# ${title}

## Goal

${goal}

## Context

${context}

## Acceptance criteria

${acceptanceLines}

## Files to touch

{/* List files to change */}

## Safety

${safetyLines}

## Agent progress

{/* Agents append progress notes here */}
`;
}

// ─── Placeholder detection ──────────────────────────────────────────────────

/**
 * Returns true if the MDX still contains unfilled placeholder comments.
 * Used by kanban_add to detect "empty template" state.
 */
export function extractTemplate(mdx: string): boolean {
  return /\{\/\*.*?\*\/\}/s.test(mdx);
}

// ─── Parse hints (for frontend help panel) ─────────────────────────────────

/** Hints shown in the frontend template help panel. */
export const TEMPLATE_PARSE_HINTS: string[] = [
  "<Ask> — Ask the user a single structured question; blocks until answered",
  "<Choice> — Present radio options; user picks one",
  "<Input> — Free-form text input from the user",
  "<Confirm> — Yes/no confirmation from the user",
  "<Preview> — Inline interactive TSX preview (live in the browser)",
];
