---
description: Use OpenKan as the project control plane. Supports board, tasks, goals, docs, chat, projects, settings, and Claude agent discovery.
---

Use the OpenKan skill and treat `.ok/` as the only writable workspace.

1. Run `openkan start --no-open` if needed, then `openkan agent context`.
2. For planning or task lifecycle work, use the `ok` CLI and lock/claim work.
3. For any dashboard capability, use `openkan api <path> --method <METHOD> --data '<JSON>'`.
4. Read before write; verify every mutation by reading the corresponding API.
5. Use `openkan agent start <task-id>` only after checking the agent snapshot.
6. Never modify `.openkan/`; it is legacy import input only.

Use `$ARGUMENTS` as the requested operation. Refer to
`.claude/skills/openkan/references/api.md` for endpoint contracts.
