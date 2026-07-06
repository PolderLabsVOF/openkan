export const DOCS_MDX = `---
title: "Documentation overhaul (M7–M11 milestones, README, CHANGELOG, skill)"
status: shipped
---

## Goal

Update every doc to reflect the M7–M11 implementation. The user-visible docs had to match the shipped code.

## What was updated

### New milestone docs

- \`docs/milestones/M7.mdx\` — tasks index, MDX-centric model, waiting-for-input state, CLI
- \`docs/milestones/M8.mdx\` — inline comments on rendered MDX
- \`docs/milestones/M9.mdx\` — TSX/JSX preview components in MDX
- \`docs/milestones/M10.mdx\` — dashboard tabs, full changelog, git attribution, archive, settings
- \`docs/milestones/M11.mdx\` — \`/organize\` slash command, auto-progress, sort/filter polish

### Updated docs

- \`docs/README.mdx\` — roadmap table; M0–M1 shipped, M2–M6 pending, M7–M9 shipped, M10 next, M11 pending
- \`README.md\` — feature list, custom tools table, project layout, custom OpenCode tools, configuration
- \`CHANGELOG.md\` — 0.2.0 entries (M7–M9, M10, M11)
- \`examples/sample-kanban-project/AGENTS.md\` — updated for the new tools
- ID format sync: \`tsk_\` → \`tsk-\` across all docs and tools

### Created

- \`skills/openkan/SKILL.md\` (352 lines)
- \`skills/openkan/examples/{simple-task,with-ask,with-choice,with-preview}.mdx\`
- \`.opencode/command/organize.md\`

## Forseti review notes

The plan was routed through Forseti (adversarial review) before implementation. It caught 15 issues including:

- The biggest correctness bug: UUID-per-render block IDs would have silently detached every comment on every re-render. Replaced with content-hash IDs.
- Cross-process server ownership race: PID file alone wasn't enough. Added lock file with \`openSync(path, "wx")\`.
- \`esbuild-wasm\` would have added a 10MB download on first preview. Replaced with synchronous \`sucrase\`.
- Per-task dirs as the only layout, migrated at \`initBoard\`, not lazily on read.
- Splitting \`web/app.js\` into \`app.js\` / \`task-view.js\` / \`mdx-viewer.js\` / \`api.js\`.
- \`.gitignore\` whitelist for \`.openkan/tasks/\` (git-trackable tasks, ignore sessions).
- \`install.sh\` PATH symlink.
- Node 22 \`node --test\` runner, no extra deps.
- ID format \`tsk-\` everywhere.

## Verification

\`\`\`sh
grep -rn "tsk_" bin/ docs/ examples/ plugins/ README.md
# (empty — all references are tsk-)
\`\`\`
`;
