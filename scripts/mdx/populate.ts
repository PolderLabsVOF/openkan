export const POPULATE_MDX = `---
title: "Populate the openkan board with project history"
status: in_progress
---

## Goal

After shipping M7–M11, replace the seed test data with real tasks that document the work done. Each task gets a full MDX file with goal, what was delivered, files touched, verification, and links to the milestone docs.

## What this task documents

The act of populating the board is itself a task — visible in the **In Progress** column right now, demonstrating the live workflow. When this task moves to **Done**, the project history is fully reflected in openkan.

## Tasks created

| ID | Title | Column |
|---|---|---|
| \`m7kx9p2a\` | M7 — Tasks index, MDX-centric model, waiting-for-input state | Done |
| \`m8b7q3tw\` | M8 — Inline comments on rendered MDX | Done |
| \`m9zr4n8c\` | M9 — TSX/JSX preview components in MDX | Done |
| \`m10hx7k5\` | M10 — Dashboard tabs, changelog, git attribution, archive, settings | Done |
| \`m11vr2jp\` | M11 — /organize command, auto-progress, sort/filter | Done |
| \`tag5nm9q\` | Auto-tagging and categorization system | Done |
| \`tst9mq4r\` | Test infrastructure (0 → 114 tests) | Done |
| \`doc8wp3f\` | Documentation overhaul | Done |
| \`bug3kx7p\` | Server and CLI bug fixes | Review |
| \`skl7rn2v\` | Agent skill + /organize slash command | Review |
| \`pop4cn6x\` | **This task** | In Progress |

## Verification

\`\`\`sh
curl -s http://127.0.0.1:7777/api/tasks-index | jq '.tasks | length'
# → 11

curl -s http://127.0.0.1:7777/api/tasks-index | jq '.tasks[] | {id, title, column, tags, category}'
# → all 11 tasks with their derived metadata

curl -s http://127.0.0.1:7777/api/tasks/m7kx9p2a/mdx-rendered | jq '.blocks | length'
# → many blocks, each with data-block-id
\`\`\`
`;
