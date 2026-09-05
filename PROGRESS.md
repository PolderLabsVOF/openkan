# OpenKan progress log

This file is the human/agent checkpoint log for the openkan project. Update it
when work pivots, when a subagent finishes, or when a release branch moves.

## Current objective

Finish the openkan 0.4 → 0.5 backlog while preserving npm publish safety.
Concrete subgoals, in priority order:

1. Land and verify the four in-flight backlog features (see
   `tsk-c5o0mWbH` on the board).
2. Promote `dev` → `beta` → `main` after CI is green on `beta`.
3. Bump npm `latest` to the next semver via the trusted-publishing pipeline.

## Agent-progress convention

Every dispatched subagent MUST keep its target OpenKan task updated as it
works. The current primary session cannot inject user messages into running
agents, so this rule is enforced by the dispatch prompt and by the primary
session acting as scribe on completion.

For each agent (model name = `role` in the Bizar router, task id = the
OpenKan task being implemented):

1. **Start.** `PATCH /api/tasks/<taskId>` with `{"column": "doing"}` and a
   description that begins with `[agent:<agentId>] <UTC timestamp> started`.
2. **Milestones.** `POST /api/tasks/<taskId>/comments` with
   `{blockId: "<taskId>", text: "[agent:<agentId>] <UTC> <what changed>",
    author: "<agentId>"}`. The `blockId` field is required by the schema but
   not validated against any block table, so any string is fine.
3. **Verification.** `POST /api/tasks/<taskId>/comments` with the exact
   command output for `make check`, `make test`, and any other gates.
4. **End.** `PATCH /api/tasks/<taskId>` with `{"column": "review"}` (or
   `"done"` when accepted) and a description that ends with the final
   summary, file:line refs, and the commit SHA.

When the primary session receives a completion notification, it cross-checks
the worktree, merges the branch, and updates `tsk-c5o0mWbH` with the outcome.

## CLI QA pass 1 — closed (2026-09-05)

A bounded `todd` QA agent (`abe736e280b9c7722`) exercised 27 openkan
subcommands (160 invocations) against a `/tmp` scratch project and
created 25 `[qa]` findings on the board. Follow-up:

- `ok/` CLI fixes (4 findings) merged at `f0cdec8` by agent `a7b55f8f035a6bc30`:
  - `task add --status` now respected; empty/whitespace titles rejected
    with an actionable `rm <path>` hint in the schema error.
  - `migrate-from-openkan --path DIR` flag added.
  - `ok --help` expanded to 48 lines enumerating every subcommand.
- 12 confirmed-WORKING tasks closed (claim/release/heartbeat/complete,
  plan/prd/goal CRUD, progress --json, config, api, project, logs, doctor,
  index, init, mcp/onboard stubs, skill --agent, status/stop).
- 2 SKIPPED/NO-ACTION tasks closed (openkan start foreground; import
  --include/--exclude not exercised).
- `tsk-nGzH--O0` (task list --status bogus) re-classified as
  confirmed-WORKING once `tsk-x7eazVDe` (empty title cascading bug) was
  fixed.

`bin/openkan.ts` fix agent (`a0aea556c070c26a0`) and the
`tsk-LxeIjucy` task-deletion agent (`a71358e153694c0da`) still in
flight at the time of this snapshot — see in-flight table below.

## In-flight agents (snapshot 2026-09-05)

| Task | OpenKan id | Agent | Role | Worktree | Status |
| --- | --- | --- | --- | --- | --- |
| cross-project task move | `tsk-AOgK8RPo` | `a69dddcff195876f9` | todd | (merged at `deba3c6`) | done |
| openkan agent identity + task-creation docs | `tsk-qRzQVSSx` | `a0ce9a8e17b26e355` | todd | (merged at `ea502db`) | done |
| streaming chat markdown | `tsk-gKQlunXF` | `a3ba4c0f26b5df43b` | todd | (merged at `84f55b2`) | done |
| agent-host-protocol research + chat daemon plan | `tsk-KBumlNUh` | `a3add0f68c45fb633` | planner | (merged at `d7f86a6`) | done |

