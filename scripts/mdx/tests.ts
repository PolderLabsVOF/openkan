export const TESTS_MDX = `---
title: "Test infrastructure (0 → 114 tests)"
status: shipped
---

## Goal

The project had no tests. Added \`tests/\` with Node 22's built-in \`node --test\` runner (no extra deps). 114 tests across 12 files, all green.

## Files

- \`tests/io.test.mts\` — atomic writes, tmp cleanup
- \`tests/inputs.test.mts\` — Input CRUD
- \`tests/comments.test.mts\` — Comment CRUD
- \`tests/mdx-render.test.mts\` — block ID stability, rendering
- \`tests/tsx-sandbox.test.mts\` — compile, hook rejection, \`</script>\` escaping
- \`tests/migration.test.mts\` — flat → per-task dir migration
- \`tests/tags.test.mts\` — auto-tagging rules (28 cases)
- \`tests/changelog.test.mts\` — append-only log
- \`tests/git.test.mts\` — git log parsing, attribution
- \`tests/archive.test.mts\` — archive/restore
- \`tests/organize.test.mts\` — batch operations, atomic changelog
- \`tests/cli.test.mjs\` — CLI argv dispatcher, config round-trip

## Run

\`\`\`sh
node --test --experimental-strip-types tests/*.test.mts tests/*.test.mjs
# → 114 pass, 0 fail
\`\`\`

## Conventions

- Use \`node:test\` and \`node:assert\`. No \`vitest\`, no \`jest\`.
- Test files end in \`.test.mts\` (TypeScript) or \`.test.mjs\` (plain JS).
- Use \`os.tmpdir()\` + \`fs.mkdtempSync\` for temp dirs.
- Each test cleans up after itself (or uses a tmp dir that gets \`rmSync\`'d in \`finally\`).
- Use \`--experimental-strip-types\` flag for \`.mts\` files.
`;
