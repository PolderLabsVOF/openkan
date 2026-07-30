# OpenKan sample project

This small project demonstrates document import and project-local OpenKan
configuration.

## Run it

```sh
cd examples/sample-kanban-project
openkan init
openkan start
openkan open
```

The example configuration scans `docs/**/*.mdx`. Use the dashboard to import
checkbox tasks from `docs/roadmap.mdx`, or call the local API from an agent.

Project layout:

```text
sample-kanban-project/
├── .openkan/config.json
├── docs/roadmap.mdx
├── AGENTS.md
└── README.md
```

To reset the example:

```sh
openkan reset --hard
openkan init
```