## Merges landed (2026-09-05)

- `84f55b2` — `feat(chat-sidebar)` debounced markdown re-render during streaming
- `ea502db` — `docs(agents)` expand openkan agent identity and CLI reference
- `d7f86a6` — `docs(chat)` research agent-host-protocol and draft chat daemon plan
- `deba3c6` — `feat(kanban,web)` move selected tasks to another project
- `5110880` — `fix(web)` task creation no auto-open after submit
- `c5bafcb` — `fix(chat-sidebar)` status element chevron nesting tidied
- `9f2c512` — `fix(web)` inline task editing only on explicit exit
- `892b84d` — `fix(server)` reconcile ok-cli task writes into the running board
- `f0cdec8` — `fix(ok)` task add --status + empty title rejected + actionable schema errors + migrate --path flag + expanded ok --help
- `dfa7ad0` — `fix(cli)` openkan open/reset/goal/skill/import/agent — six QA findings
- `3ddbed0` — `fix(web)` task deletion from card context menu

## Open questions

1. **OpenKan server needs a rebuild + reinstall** before the
   cross-project-move endpoint and the streaming markdown fix reach the
   running `127.0.0.1:7777` instance. The current process is the
   0.4.0 install. Run `npm run build && npm install -g` after this
   branch is tagged, or test the new features via the source-level
   worktree.
2. **`bizar worktree-merge` CLI bug.** `cli/commands/worktree-merge.mjs`
   uses `process.argv.slice(2)` and the bin.mjs dispatcher does not
   strip its own command name, so the first positional arg is treated
   as the branch and the real branch gets ignored. Workaround: manual
   `git tag merge-archive/<branch>-<sha> <sha>` + `git merge --no-ff
   <branch>` + `git worktree remove` + `git branch -D`. Worth filing
   upstream.
3. **Chat daemon transport choice** (SSE + command-POST vs WebSocket)
   is the highest-risk unresolved design call from the
   `docs/chat-daemon-plan.md` research. Decide before Phase 3 of the
   plan lands.

## Decisions log

- 2026-09-05: Three-branch release pipeline merged at `b6fd629`. npm trusted
  publishing configured via OIDC; no long-lived `NPM_TOKEN`.
- 2026-09-05: Cross-project task move decided to use the existing
  `/api/tasks/bulk` shape extended with `projectId` rather than introducing a
  parallel `/api/transfer` route. The selected tasks land in the matching
  column (id → title → first column) of the target project.

## npm package org rename — published (2026-09-05)

User asked to move the npm package from the personal scope
`@drb0rk/openkan` to the org scope `@polderlabs/openkan`. Strategy:
**rename + deprecate old**.

- Branch `wt/mike-npm-org-rename` at commit `2428e9c` (worktree
  `/tmp/openkan-wt-npm-rename`). Diff: 6 files, +13/-13.
- Touched: `package.json`, `package-lock.json`, `README.md`,
  `agents/openkan.md`, `skills/openkan/SKILL.md`,
  `.claude/skills/openkan/SKILL.md`.
- Merged locally to main as `a588b4b` (worktree branch also pushed to
  `origin/wt/mike-npm-org-rename`).
- Archived with tag `merge-archive/wt-mike-npm-org-rename-2428e9c`.
- Tracking task: `tsk-QNy1k8nT` (column: done).

### Published to npm

- `@polderlabs/openkan@0.4.0` — manual `npm publish --access public` from
  the worktree. No provenance (OIDC not available outside GitHub
  Actions); CI releases from now on will use `--provenance` once the
  trusted publisher is configured on npmjs.com.
- Tarball:
  <https://registry.npmjs.org/@polderlabs/openkan/-/openkan-0.4.0.tgz>
- Shasum: `8b5c443437481fc05cc739215c12fcd1a669aeb4`

### Deprecated on npm

