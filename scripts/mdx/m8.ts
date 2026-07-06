export const M8_MDX = `---
title: "M8: Inline comments on rendered MDX"
status: shipped
milestone: 8
---

## Goal

A user viewing a task's MDX artifact can click anywhere on a rendered block (paragraph, heading, list, code, etc.) and leave a comment. Comments are anchored to the exact block so the agent reading the MDX (or the comments file) can see **what** the user was commenting on.

## Why content-hash block IDs

Comments are anchored to a **content-hash block ID** (sibling-index + sha1 of normalized text), not a fresh UUID per render. This is the most important correctness property of M8 — without it, comments would silently detach on every edit.

\`\`\`ts
function blockIdFor(blockText: string, siblingIndex: number): string {
  const norm = blockText.replace(/\\s+/g, " ").trim().slice(0, 80);
  return \`blk-\${sha1(\\\`\${siblingIndex}|\${norm}\\\`).slice(0, 12)}\`;
}
\`\`\`

The same block content in the same sibling position maps to the same id across line insertions above and below.

## What was delivered

- \`kanban/mdx-render.ts\` wraps every top-level block in \`<section class="mdx-block" data-block-id="…" data-line="…">\`.
- \`kanban/comments.ts\` CRUD with stable IDs (\`cmt-xxxxxxxx\`).
- Click any block in the MDX viewer → inline composer pre-targeted at that block.
- Comments panel with: author, text, line number, block excerpt.
- Agent reads via \`kanban_comments(taskId)\` with \`{blockId, line, text, author, createdAt, excerpt}\`.

## Files touched

- \`kanban/mdx-render.ts\` — \`data-block-id\` + \`data-line\` on every block
- \`kanban/comments.ts\` (new) — list/add/delete/resolve
- \`kanban/server.ts\` — comment endpoints
- \`web/mdx-viewer.js\` — click-to-comment, comments panel
- \`web/style.css\` — block highlight, comment markers, panel layout

## Verification

\`\`\`sh
node --test --experimental-strip-types tests/*.test.mts
# mdx-render tests: blockIdFor is stable across line insertion
\`\`\`

See \`docs/milestones/M8.mdx\` for acceptance criteria.
`;
