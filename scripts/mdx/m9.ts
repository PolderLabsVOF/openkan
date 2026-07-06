export const M9_MDX = `---
title: "M9: TSX/JSX preview components in MDX"
status: shipped
milestone: 9
---

## Goal

The agent embeds live, interactive TSX/JSX components inside a task's MDX via \`<Preview tsx="…" props="…" />\`. The component runs in a sandboxed iframe; the user interacts with it; the response is written back to the task and surfaced to the agent.

## Architecture

- **Server compile** — \`kanban/tsx-sandbox.ts\` uses \`sucrase\` with \`jsxPragma: "h"\` (so JSX compiles to calls to our runtime's \`h()\`, not \`React.createElement\`).
- **Sandbox** — iframe with \`sandbox="allow-scripts"\` (no \`allow-same-origin\`), \`referrerpolicy="no-referrer"\`. Opaque origin; cannot read parent DOM, cannot fetch network, cannot persist state.
- **Built-in library** — \`Button\`, \`Card\`, \`Row\`, \`Column\`, \`Text\`, \`Heading\`, \`Image\`, \`ColorSwatch\`, \`Code\`.
- **\`respond(value)\`** — posts \`{type: "openkan:respond", version: 1, value}\` to parent.
- **No hooks** — \`useState\`, \`useEffect\`, \`useRef\`, \`useContext\`, \`useMemo\`, \`useCallback\`, \`useReducer\`, \`useLayoutEffect\`, or any \`useXxx\` not in the library → rejected at compile time.
- **Limits** — TSX source max 32KB; compile is sync (sucrase is fast).

## Sample

\`\`\`mdx
<Preview
  tsx="<Card>
    <Heading>Choose a palette</Heading>
    <Row>
      <ColorSwatch color='#1f6feb' />
      <Button label='Dark blue' onClick={() => respond('dark-blue')} />
      <Button label='Warm' onClick={() => respond('warm')} />
    </Row>
  </Card>"
  props='{}'
/>
\`\`\`

## Files touched

- \`kanban/tsx-sandbox.ts\` (new) — \`compileTsx\`, \`buildSandboxHtml\`, hook rejection
- \`kanban/mdx-render.ts\` — \`<Preview>\` → \`<iframe sandbox srcdoc>\`
- \`kanban/server.ts\` — \`POST /api/preview\`
- \`web/preview-frame.html\` (new) — dev convenience page
- \`web/mdx-viewer.js\` — mounts iframes from placeholders
- \`plugins/tools.ts\` — \`kanban_preview\` tool

## Verification

\`\`\`sh
node --test --experimental-strip-types tests/*.test.mts
# tsx-sandbox tests: 13 cases including hook rejection and \`</script>\` escaping
\`\`\`

See \`docs/milestones/M9.mdx\` for acceptance criteria.
`;
