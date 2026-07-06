## What

<!--
Briefly describe the change. What does this PR do?
-->

## Why

<!--
Why is this change needed? Link to the issue if applicable.
-->

## How

<!--
Give a rough summary of the implementation approach. Link to the relevant
milestone doc if this addresses a milestone (docs/milestones/M*.mdx).
-->

## Testing

- [ ] I have verified the change works locally (ran OpenCode with the plugin,
      opened the board at http://127.0.0.1:7777).
- [ ] The existing CI typecheck passes (`bunx tsc --noEmit --allowJs --checkJs
      --target ES2022 --module ESNext --moduleResolution Bundler kanban/*.ts
      plugins/*.ts`).

## Checklist

- [ ] The commit title follows [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] I have tested the change locally.
- [ ] I have not included unrelated changes.
- [ ] If the change touches user-facing behaviour, I have updated the relevant
      docs or README section.
