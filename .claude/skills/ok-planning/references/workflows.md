# Workflows — six end-to-end agent flows

Each workflow shows the goal, the `ok` commands, and what the agent
should look for in the output. Run them in any order; each is
self-contained.

---

## 1. Start a session and claim work

Goal: discover open tasks, take ownership of one before starting.

```sh
# 1. Ensure the workspace exists
ok init

# 2. Find work
ok task list --status pending --json
ok task list --status in_progress --json    # avoid collisions

# 3. Read the chosen task
ok task show <id> --json

# 4. Claim it (writes a lock for 1h default)
ok task claim <id> --owner <self>
```

What to watch for:

- If `ok task claim` prints `locked by …`, the lock is held by another
  agent. Coordinate or wait for the lease to expire (default 1h).
- `--lease-ms` lets you claim for longer if you know the work is big:
  `ok task claim <id> --owner <self> --lease-ms 3600000`.

---

## 2. End a session with concrete evidence

Goal: leave the workspace in a state the next agent can pick up.

```sh
# Did you finish?
ok task complete <id> --owner <self> --evidence "<sha-or-path-or-summary>"
# or, did you decide to drop?
ok task cancel <id> --owner <self> --reason "<why>"
# or, did you just stop without finishing?
ok task release <id> --owner <self>

# Always refresh the index so the next agent sees fresh state
ok index
```

Evidence expectations:

- A commit sha (`abc1234`)
- A `path:line` reference (`ok/lock.ts:60-105`)
- A URL (`https://…`)
- A one-line summary of what shipped

Anything that lets the next agent (or the user) verify the work without
chatting with you.

---

## 3. Scope a feature as PRD → Plan → Tasks

Goal: capture a long-horizon goal, group it into a milestone, and break
that into atomic tasks.

```sh
# 1. Define the north star
ok prd add "<short title>" \
  --vision "<one paragraph north star>" \
  --goals "g1|g2|g3" \
  --milestones "v0.1|v1.0" \
  --non-goals "X|Y" \
  --owners "<agent1>,<agent2>" \
  --review-cadence weekly
# → prd-AbCdEfGh

# 2. Group tasks under the PRD
ok plan add "v0.1: <milestone>" \
  --prd prd-AbCdEfGh \
  --summary "<elevator pitch>" \
  --acceptance "ship a" "ship b" \
  --tasks tsk-…,tsk-…
# → pln-XyZ12345

# 3. Add tasks with back-link to the plan (optional)
ok task add "<task>" --plan pln-XyZ12345 --owner <self>
ok task add "<task>" --prd prd-AbCdEfGh --owner <self>
```

Tip: keep PRDs stable across many sessions. Plans are short-lived;
don't promote plans to PRDs unless the work spans weeks.

---

## 4. Recover from drift or corruption

Goal: bring a `.ok/` tree back to a known-good state.

```sh
# 1. Diagnose
ok doctor

# 2. If the index is stale, rebuild
ok index

# 3. If a single file is corrupt, fix or remove it
rm .ok/tasks/tsk-bad.json
ok index
ok doctor
```

Common drift scenarios:

- **Stale lock** — `ok task claim <id> --owner <self>` after the lease
  expires, or `ok task release <id> --owner <stale-owner>` if you know
  the owner.
- **Index out of sync** — `ok index` rebuilds it from the filesystem.
- **Schema version mismatch** — bump the schema field and add a
  migration in `ok/storage.ts`; never silently drop fields.
- **Partial write leftover** — `.tmp-<pid>-<ts>` files are safe to
  delete; `ok init` will recreate them as needed.

---

## 5. Hand off to another agent

Goal: pass ownership cleanly without losing the lock or the work.

```sh
# Releasing agent
ok task update <id> --evidence "handoff to <new-agent>: <summary of state>"
ok task release <id> --owner <self>

# Picking-up agent
ok task claim <id> --owner <new-agent>
```

If the handover is bigger than a task (a whole plan or PRD), use
`--append-plan` on the PRD to record the new plan, and update
`prd.owners` via a JSON edit (or wait for the `ok prd update --owners`
flag to land).

---

## 6. Migrate from a legacy `.openkan/` workspace

Goal: bring an existing OpenKan board under the new `.ok/` planning
layer.

```sh
ok migrate-from-openkan             # one-shot, idempotent
ok doctor                           # validate the result
ok index                            # rebuild the index
```

Status mapping (legacy → planning):

| Legacy state | Planning status |
|--------------|-----------------|
| `done` | `done` |
| `running`, `waiting-for-input` | `in_progress` |
| `cancelled`, `failed` | `cancelled` |
| column `review` (state idle) | `review` |
| column `doing` (state idle) | `in_progress` |
| otherwise | `pending` |

Archived tasks become `cancelled`. Priority `urgent` → `p0`,
`normal` → `p2`, `low` → `p3`.

If a task has both a `tasks.json` and a `board.json` entry, the
`tasks.json` version wins (it's the older source of truth).

---

## Diagnostic commands

- `ok help` — usage summary.
- `ok doctor` — schema validation across the tree.
- `ok index` — rebuild `.ok/index.json` from the filesystem.
- `ok task list --json | jq '. | length'` — quick counts.
- `ok task show <id> --json` — full record.
