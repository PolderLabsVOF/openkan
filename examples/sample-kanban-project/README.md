# openkan — sample project

A tiny project you can boot OpenCode against to verify the M1 `kanban_import`
tool end-to-end.

## CLI

From this directory:

```sh
node --experimental-strip-types ../../bin/openkan.ts init
node --experimental-strip-types ../../bin/openkan.ts start
open http://127.0.0.1:7777/
```

## What's in here

```
sample-kanban-project/
├── docs/
│   ├── roadmap.mdx          # 9 unchecked checkboxes (M1, M2, M3 work)
│   └── tasks/
│       └── sprint1.mdx      # 5 unchecked + 3 done + fenced + indented
├── notes/
│   └── dev-notes.md         # 2 unchecked, intentionally outside docs/**
├── .openkan/
│   └── config.json          # example config overriding the default include
├── README.md                # this file
└── AGENTS.md                # written for the OpenCode agent session
```

## How to use it

1. `cd examples/sample-kanban-project`
2. Make sure openkan is installed and OpenCode is restarted (see the top-level
   `README.md` — `./install.sh`).
3. Open this directory in OpenCode. The agent will see the four custom tools:
   `kanban_view`, `kanban_add`, `kanban_move`, `kanban_start`, and the new
   `kanban_import` from M1.
4. Tell the agent: *"Run kanban_import."*
5. Open the local board at `http://127.0.0.1:7777/`. The Backlog column
   should contain the imported tasks.

## Expected counts after a default import

Default scan includes `docs/**` plus any top-level `*.md` / `*.mdx` file.
On the first import you should see exactly **23 Backlog tasks**:

- **`docs/roadmap.mdx`** — 12 unchecked tasks (all M1, M2, M3 items — the
  markdown headings are descriptive, not filters).
- **`docs/tasks/sprint1.mdx`** — 9 unchecked tasks: 5 from "Planned work",
  4 from "Indented sub-task" (one parent + three sub-tasks).
- **`notes/dev-notes.md`** — 2 unchecked tasks. These get pulled in because
  `*.md` matches top-level markdown files; if you want them excluded, set
  `exclude: ["notes/**"]` in `.openkan/config.json`.
- **`AGENTS.md`** and **`README.md`** (the sample project's own) — 0 hits;
  they have no checkboxes.

What the parser correctly does NOT pick up:

- The `- [x]` items in `sprint1.mdx` (3 done, filtered as `done=true`).
- The `- [ ]` line inside the triple-backtick code block (filtered by fence
  tracking).
- The `- [ ]` line inside the tilde code block (also filtered — M1's parser
  recognises both ``` and ~~~ CommonMark fences).

If you want to import only what's in `docs/**` and ignore top-level `.md`,
edit `.openkan/config.json` and remove the `*.md` / `*.mdx` entries.

## Tearing down

If you want to re-run the import from scratch, delete the state file first:

```sh
rm .openkan/board.json
# restart OpenCode to re-init the board
```

Then run `kanban_import` again.
