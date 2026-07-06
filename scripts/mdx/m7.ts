export const M7_MDX = `---
title: "M7: Tasks index, MDX-centric model, waiting-for-input state"
status: shipped
milestone: 7
---

## Goal

Make \`.openkan/\` an MDX-first workspace: every task has a rich, agent-writable MDX artifact, a tasks index, and a first-class **waiting-for-input** state so the agent can ask the user a structured question and block until the user answers.

## What was delivered

- **\`tasks.json\`** canonical index. Each entry: \`{ id, title, column, order, state, mdxPath, agent, model, createdAt, updatedAt, source? }\`.
- **Per-task directory** \`tasks/<id>/\` with \`task.mdx\`, \`comments.json\`, \`inputs.json\`, \`state.json\`.
- **\`Task.state\`** with new value \`waiting-for-input\`. The Kanban view shows the task in a "Needs you" state.
- **\`<Ask>\`, \`<Choice>\`, \`<Input>\`, \`<Confirm>\`** — inline MDX components. The agent writes them; the user answers in the UI; the task resumes.
- **\`kanban_ask\` tool** — agent creates a pending input. Idempotent.
- **Standalone CLI** (\`bin/openkan.ts\`) with subcommands: \`init\`, \`start\`, \`stop\`, \`status\`, \`open\`, \`config\`, \`logs\`, \`reset\`.
- **\`startOrAttach\`** with PID + HTTP probe + lock file (\`openSync(path, "wx")\`).

## Files touched

- \`kanban/board.ts\` — \`TaskState\`, \`TaskArtifacts\`, per-task dir migration
- \`kanban/mdx.ts\` — richer frontmatter
- \`kanban/inputs.ts\` (new) — Input CRUD
- \`kanban/comments.ts\` (new) — Comment CRUD
- \`kanban/mdx-render.ts\` (new) — server-side MDX → HTML with block markers
- \`kanban/tsx-sandbox.ts\` (new) — sucrase compile + iframe HTML
- \`kanban/io.ts\` (new) — \`writeFileAtomic\`, \`cleanupStaleTmp\`
- \`kanban/server.ts\` — \`startOrAttach\`, all new endpoints
- \`bin/openkan.ts\` (new) — CLI
- \`bin/openkan.mjs\` (new) — bin shim
- \`web/task-view.js\` (new) — task detail view
- \`web/mdx-viewer.js\` (new) — MDX viewer with click-to-comment
- \`web/preview-frame.html\` (new) — dev convenience

## Endpoints added

- \`GET /api/tasks-index\`
- \`GET /api/tasks/:id\` (with \`mdx\`, \`blocks\`, \`comments\`, \`inputs\`, \`renderedHtml\`, \`renderedBlocks\`)
- \`POST /api/tasks/:id/ask\` \`{ type, question, options?, blockId? }\`
- \`POST /api/tasks/:id/respond\` \`{ inputId, value?, optionId? }\`
- \`GET /api/tasks/:id/comments\`, \`POST …\`, \`DELETE …\`, \`PATCH …\` (resolve)
- \`GET /api/tasks/:id/mdx-rendered\`
- \`POST /api/preview\` \`{ tsx, props? }\`

## Tools added

- \`kanban_ask(taskId, type, question, options?, blockId?)\`
- \`kanban_respond(taskId)\`
- \`kanban_comments(taskId, includeResolved?)\`
- \`kanban_preview(tsx, props?)\`

## Verification

\`\`\`sh
node --test --experimental-strip-types tests/*.test.mts
# → 63 pass, 0 fail

# Smoke: start the server, create a task, ask a question, respond
node bin/openkan.mjs init
node bin/openkan.mjs start --no-open --port 7800
curl -X POST -H "Content-Type: application/json" \\
  -d '{"type":"choice","question":"Pick","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}' \\
  http://127.0.0.1:7800/api/tasks/<id>/ask
\`\`\`

See \`docs/milestones/M7.mdx\` for the full acceptance criteria.
`;
