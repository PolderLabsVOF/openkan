export const AUTOTAG_MDX = `---
title: "Auto-tagging and categorization system"
status: shipped
---

## Goal

Every task gets \`tags: string[]\`, \`category: Category\`, \`priority: Priority\`, and \`effort: Effort | null\` derived from the title and description. Users can override with explicit \`#tag\` tokens in the text.

## Rules

### Tag keywords (case-insensitive)

| Keyword(s) | Tag |
|---|---|
| fix, bug, broken, regression, crash, outage, error | bug |
| feature, add support, implement | feature |
| refactor, cleanup, clean up | refactor |
| doc, docs, documentation, readme | docs |
| test, spec, e2e, coverage, playwright, vitest, jest | test |
| perf, performance, slow, optimi | perf |
| security, vuln, cve, xss, csp, auth, oauth, jwt, rbac | security |
| a11y, accessibility | a11y |
| ux, design, figma, mockup | ux |
| i18n, l10n, locale | i18n |
| migration, migrate | migration |
| deprecat | deprecation |

### Category rules (first match)

\`frontend\`, \`backend\`, \`infra\`, \`docs\`, \`test\`, \`design\`, \`data\`, \`security\`, \`task\` (default).

### Priority rules

\`urgent\` (P0) > \`high\` (P1) > \`low\` (P2) > \`normal\` (default).

### Effort rules (nullable)

\`xs\` (trivial, typo) > \`s\` (small, quick) > \`m\` (medium) > \`l\` (large) > \`xl\` (epic, multi-week).

## Files

- \`kanban/tags.ts\` (new) — \`extractMetadata()\`
- \`kanban/board.ts\` — added the four fields to \`Task\`
- \`kanban/mdx.ts\` — frontmatter + body
- \`kanban/server.ts\` — call \`extractMetadata\` on create/update; \`GET /api/tags\`
- \`plugins/tools.ts\` — \`kanban_add\` accepts explicit \`tags\`/\`category\`/\`priority\`/\`effort\`
- \`web/style.css\` — tag palette (\`--tag-bug\`, \`--tag-feature\`, etc.)

## Verification

28 unit tests in \`tests/tags.test.mts\`. \`node --test --experimental-strip-types tests/*.test.mts\` → 114 pass.
`;