- `@drb0rk/openkan@0.3.0` — pointer message:
  `Moved to @polderlabs/openkan. New package name is in effect; this
  package is no longer maintained. Install with: npm install -g
  @polderlabs/openkan`
- `@drb0rk/openkan@0.4.0` — same message.

Verification: `npm install @polderlabs/openkan` in a fresh `/tmp`
project installed 49 packages; `node_modules/@polderlabs/openkan/`
contains `agents/`, `bin/`, `dist/`, `LICENSE`, `README.md`, `skills/`,
`package.json`, `CHANGELOG.md`.

Not touched:

- `.ok/board.json` (the live running-server state diverges from the
  worktree base, and the historical description for `tsk-qRzQVSSx` still
  mentions `@drb0rk/openkan` — left intact because that accurately
  describes what was true at the time of commit `ea502db`).
- Local filesystem paths and tests that contain the literal `drb0rk`
  string (those are user identifiers, not package references).

User follow-ups (still HITL):

1. Configure npm trusted publisher for `@polderlabs/openkan` on
   npmjs.com against `PolderLabsVOF/openkan` `.github/workflows/release.yml`.
   Until this exists, CI publish attempts fail closed.
2. Push `origin main` (currently at `a588b4b` locally). The release
   workflow will then publish `@polderlabs/openkan@0.4.1` (bumpPatch of
   `0.4.0`); it will fail closed until trusted publisher is configured.
3. Optional: rebuild + reinstall via
   `npm install -g @polderlabs/openkan@0.4.0` to get the renamed CLI on
   the local PATH.

## Trusted publishing pipeline — live (2026-09-05)

Trusted publishing for `@polderlabs/openkan` is now wired through
`.github/workflows/release.yml`. First CI-driven release shipped.

### What shipped on the npm channel

- `@polderlabs/openkan@0.4.1` — published via GitHub Actions release
  workflow on push to `main`. `--provenance` + OIDC trusted publishing.
  `dist-tags.latest = 0.4.1`. GitHub release `v0.4.1` created with
  the package tarball.
- `@polderlabs/openkan@0.4.0` — manual publish from the worktree (no
  provenance). Deprecated in favor of 0.4.1 with:
  `Pre-trusted-publishing publish; the canonical stable release is
  0.4.1 (auto-published from CI with provenance).`
- `@drb0rk/openkan@0.3.0` + `@drb0rk/openkan@0.4.0` — deprecated with
  pointer to `@polderlabs/openkan`.

### Repo visibility

`PolderLabsVOF/openkan` was flipped from `PRIVATE` to `PUBLIC` (user
explicit consent). npm trusted publishing with `--provenance` requires
the source repo to be public; this was the last unblocker.

### CI fixes that landed alongside the rename

- `tests/install.test.mts` (commit `026e46d`): override
  `OPENKAN_SKIP_AGENT_INSTALL=0` in the install.sh helper so the agent
  copy is exercised even when CI sets it to `1` globally.
- `tests/planning-commands.test.mjs` (commit `026e46d`):
  pre-create the `skill --target` dir and pass `--force`.
- `scripts/test-package.mjs` (commit `4e1d904`): same skill-install
  precondition fix as above.
- `.github/workflows/release.yml` (commit `289cb0d`): `RELEASE_VERSION`
  was the string `"false"` on push events because
  `github.event_name != workflow_dispatch` made the boolean expression
  `false`; switched to `inputs.version || ""` so it is always a string.

### Commits added on top of the rename

| SHA | Description |
| --- | --- |
| `2428e9c` | `chore(release): rename npm package from @drb0rk/openkan to @polderlabs/openkan` |
| `a588b4b` | `merge: wt/mike-npm-org-rename into main` |
| `026e46d` | `test(ci): fix two pre-existing CI failures from CI-only env` |
| `4e1d904` | `test(ci): skill install --target must pre-create dir in package smoke` |
| `289cb0d` | `fix(release): RELEASE_VERSION must be empty string on push events` |

## Next actions

