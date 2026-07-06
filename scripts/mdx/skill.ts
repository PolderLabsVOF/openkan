export const SKILL_MDX = `---
title: "Agent skill + /organize slash command"
status: shipped
---

## Goal

Give agents two things to use openkan well:

1. **\`skills/openkan/SKILL.md\`** — a comprehensive guide (352 lines) that teaches agents when to use each tool, the MDX workflow, the \`<Preview>\` sandbox, waiting-for-input, comments, auto-tagging, archive, git attribution, and the changelog.
2. **\`.opencode/command/organize.md\`** — the \`/organize\` slash command that delegates to the agent for batch reorganization.

Both ship with the project and are deployed by \`install.sh\`:

- Skill → \`~/.config/opencode/skills/openkan/\`
- Slash command → \`~/.config/opencode/command/organize.md\`

## SKILL.md structure

1. What openkan is
2. When to reach for it (8 trigger phrases)
3. The 13 custom tools
4. The MDX artifact workflow
5. The \`<Preview>\` sandbox (no hooks, built-in library, \`respond()\`)
6. The waiting-for-input cycle
7. Comments (block-anchored, read with context)
8. Auto-tagging and categorization
9. The dashboard (tabs, settings, archive)
10. Working with teammates (git, contributors)
11. The changelog
12. Archiving
13. Organizing the board (the \`/organize\` command)
14. Patterns and anti-patterns
15. CLI reference

## \`/organize\` body

The slash command body instructs the agent to:

1. \`kanban_view\` (no filter)
2. Inspect each task
3. Re-derive category / priority / effort
4. Identify miscategorized, related, stale, vague tasks
5. Build a batch of \`kanban_organize\` operations
6. Apply via \`kanban_organize\`
7. Report a short summary

Don't touch tasks in \`In Progress\` or \`Review\` unless stale >14 days. Be conservative. The user can always undo.

## Example files

Four small example MDX files in \`skills/openkan/examples/\`:

- \`simple-task.mdx\` — basic task with title, description, single tag
- \`with-ask.mdx\` — uses \`<Ask>\` to request user input
- \`with-choice.mdx\` — uses \`<Choice>\` with options
- \`with-preview.mdx\` — uses \`<Preview>\` to show a TSX snippet

## Verification

\`\`\`sh
ls skills/openkan/
# → SKILL.md  examples/
ls skills/openkan/examples/
# → simple-task.mdx  with-ask.mdx  with-choice.mdx  with-preview.mdx
cat .opencode/command/organize.md | head -20
bash -n install.sh
\`\`\`
`;
