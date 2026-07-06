export const BUGFIX_MDX = `---
title: "Server and CLI bug fixes"
status: fixed
---

## Summary

Five integration bugs caught after the parallel M7–M9 implementation. Each was missed by the unit tests but surfaced in a real end-to-end smoke.

## Bugs

### 1. webRoot path-doubling (\`kanban/server.ts\`)

**Symptom:** \`GET /\` returned 404. \`/index.html\`, \`/app.js\`, \`/style.css\` all 404.

**Root cause:** the static-file route defaulted \`webRoot\` to \`join(KANBAN_DIR, "..", "..", "web")\` — two \`..\` from \`.openkan\` lands at \`/home/drb0rk/Projects/\`, not the project root. The OpenCode plugin path was masked because it passed \`webRoot\` explicitly. The CLI didn't.

**Fix:** default to \`join(ctx.directory, "web")\`; have the CLI resolve its own location and pass \`webRoot: <openkan>/web\`.

### 2. CLI argv dispatcher ignored flags (\`bin/openkan.ts\`)

**Symptom:** \`openkan start --port 7801\` started the server on the configured port (7777), not 7801.

**Root cause:** \`cmdStart(ctx, positionals)\` passed only the positionals; \`parseArgs\` then saw an empty array and found no flags. The dispatcher at the top level already split flags from positionals.

**Fix:** pass \`argv.slice(1)\` to each subcommand so \`parseArgs\` re-parses the full slice.

### 3. Modal \`[hidden]\` CSS specificity loss (\`web/style.css\`)

**Symptom:** the "New Task" modal wouldn't close when Cancel, X, or backdrop were clicked, and didn't close after submitting the form.

**Root cause:** \`.modal-backdrop { display: flex }\` had equal specificity to the browser's default \`[hidden] { display: none }\`, but the class rule came later in the cascade so it won. \`modal.hidden = true\` added the attribute but didn't hide anything.

**Fix:** \`.modal-backdrop[hidden], .action-menu[hidden] { display: none !important; }\`.

### 4. Sucrase default JSX → \`React.createElement\` (\`kanban/tsx-sandbox.ts\`)

**Symptom:** \`<Preview tsx="<Button …/>" />\` failed to render in the iframe because the compiled JS referenced an undefined \`React\`.

**Root cause:** sucrase's default JSX transform emits \`React.createElement\`. Our sandbox has no React.

**Fix:** set \`jsxPragma: "h"\` and \`jsxFragmentPragma: "Fragment"\`; add a defensive regex to replace any leaked \`React.createElement\` calls; add \`Fragment\` to the runtime.

### 5. \`node:fs.flock\` not exposed in Node 24 (\`kanban/server.ts\`)

**Symptom:** the server failed to start with \`Error: Could not acquire server lock\`.

**Root cause:** \`flock\` is not exposed via \`node:fs\` in Node 24.16.0, despite the docs.

**Fix:** replaced with \`openSync(path, "wx")\` (O_CREAT | O_EXCL) for cross-platform exclusive create. Auto-clears stale lock when the PID is dead.

## Verification

All five fixes are covered by either existing unit tests (regression) or a manual smoke. End-to-end CLI flow now works:

\`\`\`sh
node bin/openkan.mjs init
node bin/openkan.mjs start --no-open --port 7801
# → OpenKan server at http://127.0.0.1:7801 (pid=...)
node bin/openkan.mjs status
# → status: running, pid: ..., port: 7801
curl http://127.0.0.1:7801/
# → HTTP 200, the kanban UI
node bin/openkan.mjs stop
\`\`\`
`;