- Watch the four agent notifications; merge each worktree as it lands.
- Re-run `make check` on `main` once everything is integrated.
- Promote through `dev` → `beta` → `main`.
- For `chat-daemon`, schedule a follow-up architecture review before
  implementation; the protocol research alone is not enough to commit to a
  transport.
- Merge the npm-rename worktree once trusted publisher is configured.

## `openkan update` + `openkan -v` — shipped (2026-09-05)

User asked for a self-update path on the CLI. Shipped at commit
`d099654`, merged to `main` as `189c838`, pushed, and published as
`@polderlabs/openkan@0.4.2` via trusted publishing (workflow run
`33981816423`, success).

### What landed

- `bin/openkan.ts` (+178/-1):
  - `installedPackageJson()` walks `__dirname` upward to find the
    nearest `package.json` and reads `name` + `version`.
  - `printInstalledVersion()` prints `${name} ${version}`.
  - `-v` / `--version` short-circuit at the top of `main()` before any
    command dispatch, so they work with no workspace.
  - `cmdUpdate()` implements:
    - `--check` — report installed vs latest, exit non-zero when
      outdated, do not install.
    - `--yes` — skip the interactive confirmation prompt (no-op in
      non-TTY contexts, where the prompt is skipped automatically).
    - `--version <semver>` — pin the upgrade to a specific version.
    - `--help` / `-h` — print usage.
    - Unknown flags and stray positionals are rejected with
      actionable errors and exit 2.
  - `npmLatestVersion()` parses both bare (`0.4.1`) and JSON-wrapped
    (`["0.4.1"]`) output shapes that `npm view` emits depending on
    registry state.
  - `confirm()` reads a yes/no from stdin in TTY contexts and defaults
    to yes when stdin is not a TTY (so `openkan update --yes` and
    non-interactive shells work).
  - `printHelp()` adds the `update` entry and a `Version:` footer
    pointing at `-v` / `--version`.
- `tests/cli-update-version.test.mjs` (+101): 7 new regression tests
  covering `-v`, `--version`, `update --help`, unknown-flag rejection,
  positional rejection, `update --check` reporting, and the no-side-
  effects contract of `--check`.
- `package.json` bumped `0.4.0` → `0.4.2`; `package-lock.json`
  regenerated.

### Verification

- `npm run check`: 8 tasks / 0 warnings
- `npm test`: 653/653 pass (was 646, +7 new tests)
- `npm run build`: clean
- `openkan -v` → `@polderlabs/openkan 0.4.2`
- `openkan update --help` → usage with all four flags
- `openkan update --check` (worktree 0.4.0 against registry 0.4.1)
  → `installed 0.4.0, latest 0.4.1`, exit 1
- `openkan update --check` (installed 0.4.2 against registry 0.4.2)
  → `0.4.2 is already up to date`, exit 0
- `openkan update --version 0.4.2 --check` → `0.4.2 is already up to
  date`, exit 0 (proves `--version` flag is accepted)

### Release

- Push to `main` triggered workflow `33981816423`.
- `@polderlabs/openkan@0.4.2` published with `--provenance` via OIDC
  trusted publishing.
- `dist-tags.latest = 0.4.2`.
- GitHub release `v0.4.2` auto-created at
  <https://github.com/PolderLabsVOF/openkan/releases/tag/v0.4.2>.
- `@polderlabs/openkan@0.4.1` deprecated with pointer to `0.4.2`.

### Local install cleanup

- `npm uninstall -g @polderlabs/openkan @drb0rk/openkan` (removed both).
- `rm -rf ~/.local/share/openkan` (old `install.sh` artifact).
- `rm -f ~/.local/bin/{openkan,ok}` (old PATH shims).
- `npm install -g .` from merged local `main` → `@polderlabs/openkan@0.4.2`.
- `which openkan` → `/home/drb0rk/.npm-global/bin/openkan`.

Tracking task `tsk-rw1yVERZ` marked `done` with full evidence
comment.

