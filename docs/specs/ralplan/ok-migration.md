---
title: Migrate `openkan` CLI command to `ok` (hard cutover, v0.5.0)
status: draft (planner pass)
owner: @mike
date: 2026-09-06
inputs:
  - /projects/openkan HEAD 5221447
  - /projects/openkan origin/main 5221447
  - bin/openkan.ts, bin/ok.ts, ok/commands/*.ts
  - bin/openkan.mjs, bin/ok.mjs, bin/install-agent.mjs
  - install.sh, scripts/release.mjs, scripts/test-package.mjs
  - skills/openkan/SKILL.md, skills/openkan/references/api.md, skills/openkan/agents/openai.yaml
  - agents/openkan.md
  - package.json (bin: { openkan, ok }, version 0.4.9 published, 0.4.3 local)
  - README.md, CHANGELOG.md, docs/*.md
  - tests/cli.test.mjs, tests/cli-update-version.test.mjs, tests/cli-qa-fixes.test.mjs, tests/qa-cli-fixes.test.mts, tests/serve-cli.test.mjs, tests/install.test.mts, tests/planning-commands.test.mjs, tests/m19-profiles.test.mts, tests/install-agent-prompt.test.mjs, tests/openkan-skill-content.test.mjs, tests/cli-migration.test.mts
related:
  - docs/specs/ralplan/agent-profiles-and-mcp.md (format reference)
---

# Migrate `openkan` CLI command to `ok` (hard cutover, v0.5.0)

## 1. Summary

Replace the `openkan` CLI command with `ok` as the only entry point.
After this plan lands, `npm install -g @polderlabs/openkan` provides the
`ok` executable and nothing else. Running `openkan ...` on the user's
shell returns `command not found` — there is no alias, no shim, no
deprecation warning. The defaults flip from `openkan …` to `ok …` in
every doc, skill, agent, README, and test.

What **does not** change:

- The npm package name stays `@polderlabs/openkan`.
- The skill name stays `openkan` (`skills/openkan/`, `name: openkan`).
- The agent name stays `openkan` (`agents/openkan.md`,
  `OPENKAN_AGENT_ID = 'openkan'` in `kanban/agent-profile.ts`).
- `.ok/openkan.json` stays the project workspace pin file.
- `${XDG_DATA_HOME:-$HOME/.local/share}/openkan}` stays the install root.
- `install.sh`, the symlink, and the application directory all keep the
  `openkan` brand.

The brand is the product; the CLI command is just the entry point.
Decoupling them is the whole point.

## 2. Goals and success criteria

- `ok -v` and `ok --version` print the installed package name and
  version (relocated from `openkan -v`).
- `ok serve` (no subcommand) starts the local server with the same
  semantics as today's `openkan serve` (interactive mode prompt,
  foreground/background/tray modes, auto-detect).
- `ok start`, `ok stop`, `ok status`, `ok open`, `ok config …`,
  `ok logs …`, `ok api …`, `ok agent …`, `ok reset …`, `ok update …`,
  `ok skill …` all behave identically to the current `openkan …`
  implementations.
- `ok task …`, `ok plan …`, `ok prd …`, `ok goal …`, `ok progress`,
  `ok doctor`, `ok index`, `ok init`, `ok migrate-from-openkan`
  continue to work (already in `bin/ok.ts`; verified after the move).
- `package.json` ships exactly one binary: `"bin": { "ok": "bin/ok.mjs" }`.
- `version` bumps from `0.4.9` to `0.5.0`.
- `install.sh` links `${BIN_DIR}/ok` (not `${BIN_DIR}/openkan`).
- After release, `npx --package @polderlabs/openkan openkan …` returns
  `command not found`. No soft alias. No shim.
- `npm test`, `npm run check`, `npm run build`, `npm run test:package`
  pass at the release commit.

## 3. Non-goals

- **No backwards-compat alias.** Explicitly rejected by the user.
  No `bin/openkan.mjs` that prints a deprecation warning. No
  `package.json` shim that forwards `openkan` to `ok`. After 0.5.0,
  `openkan` on `$PATH` means the user has it from a different source.
- **No Milestones-and-roadmaps rework.** That is a separate plan
  landing on top of 0.5.0.
- **No server refactor.** `cmdServe`, `cmdStart`, etc. move files and
  signatures only; the kanban server code under `kanban/` is untouched.
- **No agent-name change.** `name: openkan` in `agents/openkan.md`
  stays. `OPENKAN_AGENT_ID` in `kanban/agent-profile.ts` stays.
- **No public HTTP/API change.** The `127.0.0.1:7777` API surface,
  endpoints, and behavior are unchanged.
- **No `.ok/openkan.json` rename.** The file name and shape stay.
- **No web/ UI change.** The dashboard is not touched.
- **No `.openkan/` migration rewrite.** `ok migrate-from-openkan`
  already exists and continues to work for legacy projects.

## 4. Architecture and rationale

### 4.1 Why the cutover is safe to hard-delete

`ok` already implements every planning subcommand and dispatches via
`bin/ok.ts` (138 lines). The only commands missing from `ok` are the
server-control and agent-bridge commands (`serve`, `start`, `stop`,
`status`, `open`, `config`, `logs`, `api`, `agent`, `reset`, `update`,
`skill`, `onboard`, `mcp`). All of those live in `bin/openkan.ts`
(1184 lines). Moving them under `ok/commands/` is the bulk of the
mechanical work; no logic rewrite is required.

The hard cutover is safe because:

1. The skill (`skills/openkan/SKILL.md`) is what tells agents which
   command to run. Agents that follow the skill update together with
   the binary.
2. The npm-published README is the human install guide. Update in the
   same release.
3. There is no first-party integration that depends on the `openkan`
   command name outside this repo (no companion package, no alias
   script, no Docker entrypoint). The brand lives in three places:
   `package.json` name, `skills/openkan/`, `agents/openkan.md`. None
   of those are the CLI command.

### 4.2 Layout target

```
bin/
  ok.mjs            # Node launcher: forwards to bin/ok.ts or dist/bin/ok.js
  ok.ts             # Entry point: dispatches to ok/commands/*.ts and serves
                    # the planning subcommands. Now the only binary entry.
  openkan.mjs       # DELETED in M2 (published shim)
  openkan.ts        # DELETED in M1 (logic moved into ok.ts / ok/commands/)
  tray.ts           # KEEP — shared by ok.ts and the serve family.
  install-agent.mjs # UPDATE log/help text ([openkan] → [ok]).
  assets/           # KEEP
  ok-install.ts     # KEEP

ok/
  commands/
    index.ts        # KEEP — runIndex / runDoctor
    init.ts         # KEEP
    task.ts         # KEEP
    plan.ts         # KEEP
    prd.ts          # KEEP
    goal.ts         # KEEP
    progress.ts     # KEEP
    serve.ts        # NEW — cmdServe, cmdStart, cmdOpen, cmdStop, cmdStatus
    project.ts      # NEW — cmdProject list/use
    board.ts        # NEW — cmdBoard list/show/add/move/comment
    config.ts       # NEW — cmdConfig get/set/list
    logs.ts         # NEW — cmdLogs
    api.ts          # NEW — cmdApi (HTTP bridge)
    agent.ts        # NEW — cmdAgent install/capabilities/context/call/start/abort
    reset.ts        # NEW — cmdReset
    update.ts       # NEW — cmdUpdate
    skill.ts        # NEW — cmdSkill install
    import.ts       # NEW — cmdImport (kanban/import.ts wrapper)
  ids.ts            # KEEP
  lock.ts           # KEEP
  migrate.ts        # KEEP
  README.md         # KEEP — update if it references the old layout
  schemas.ts        # KEEP
  storage.ts        # KEEP
```

### 4.3 Reuse boundaries

- `cmdServe`, `cmdStart`, `cmdOpen`, `cmdStop`, `cmdStatus` are moved
  **verbatim** from `bin/openkan.ts` into `ok/commands/serve.ts`.
  Same signatures, same return types, same imports. The only edits are
  the user-facing error strings (`openkan: …` → `ok: …`) and any
  console.log that says "openkan …".
- `cmdAgent`, `cmdReset`, `cmdUpdate`, `cmdImport`, `cmdSkill`,
  `cmdConfig`, `cmdLogs`, `cmdApi`, `cmdProject`, `cmdBoard` follow
  the same rule: pure relocation. No behavior change.
- `kanban/server.ts`, `kanban/board.ts`, `kanban/projects.ts`,
  `kanban/agent-profile.ts`, `kanban/import.ts`, `kanban/io.ts` are
  reused through their existing public exports. No edits inside
  `kanban/`.
- `ok/storage.ts`, `ok/schemas.ts`, `ok/lock.ts`, `ok/ids.ts`,
  `ok/migrate.ts` are reused by the new `ok/commands/*.ts` files for
  any task/plan/prd/goal/progress/doctor touchpoints. No edits.
- `tray.ts` keeps its current location in `bin/` and is imported from
  `ok/commands/serve.ts` (the `cmdServe` and `cmdStart` paths).

## 5. Milestones

### M1 — Move CLI logic into `ok`

**Goal:** Relocate every command currently in `bin/openkan.ts` to
`bin/ok.ts` (the dispatcher) and a new `ok/commands/serve.ts` (and
sibling files), and delete `bin/openkan.ts` in the same commit
(no transitional shim — the user's iteration-4 choice). After M1
lands the only CLI entry point is `ok`; the old `openkan` command
is gone from the working tree.

**Scope:**

- Create `ok/commands/serve.ts` containing `cmdServe`, `cmdStart`,
  `cmdOpen`, `cmdStop`, `cmdStatus`, plus the shared helpers
  (`apiBaseUrl`, `parseJsonInput`, `loadConfig`, `printInstalledVersion`,
  `printHelp`, `parseArgs`, `StartMode`, `parseMode`, `parseHost`,
  `parsePort`, etc.) currently at the top of `bin/openkan.ts`.
- Create `ok/commands/config.ts`, `ok/commands/logs.ts`,
  `ok/commands/api.ts`, `ok/commands/agent.ts`, `ok/commands/reset.ts`,
  `ok/commands/update.ts`, `ok/commands/skill.ts`, plus
  `ok/commands/board.ts`, `ok/commands/project.ts`, `ok/commands/import.ts`
  for the dashboard-side commands and the legacy import.
- Extend `bin/ok.ts` to import the new commands and add cases in the
  main switch:
  `serve`, `start`, `stop`, `status`, `open`, `config`, `logs`, `api`,
  `agent`, `reset`, `update`, `skill`, `import`, `onboard`, `mcp`,
  `board`, `project`.
- Rewrite the `printHelp` / catalogue tables in `bin/ok.ts` so the
  `--help` output reads as `ok <command>` for everything.
- Mirror the bare-invocation friendly behavior in `bin/openkan.ts`:
  `ok` with no args defaults to `ok serve` after a help/version
  pre-flight (see `bin/openkan.ts:1051`).
- Update user-facing error strings from `openkan: …` to `ok: …`.
  Update `console.log` lines that name the program.
- **M1 deletes `bin/openkan.ts` together with the relocation.**
  There is no transitional shim and no `openkan` re-export: once
  M1 lands, `node --experimental-strip-types bin/openkan.ts …`
  returns `Cannot find module`. M1 is therefore a larger atomic
  commit that combines the command relocation with the binary
  deletion; that trade-off is explicit per the user's
  iteration-4 choice. The published shim `bin/openkan.mjs` is
  still dropped in M2 (it has to be — only the source
  relocation lands in M1).

**Non-goals:**

- `package.json` is not yet changed.
- `install.sh` is not yet changed.
- Skills/docs/README are not yet changed.

**Files:**

- `bin/ok.ts` (modify: import new commands, add cases, refresh help)
- `bin/tray.ts` (modify: rewrite header and stderr references; see M1
  Reuse section)
- `ok/commands/serve.ts` (new)
- `ok/commands/config.ts` (new)
- `ok/commands/logs.ts` (new)
- `ok/commands/api.ts` (new)
- `ok/commands/agent.ts` (new)
- `ok/commands/reset.ts` (new)
- `ok/commands/update.ts` (new)
- `ok/commands/skill.ts` (new)
- `ok/commands/board.ts` (new)
- `ok/commands/project.ts` (new)
- `ok/commands/import.ts` (new)
- `bin/openkan.ts` (delete — combined with the relocation; no shim)
- `bin/ok.mjs` (no change; already correct)
- `ok/commands/index.ts` (no change unless we want to expose the new
  command list to `bin/ok.ts` via a single import)
- `tests/cli.test.mjs` (modify: rewrite hardcoded `bin/openkan.ts`
  references to `bin/ok.ts`; CR1/CR2/CR4 work moved from M4 to M1 to
  keep `npm test` green after the atomic relocation+deletion)
- `tests/cli-update-version.test.mjs` (modify: rewrite hardcoded
  `bin/openkan.ts` references to `bin/ok.ts`; CR1/CR2/CR4 work moved
  from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/cli-qa-fixes.test.mjs` (modify: rewrite hardcoded
  `bin/openkan.ts` references to `bin/ok.ts`; CR1/CR2/CR4 work moved
  from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/qa-cli-fixes.test.mts` (modify: rewrite hardcoded
  `bin/openkan.ts` references to `bin/ok.ts`; CR1/CR2/CR4 work moved
  from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/serve-cli.test.mjs` (modify: rewrite hardcoded `bin/openkan.ts`
  references to `bin/ok.ts`; CR1/CR2/CR4 work moved from M4 to M1 to
  keep `npm test` green after the atomic relocation+deletion)
- `tests/install.test.mts` (modify: rewrite hardcoded `bin/openkan` /
  `bin/openkan.mjs` references to `bin/ok` / `bin/ok.mjs`; CR1/CR2/CR4
  work moved from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/planning-commands.test.mjs` (modify: rewrite hardcoded
  `bin/openkan.ts` references to `bin/ok.ts`; CR1/CR2/CR4 work moved
  from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/m19-profiles.test.mts` (modify: rewrite hardcoded
  `bin/openkan.ts` references to `bin/ok.ts`; CR1/CR2/CR4 work moved
  from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/install-agent-prompt.test.mjs` (modify: rewrite hardcoded
  `openkan agent install` reference to `ok skill install`; CR1/CR2/CR4
  work moved from M4 to M1 to keep `npm test` green after the atomic
  relocation+deletion)
- `tests/openkan-skill-content.test.mjs` (modify: rewrite hardcoded
  `openkan <cmd>` and `default-to-openkan` references to their `ok`
  equivalents; CR1/CR2/CR4 work moved from M4 to M1 to keep `npm test`
  green after the atomic relocation+deletion)
- `tests/cli-migration.test.mts` (new: add the M4 automated
  `bin/openkan.ts` absence gate
  (`assert.equal(existsSync('bin/openkan.ts'), false)`) to the M1
  atomic commit so the gap between M1 landing and M4 landing has guard
  coverage; the full test file remains owned by M4 where it
  accumulates the remaining migration gates)

**Reuse:**

- Every command body is moved verbatim from `bin/openkan.ts`. No
  logic changes. The same imports (`kanban/server.ts`,
  `kanban/board.ts`, `kanban/projects.ts`, `kanban/io.ts`,
  `kanban/agent-profile.ts`, `kanban/import.ts`, `bin/tray.ts`) power
  the new `ok/commands/*.ts` files.
- `parseArgs`, `loadConfig`, `printHelp`, `printInstalledVersion`,
  `apiBaseUrl`, `parseJsonInput`, `StartMode`, `parseMode` move into
  `ok/commands/serve.ts` and are re-exported for the rest of the
  family. They are not duplicated.
- `bin/ok.ts`'s planning-command dispatcher (`task`, `plan`, `prd`,
  `goal`, `progress`, `doctor`, `index`, `migrate-from-openkan`,
  `init`) stays exactly as it is.
- **M1 owns the comment-only edits to `bin/tray.ts` and
  `bin/ok.ts`.** These files contain stale references to
  `bin/openkan.ts`, the file M1 deletes:
  - `bin/tray.ts`: header comment at lines 69-70 ("whether
    the entrypoint is bin/openkan.ts …"); the `openkan stop`
    reference at line 188; the `openkan tray:` stderr prefix
    at lines 189 and 206; the `defaultIconDir` reference at
    line 247 if any.
  - `bin/ok.ts`: header comment at line 4 about
    `bin/openkan.ts shape`; the `\`openkan --help\`` reference
    in `printHelp` at line 22.
  - The changes are comment-only — no behavioural delta —
    and land in M1 so reviewers see the deletion
    (`bin/openkan.ts`) and the comment fix
    (`bin/tray.ts` / `bin/ok.ts`) in the same atomic commit.
- **M2 owns the comment-only edit to `bin/ok.mjs`.**
  `bin/ok.mjs` (header comment at line 3: `Mirrors
  bin/openkan.mjs`) carries a stale reference to
  `bin/openkan.mjs`, the file M2 deletes. The rewrite to
  `Mirrors bin/ok.mjs` (or an equivalent self-referential
  header) lands in M2 alongside the `bin/openkan.mjs`
  deletion so reviewers see the deletion and the comment fix
  in the same commit. The `bin/ok.mjs` file itself survives
  M2 unchanged; only the header comment is touched.

**Acceptance criteria:**

- Running `ok serve` (and every other relocated subcommand) via
  `node --experimental-strip-types bin/ok.ts <subcmd> …` produces
  the same stdout, stderr, and exit code as the equivalent
  `node --experimental-strip-types bin/openkan.ts <subcmd> …` did
  before this milestone.
- `ok --help` enumerates every subcommand, including the new ones.
- M1 deletes `bin/openkan.ts`; running
  `node --experimental-strip-types bin/openkan.ts …` returns
  `Cannot find module` (expected) and the existing `npm test`
  suite passes.

**Verification:**

- **Automated gate:** `tests/cli.test.mjs`,
  `tests/cli-update-version.test.mjs`,
  `tests/cli-qa-fixes.test.mjs`, `tests/qa-cli-fixes.test.mts`,
  `tests/serve-cli.test.mjs`, `tests/install.test.mts`,
  `tests/planning-commands.test.mjs`,
  `tests/m19-profiles.test.mts`,
  `tests/install-agent-prompt.test.mjs`,
  `tests/openkan-skill-content.test.mjs` (all 10 files in
  the M1 Files list) pass after the atomic
  relocation+deletion. The `bin/openkan.ts` absence test
  (`tests/cli-migration.test.mts`, the M4
  `assert.equal(existsSync('bin/openkan.ts'), false)` gate)
  is duplicated in M1's commit to guard the gap before M4
  lands, so `npm test` fails if any of the rewritten tests
  drops a `bin/openkan.ts` reference or if M1 is reverted
  while M4 is still in flight.
- `npm test` — full suite green; no regressions.
- `npm run check` — sanity-check green.
- `npm run typecheck` — no new type errors from the relocation.
- Manual smoke (developer machine):
  - `node --experimental-strip-types bin/ok.ts --version`
    prints `0.4.9` (or the current version) — this is the
    only entry point now.
  - `node --experimental-strip-types bin/ok.ts help`
    lists every subcommand.
  - `node --experimental-strip-types bin/openkan.ts --version`
    reports `Cannot find module` (expected; the file is
    gone — no transitional shim).
- `npm run serve-cli` (if defined) or
  `node --test tests/serve-cli.test.mjs` — green.

**DoD:**

- All M1 acceptance criteria pass.
- After M1 lands, `openkan` is no longer a valid command: the
  `bin/openkan.ts` source is gone and no transitional shim
  remains. A user invoking `openkan …` from the shell sees
  `command not found` once they upgrade past this commit; the
  only entry point is `ok`, whose `--help` now prints the
  `ok`-flavored catalogue table. All `ok <subcommand>`
  invocations produce byte-identical stdout, stderr, and exit
  codes to the equivalent pre-M1 `bin/openkan.ts <subcommand>`
  invocations.
- Diff is reviewable as relocation + deletion (no logic delta
  inside the relocated command bodies; the deletion of
  `bin/openkan.ts` is a clean file removal with no replacement
  content).

### M2 — Drop the `openkan` binary

**Goal:** Delete `bin/openkan.mjs` (the published shim) and flip the
`package.json` `bin` field so only `ok` is published. Bump `version`
to `0.5.0`. Update `install.sh` to link `${BIN_DIR}/ok`. The
published package no longer ships an `openkan` command.

> **M2 is now a small follow-up because M1 already performed the
> relocation + `bin/openkan.ts` deletion** (per the user's
> iteration-4 choice). This milestone no longer needs to delete any
> TypeScript source — M1 handled that. M2 is the published-artifact
> flip: drop `bin/openkan.mjs` from the tarball, drop the
> `openkan` entry from `package.json`, and bump the version.

**Scope:**

- `package.json`:
  - `"version": "0.5.0"` (was `0.4.9` published, `0.4.3` local).
  - `"bin": { "ok": "bin/ok.mjs" }` (drop `"openkan"`).
  - Drop the `"openkan": "node --experimental-strip-types bin/openkan.ts"`
    script (keep `"ok"`, `"ok-install"`, `"build"`, `"check"`,
    `"test"`, `"typecheck"`, `"e2e"`, `"test:package"`,
    `"prepack"`, `"postinstall"`). The `"openkan"` script is
    already pointing at a file M1 deleted, so this entry is a
    stale-but-harmless dangling reference until M2 removes it.
- Delete `bin/openkan.mjs` (the published source shim that
  re-exports from `bin/ok.mjs`). M1 already deleted the
  TypeScript source `bin/openkan.ts`, so M2 only owns the
  `.mjs` artifact and the `package.json` `bin` flip.
- `install.sh`:
  - Replace `ln -sfn "${INSTALL_ROOT}/bin/openkan.mjs" "${BIN_DIR}/openkan"`
    with `ln -sfn "${INSTALL_ROOT}/bin/ok.mjs" "${BIN_DIR}/ok"`.
  - Update the success banner that says
    `Command:     ${BIN_DIR}/openkan` to `Command:     ${BIN_DIR}/ok`.
  - Update the post-install hint
    `Run 'openkan init' inside a project, then 'openkan start'.`
    to `Run 'ok init' inside a project, then 'ok start'.`
  - Update the "skipped" hint
    `Run \`openkan agent install\` later.` to
    `Run \`ok skill install\` later.`
- `scripts/release.mjs`:
  - **The 0.5.0 minor bump CANNOT be derived by
    `scripts/release.mjs` alone.** The script's `bumpPatch`
    function (line 68) only knows patch-level increments. With
    `RELEASE_CHANNEL=stable` and no `RELEASE_VERSION` override,
    `bumpPatch(latestTag)` on the current `0.4.9` `latest`
    produces `0.4.10` (a patch release), NOT `0.5.0`. The
    `RELEASE_VERSION` override path (line 91) DOES parse `0.5.0`
    as semver, but the auto-bump path never reaches it.
  - **Required precondition for the 0.5.0 release (also added
    as a precondition line in the M5 runbook below):**
    `RELEASE_VERSION=0.5.0 RELEASE_CHANNEL=stable
    RELEASE_SHA=<commit-sha>`. Without this explicit override,
    the release script computes and publishes `0.4.10`, which
    would put the migration under a patch bump and break the
    cross-phase `version: 0.5.0` invariant in gate 1 of the
    Definition of Done.
  - This plan touches `scripts/release.mjs` only to confirm
    the override parses and writes `0.5.0` to `package.json`
    correctly; no logic change is required (and none is
    desired — keep the script's auto-bump behaviour intact for
    future patch releases).
- `scripts/test-package.mjs`:
  - `pack.files.some(file => file.path === 'dist/bin/openkan.js')`
    → `'dist/bin/ok.js'`.
  - `cli = ... join(installed, 'bin/openkan.mjs')` →
    `... join(installed, 'bin/ok.mjs')`.
  - `server = spawn(... join(installed, 'dist/bin/openkan.js') ...)`
    → `... join(installed, 'dist/bin/ok.js') ...`.
  - The legacy temp name `'openkan-package-'` stays; that is just a
    tmp-directory label, not a shipped binary name.
  - The window-link path
    `process.platform === 'win32' ? join(installed, 'bin/openkan.mjs') : join(temp, 'node_modules/.bin/openkan')`
    becomes
    `process.platform === 'win32' ? join(installed, 'bin/ok.mjs') : join(temp, 'node_modules/.bin/ok')`.
- `bin/install-agent.mjs`:
  - Update the log prefix `[openkan]` → `[ok]`.
  - Update the manual-install hint
    `Run openkan agent install to retry.` →
    `Run \`ok skill install\` to retry.`
  - This entry point is invoked as a Node script during `npm install`
    via the `postinstall` hook, **not** as the CLI command, so the
    prefix change is a cosmetic log alignment only. The interactive
    CLI command now lives at `ok skill install`.

**Non-goals:**

- No new commands, no new options.
- No brand change.

**Files:**

- `package.json` (modify: version, bin, scripts)
- `bin/openkan.mjs` (delete — published shim; `bin/openkan.ts`
  is already gone from M1)
- `bin/ok.mjs` (modify: rewrite header comment `Mirrors
  bin/openkan.mjs` → `Mirrors bin/ok.mjs`; the file itself
  survives M2, only the header is touched, and the rewrite
  pairs with the `bin/openkan.mjs` deletion so reviewers
  see both changes in one commit)
- `install.sh` (modify: symlink, banners, hints)
- `scripts/test-package.mjs` (modify: paths)
- `scripts/release.mjs` (modify: no logic change, confirm override works)
- `bin/install-agent.mjs` (modify: log prefix, hint text)
- `tests/install-script-prompt.test.mts` (modify: rewrite line 146
  assertion `/openkan agent install/` → `/ok skill install/`)

**Reuse:**

- `bin/ok.mjs` already wraps `bin/ok.ts` and `dist/bin/ok.js` — no
  change needed.
- The package's existing `files` glob (`"bin/*.mjs"`) already covers
  `bin/ok.mjs`; it covers nothing once `bin/openkan.mjs` is gone.

**Acceptance criteria:**

- `package.json` has `"bin": { "ok": "bin/ok.mjs" }` and
  `"version": "0.5.0"`.
- `bin/openkan.mjs` is gone from the working tree and from the
  published tarball. (`bin/openkan.ts` was deleted in M1, so
  by the start of M2 it is already absent — M2 just has to
  confirm it has not been re-introduced.)
- `install.sh` links `${BIN_DIR}/ok` and prints
  `Command:     ${BIN_DIR}/ok`.
- `scripts/test-package.mjs` no longer references `bin/openkan.mjs`
  or `dist/bin/openkan.js`; running
  `npm pack --dry-run` produces a tarball listing `bin/ok.mjs` and
  not `bin/openkan.mjs`.
- `bin/install-agent.mjs` log lines start with `[ok]`.
- `tests/install-script-prompt.test.mts` line 146 assertion rewritten
  to `/ok skill install/`; assertion passes post-M2.

**Verification:**

- `git grep -n "openkan\\.mjs\\|openkan\\.ts" -- 'bin/' 'install.sh' 'scripts/' 'package.json'` returns nothing.
- `npm pack --dry-run` lists `bin/ok.mjs` and no `bin/openkan.mjs`.
- `node scripts/test-package.mjs` exits 0.
- `npm test`, `npm run check`, `npm run typecheck` all green.

**DoD:**

- M2 acceptance criteria all pass.
- No user-facing command remains under the `openkan` name in this
  package.

### M3 — Update skills, agent, and docs

**Goal:** Rewrite every skill, agent, README, and doc reference from
`openkan <cmd>` to `ok <cmd>`. The agent's reasoning layer never says
"run openkan …" again. The installer-skill default is `ok`.

**Scope:**

- `skills/openkan/SKILL.md`:
  - **Frontmatter description**: `Use the OpenKan CLI (`openkan` or
    `ok`)` → `Use the OpenKan CLI (`ok`)`; the `or ok` alternative
    is now the only form.
  - **Default-behavior contract** (lines around the first 30):
    `Default to openkan for everything …` →
    `Default to ok for everything …`.
  - Replace every `openkan api /api/PATH` reference with
    `ok api /api/PATH`.
  - Replace every `openkan <command> --help` reference with
    `ok <command> --help`.
  - Replace the boilerplate example block (currently
    `openkan task add …`, `openkan task claim …`,
    `openkan task heartbeat …`, `openkan task update …`,
    `openkan task complete …`) with `ok task …` equivalents.
  - Replace the PRD/plan/goal/progress examples (all `openkan …`)
    with `ok …`.
  - Replace the dashboard examples (currently `openkan start`,
    `openkan project list`, `openkan project use …`, `openkan board …`)
    with `ok start`, `ok project list`, `ok project use …`,
    `ok board …`.
  - Replace the agent-bridge examples (`openkan agent capabilities`,
    `openkan agent context`, `openkan agent start …`,
    `openkan agent abort …`, `openkan import …`) with `ok …`.
  - Replace `openkan api`, `openkan agent call`, and
    `openkan doctor` with `ok …` forms.
  - Replace the install instructions block
    `npm install -g @polderlabs/openkan` then
    `openkan skill install --agent all` →
    `npm install -g @polderlabs/openkan` then
    `ok skill install --agent all`.
  - Update the first-instruction block (`Run validation …`) which
    ends with `Run openkan doctor` → `Run ok doctor`.
- `skills/openkan/references/api.md`:
  - `by openkan status` → `by ok status`.
  - `Use openkan archive and the planning system's ok prd close`
    stays (it already uses `ok prd close`).
- `skills/openkan/agents/openai.yaml`:
  - `Use openkan task, goal, plan, progress and board commands` →
    `Use ok task, goal, plan, progress and board commands`.
- `agents/openkan.md`:
  - All `openkan <cmd>` examples (lines 36, 44-47, 60-62, 67-76,
    85-87, 91, 207, 210) become `ok <cmd>` examples.
  - `Use openkan (or the planning-only ok alias)` →
    `Use ok`.
  - `openkan --help` → `ok --help`.
  - `openkan agent capabilities` → `ok agent capabilities`.
  - `openkan archive` (if it appears) → `ok archive` (or remove the
    reference if `ok archive` is not a command — verify in
    `bin/openkan.ts`; if `archive` lives only on the kanban server
    side, route via `ok board archive`).
- `README.md`:
  - Quick-start: `npm install -g @polderlabs/openkan` then
    `openkan init` → `ok init`.
  - All example commands throughout switch to `ok`.
  - "Its executables are openkan and ok" →
    "Its executable is `ok`".
  - `ok task list --json` and `openkan task list --json` use the
    same records.` stays as `ok task list --json` reads and writes
    the same records.` (drop the dual-form sentence).
- `docs/OK-PLANNING.md`, `docs/HOOKS.md`, `docs/CHAT-SIDEBAR.md`,
  `docs/RELEASING.md`, `docs/chat-daemon-plan.md`,
  `docs/README.mdx`, `docs/milestones/M*.mdx`:
  - Every `openkan <cmd>` example becomes `ok <cmd>`.
  - `openkan update` references (in `docs/RELEASING.md` if present)
    become `ok update`.
  - `docs/chat-daemon-plan.md` (CR8): rewrite every `openkan
    <cmd>` reference (lines 10, 30, 31, 33, 60, 77, 116, 150,
    151, 152, 153, 155) and every `bin/openkan.ts` /
    `bin/openkan.mjs` reference (lines 30, 31, 60, 116) to its
    `ok <cmd>` and `bin/ok.ts` / `bin/ok.mjs` /
    `ok/commands/serve.ts` equivalent. The narrative about
    the daemon lifecycle, the PID file, the log redirection,
    and the SIGTERM/SIGINT drain behaviour is unchanged —
    these are pure command-name substitutions.
- `docs/specs/ralplan/agent-profiles-and-mcp.md` (CR7): the
  format-reference doc keeps `name: openkan` brand, but every
  `openkan <cmd>` reference (notably `openkan onboard` at
  lines 62, 160, 180, 188 and `openkan mcp` at line 68, 207,
  and `bin/openkan.ts` at line 49) is rewritten to
  `ok onboard` / `ok mcp` / `bin/ok.ts` respectively. The
  narrative about profile schema, MCP transport, and the
  onboarding flow is unchanged. Add a brief footer note at
  the top of the doc — right under the frontmatter
  `related:` block — stating: "Revised for the 0.5.0 CLI
  rename: every `openkan <cmd>` reference below now uses
  `ok <cmd>`; the agent-name `openkan` and the project
  workspace `.ok/openkan.json` are unchanged." This keeps
  the doc self-explanatory for future readers who only see
  the file in isolation.
- `CHANGELOG.md`:
  - Add a new `## [0.5.0] - 2026-09-XX` section above
    `## [Unreleased]`.
  - Document the breaking change in `### Removed`:
    `- The \`openkan\` CLI command. Use \`ok\` for everything;
     \`ok\` accepts every subcommand the legacy \`openkan\`
     command did. \`openkan\` is no longer shipped in the
     @polderlabs/openkan package and no alias is provided.`
  - Move any 0.5.0 items out of `## [Unreleased]`.
  - Update the version comparison links block at the bottom to
    include a `[0.5.0]` line.

**Non-goals:**

- No content rewrites beyond command-name substitution.
- No deletion of milestone history.

**Files:**

- `skills/openkan/SKILL.md`
- `skills/openkan/references/api.md`
- `skills/openkan/agents/openai.yaml`
- `agents/openkan.md`
- `README.md`
- `CHANGELOG.md`
- `docs/OK-PLANNING.md`
- `docs/HOOKS.md`
- `docs/CHAT-SIDEBAR.md`
- `docs/RELEASING.md`
- `docs/chat-daemon-plan.md`
- `docs/README.mdx`
- `docs/milestones/M0.mdx` through `M11.mdx` (whatever exists;
  touched only where `openkan <cmd>` appears)
- `docs/specs/ralplan/agent-profiles-and-mcp.md` (the format
  reference, see CR7 sub-bullet above): rewrite every
  `openkan <cmd>` / `bin/openkan.ts` reference to
  `ok <cmd>` / `bin/ok.ts`; add a footer note under the
  frontmatter `related:` block stating the rename.

**Reuse:**

- `skills/openkan/SKILL.md` keeps its section structure; only the
  command names inside the prose and code blocks change.
- `agents/openkan.md` keeps its identity ("You are OpenKan, a
  project planning and delivery-management agent") and its
  `name: openkan` frontmatter.
- The existing test `tests/openkan-skill-content.test.mjs`
  asserts phrases like `default[- ]to[- ]openkan`,
  `openkan api`, and "do not curl". After M3 those assertions
  become `default[- ]to[- ]ok` and `ok api`. The test must be
  updated in M4 (with M3) so its gate does not block the migration.

**Acceptance criteria:**

- `grep -rE 'openkan\b' skills/openkan/` returns only matches that
  are intentional brand references (the directory name
  `skills/openkan/`, the frontmatter `name: openkan`, and phrases
  like "OpenKan" the product). Zero matches for `openkan <cmd>`
  patterns.
- `grep -rE 'openkan (start|serve|stop|status|open|config|logs|api|agent|reset|update|skill|import|board|project|init|task|plan|prd|goal|progress|doctor|index|migrate)' skills/ agents/ docs/ README.md CHANGELOG.md`
  returns zero matches.
- The skill frontmatter `name:` stays `openkan`.
- The agent file `agents/openkan.md` keeps `name: openkan`.

**Verification:**

- `git grep -nE 'openkan (start|serve|stop|status|open|config|logs|api|agent|reset|update|skill|import|board|project|init|task|plan|prd|goal|progress|doctor|index|migrate-from-openkan)\b' -- 'skills/' 'agents/' 'docs/' 'README.md' 'CHANGELOG.md'`
  returns zero results.
- Manual read-through of `skills/openkan/SKILL.md` confirms no
  stray `openkan <cmd>` line.

**DoD:**

- M3 acceptance criteria all pass.
- The skill no longer tells an agent to type `openkan …`.

### M4 — Update tests and add a migration gate

**Goal:** Add a fresh `tests/cli-migration.test.mts` that locks the
post-cutover invariants so a future regression that re-introduces
the `openkan` binary fails the gate. The 10 test-file rewrites of
`bin/openkan.ts` → `bin/ok.ts` references landed in M1's atomic
commit (see M1 Files list); they are not M4's work.

**Scope:**

- These 10 test-file rewrites of `bin/openkan.ts` → `bin/ok.ts` were
  moved to M1's atomic commit (see M1 Files list); they are not
  part of M4's work.

- **New file** `tests/cli-migration.test.mts`:
  - `test("package.json bin field exposes only ok", …)` reads
    `package.json` and asserts `Object.keys(pkg.bin)` deep-equals
    `["ok"]`.
  - `test("package.json bin points to bin/ok.mjs", …)` asserts
    `pkg.bin.ok === "bin/ok.mjs"`.
  - `test("package.json version is 0.5.0", …)` asserts the version.
  - `test("bin/openkan.ts is removed from the source tree", …)`
    `assert.equal(existsSync("bin/openkan.ts"), false)`.
  - `test("bin/openkan.mjs is removed from the source tree", …)`
    `assert.equal(existsSync("bin/openkan.mjs"), false)`.
  - `test("ok --version prints the package version", …)`
    spawns `node --experimental-strip-types bin/ok.ts --version`
    and asserts the stdout contains `0.5.0`.
  - `test("ok help enumerates the relocated commands", …)` spawns
    `node --experimental-strip-types bin/ok.ts help` and asserts
    the stdout contains `serve`, `start`, `stop`, `status`,
    `open`, `config`, `logs`, `api`, `agent`, `reset`, `update`,
    `skill`, `import`, `board`, `project`, `task`, `plan`, `prd`,
    `goal`, `progress`, `doctor`, `index`, `init`,
    `migrate-from-openkan`.
  - `test("npm pack --dry-run does not include bin/openkan.mjs",
    …)` shells out to `npm pack --dry-run --json`, parses the
    file list, and asserts no entry ends with `bin/openkan.mjs`
    or `bin/openkan.js`.
  - `test("install.sh links ok, not openkan", …)` reads `install.sh`
    and asserts the symlink target is `bin/ok.mjs` and that no line
    writes `${BIN_DIR}/openkan`.

**Non-goals:**

- No test deletions. Every test that exercised an `openkan`
  subcommand must exercise the same subcommand under `ok`.
- No `npm run test:package` signature change; only the
  inside-script paths change.

**Files:**

- `tests/cli-migration.test.mts` (new — the per-line
  rewrites of the 10 `bin/openkan.ts` / `openkan <cmd>`
  fixtures moved to M1's atomic commit; only the new test
  file that adds the `assert.equal(existsSync("bin/openkan.ts"),
  false)` gate plus the remaining migration gates
  (`package.json` `bin` field, version, `npm pack
  --dry-run`, `install.sh` symlink target) lives in M4)

**Note (iteration 5 — historical):**

These test-file rewrites (`tests/planning-commands.test.mjs` and
`tests/m19-profiles.test.mts`) were owned by M1's atomic commit
(see M1 Files list). Iteration 5 retires the per-line rewrite
instructions here so M4's scope carries only the new migration
gate. Cross-reference kept for reviewers tracing the cascade back
from round 4 to round 5.

**Note (iteration 5 — historical):**

This test-file rewrite (`tests/install-agent-prompt.test.mjs`) is
owned by M1's atomic commit (see M1 Files list). Iteration 5
retires the per-line rewrite instructions here so M4's scope
carries only the new migration gate. Cross-reference kept for
reviewers tracing the cascade back from round 4 to round 5.

**Reuse:**

- The existing `node:test` patterns from each file (tmpdir creation,
  `mkdtempSync`, `execSync`) apply unchanged; only the constants
  flip.
- The new `tests/cli-migration.test.mts` reuses the
  `spawnSync`/`execSync` style of `tests/cli-update-version.test.mjs`.

**Acceptance criteria:**

- `npm test` passes with the new and modified tests.
- `tests/cli-migration.test.mts` passes (new file).
- Every existing test that asserted `openkan <cmd>` behavior now
  asserts the same behavior under `ok <cmd>`.
- No test still references `bin/openkan.ts` or `bin/openkan.mjs`.

**Verification:**

- `git grep -n 'bin/openkan' -- 'tests/'` returns zero results.
- `node --test tests/cli-migration.test.mts` exits 0.
- `npm test` exits 0.
- `npm run check` exits 0.
- `npm run typecheck` exits 0.

**DoD:**

- M4 acceptance criteria all pass.
- Future regressions that re-add the `openkan` binary fail
  `tests/cli-migration.test.mts`.

### M5 — Release readiness and verification

**Goal:** The 0.5.0 release commit is green across every gate the
project defines. The release process produces an npm tarball that
ships `ok` and no `openkan`.

**Scope:**

- `npm run build` — verify `dist/bin/ok.js` exists, `dist/bin/openkan.js`
  does not.
- `npm run test:package` — confirms the packed tarball's
  `package.json` has `bin.ok` and no `bin.openkan`, links `ok`,
  and the start-server smoke test passes.
- `npm run check` — sanity-check green.
- `npm run typecheck` — no new errors.
- `npm test` — full suite green.
- `npm pack --dry-run` — final manual sanity check that the tarball
  contains `bin/ok.mjs` and not `bin/openkan.mjs`.
- `scripts/release.mjs` — confirm the `RELEASE_VERSION=0.5.0`
  override flows through without manual edits (it already restores
  the original `package.json` after the release; no change needed).
  **Precondition for the release engineer (also restated in M5
  acceptance criteria below):** `scripts/release.mjs` only
  auto-bumps the patch level; without `RELEASE_VERSION=0.5.0`
  the script computes `0.4.10` from the current `0.4.9`
  `latest` tag and publishes a patch release with the
  migration in it — which is wrong. The release engineer MUST
  run the publish step as
  `RELEASE_VERSION=0.5.0 RELEASE_CHANNEL=stable
  RELEASE_SHA=<release-commit-sha> npm run release`
  (or the equivalent dry-run first), so the override path
  writes `0.5.0` to `package.json` and the auto-bump path is
  not taken.
- `CHANGELOG.md` — final review of the 0.5.0 section.

**Non-goals:**

- No actual `npm publish` or `gh release create` invocation from
  this plan. The user drives release. The release commit on `main`
  is the deliverable; the publish is a follow-up human-approved step.

**Files:**

- `package.json` (verified; no new edits expected)
- `CHANGELOG.md` (final review)
- `package-lock.json` (regenerated by `npm install` if dependencies
  changed — none expected)
- `.github/workflows/release.yml` (modify: drop `push:` trigger;
  retain `workflow_dispatch` only — per R-NEW-1 step (b))

**Reuse:**

- The Makefile-style target sequence
  `npm run check && npm test && npm run build && npm run test:package`
  is the same one used for prior releases; no new automation.

**Acceptance criteria:**

- `npm run build` succeeds; `dist/bin/ok.js` exists.
- `npm run test:package` succeeds.
- `npm test` succeeds.
- `npm run check` succeeds.
- `npm run typecheck` succeeds.
- `npm pack --dry-run --json` lists `bin/ok.mjs` and lists no
  `bin/openkan.mjs`.
- `gh workflow view release.yml | grep -A2 'on:'` confirms only
  `workflow_dispatch:` is present (no `push:` trigger).
- **Release precondition (release engineer only):** the
  publish step is invoked with
  `RELEASE_VERSION=0.5.0 RELEASE_CHANNEL=stable
  RELEASE_SHA=<release-commit-sha>` so the `0.5.0` minor
  bump reaches `package.json` via the override path. Without
  this, `scripts/release.mjs` computes `0.4.10` from the
  current `0.4.9` `latest` tag and publishes a patch release
  that contains the migration, breaking cross-phase gate 1
  (`"version": "0.5.0"`). A dry-run with the same env vars
  (`RELEASE_DRY_RUN=true …`) must print
  `nextVersion: 0.5.0` before the live publish.

**Verification:**

- Run the full Makefile target sequence locally; all gates green.
- Manual smoke: `npm install -g .` then `ok --version` prints
  `0.5.0` and `openkan --version` returns `command not found`.
- Verify with `gh workflow view release.yml` that the workflow
  triggers only on `workflow_dispatch` and no longer on `push:`
  to main or beta.

**DoD:**

- All gates green on the release commit.
- The release commit is ready for the human-approved
  `npm publish` / `gh release create` step.

## 6. Definition of done (cross-phase gates)

The plan is complete when **all** of the following hold on the
release commit:

1. `package.json` declares
   `"version": "0.5.0"` and
   `"bin": { "ok": "bin/ok.mjs" }`.
2. The source tree contains `bin/ok.ts`, `bin/ok.mjs`,
   `bin/tray.ts`, `bin/install-agent.mjs`, `bin/ok-install.ts`,
   `bin/assets/`, and `ok/commands/serve.ts` (plus the existing
   `ok/commands/*.ts` files plus the new `ok/commands/config.ts`,
   `ok/commands/logs.ts`, `ok/commands/api.ts`,
   `ok/commands/agent.ts`, `ok/commands/reset.ts`,
   `ok/commands/update.ts`, `ok/commands/skill.ts`,
   `ok/commands/board.ts`, `ok/commands/project.ts`,
   `ok/commands/import.ts`).
3. The source tree contains **no** `bin/openkan.ts` and **no**
   `bin/openkan.mjs`.
4. `install.sh` links `${BIN_DIR}/ok` (not `${BIN_DIR}/openkan`)
   and prints `Command:     ${BIN_DIR}/ok` on success.
5. `bin/install-agent.mjs` log lines start with `[ok]` and the
   retry hint is `Run \`ok skill install\` to retry.`.
6. `skills/openkan/SKILL.md`,
   `skills/openkan/references/api.md`,
   `skills/openkan/agents/openai.yaml`, `agents/openkan.md`,
   `README.md`, `CHANGELOG.md`, and every file under `docs/` that
   mentioned `openkan <cmd>` has been rewritten to use `ok <cmd>`.
   The skill name `name: openkan` and the agent name
   `name: openkan` stay.
7. `CHANGELOG.md` contains a new `## [0.5.0]` section that
   documents the breaking change in the `### Removed` block.
8. `npm run build`, `npm run check`, `npm run typecheck`,
   `npm test`, `npm run test:package` all succeed.
9. `npm pack --dry-run` lists `bin/ok.mjs` and does not list
   `bin/openkan.mjs` or `bin/openkan.js`.
10. `tests/cli-migration.test.mts` passes; every existing test
    that previously invoked `bin/openkan.ts` now invokes
    `bin/ok.ts` and passes under that invocation.
11. `npm install -g @polderlabs/openkan` (or `npm install -g .`
    from this checkout) places `ok` on `$PATH` and does not place
    `openkan` on it.
12. `ok --version`, `ok help`, `ok serve`, `ok start`,
    `ok stop`, `ok status`, `ok open`, `ok config …`,
    `ok logs …`, `ok api …`, `ok agent …`, `ok reset …`,
    `ok update …`, `ok skill …`, `ok task …`, `ok plan …`,
    `ok prd …`, `ok goal …`, `ok progress`, `ok doctor`,
    `ok index`, `ok init`, `ok migrate-from-openkan`,
    `ok board …`, `ok project …`, `ok import` all behave
    identically to the equivalent pre-cutover `openkan …`
    invocations.
13. The release commit on `main` is signed off and ready for
    human-approved `npm publish` and `gh release create`.

## 7. Risks and approval boundaries

### 7.1 Risks

- **Skill/text drift after release.** A user that copied
  `skills/openkan/SKILL.md` into their own config before M3 lands
  on their machine will keep typing `openkan …`. Mitigation: the
  shipped skill (`skills/openkan/SKILL.md`) is the canonical
  contract; `ok skill install` overwrites it on every install.
  The new `tests/cli-migration.test.mts` proves the shipped skill
  no longer says `default to openkan`.
- **Agent test snapshots.** `tests/openkan-skill-content.test.mjs`
  asserts `default[- ]to[- ]openkan`. If it is not updated in M4,
  the migration commit will fail the test gate. M4 owns this edit
  alongside the SKILL.md edit so they land together.
- **Third-party scripts / CI that pin `openkan` in package.json
  scripts.** A consumer of `@polderlabs/openkan` who wrote
  `"scripts": { "plan": "openkan task list" }` will see
  `command not found` after upgrading. This is the intended hard
  cutover; documented in `CHANGELOG.md` 0.5.0 `### Removed`.
  The README's quick-start updates to `ok` first; users following
  the README do not hit this.
- **npm publish race.** If `0.5.0` is published before the docs
  PRs in M3 land, the README on npm will still say `openkan …`.
  Mitigation: M3 lands before M5 final; the release commit
  contains M3's changes.
- **The `migrate-from-openkan` command name keeps `openkan` in it.**
  This is intentional — it imports a legacy `.openkan/`
  workspace into the new `.ok/` layout. Renaming it would break
  discoverability for users migrating. It is a one-shot command,
  not a daily driver.
- **R-NEW-1 (release workflow double-publish):**
  `.github/workflows/release.yml` triggers on both
  `push: branches: [main, beta]` AND `workflow_dispatch`.
  Pushing the `0.5.0` release tag could double-publish if a
  backport commit lands on `main` between the version-bump
  commit and the tag push. Mitigation: (a) the release
  engineer MUST confirm `git log main` shows no concurrent
  `0.4.x` patch backport before tagging `0.5.0`; (b) the
  workflow file should be updated in M5 to disable the
  `push:` trigger for releases, retaining only
  `workflow_dispatch` for manual releases. Verify with
  `gh workflow view release.yml` before the M5 release.
  The `schedule:` trigger is intentionally retained for the nightly
  channel release cadence (lines 6-7 of the workflow file) and does
  not contribute to the double-publish risk. R-NEW-1 mitigation
  targets the `push:` and `workflow_dispatch:` triggers only.

### 7.2 Approval boundaries (HITL floor)

The Bizar HITL floor applies. This plan touches the following:

- **Public API breakage (yes, intentional).** The `openkan` CLI
  command is removed. Documented in the CHANGELOG `### Removed`
  block. The human approves the publish step.
- **Destructive operation:** none. Schema rejects unknown values
  rather than mutating them; no file deletion outside the source
  tree.
- **Auth / security:** none. The loopback-only API surface is
  unchanged.
- **Migration:** none this plan. `ok migrate-from-openkan` is
  untouched and remains available for `.openkan/` → `.ok/`
  legacy imports.
- **Compliance / PII:** none. Local-only.
- **Production incident:** n/a. Local tool.
- **Irreversible destruction:** the release commit is reversible
  via git revert; the npm publish itself is a one-way door that
  the human approves per the Bizar seven-category floor.

`git commit` and `git push` to `main` are silent-allowed under the
existing `permissions.allow`. `npm publish` and
`gh release create` are gated by the existing
`permission-request.mjs` hook and require explicit human approval.

## 8. Stop condition

Plan-only. The orchestrator persists this spec at
`docs/specs/ralplan/ok-migration.md`, records the run identity in
`.ok/`, and does not invoke any implementation skill. M1 dispatch
is gated on user approval after spec review.

## 9. Iteration 2 changes

This section summarizes the changes made in the iteration-2
planner pass against the critic's `CHANGES REQUIRED` verdict.
The four major findings (CR1-CR4) are addressed with explicit
edits; the five minors (CR5-CR9) are folded into the
relevant phases.

### 9.1 CR1 — Two tests that hardcode `bin/openkan.ts`

`tests/planning-commands.test.mjs` (line 11) and
`tests/m19-profiles.test.mts` (lines 285, 299) were missing
from the M4 `Files:` list. Both files hardcode the path
`bin/openkan.ts` to spawn the CLI; after M2 that path is
gone, so the tests would fail with `ENOENT` even though the
test logic itself is fine.

- `tests/planning-commands.test.mjs` line 11
  (`fileURLToPath(new URL('../bin/openkan.ts', import.meta.url))`)
  → `'../bin/ok.ts'`. The tmpdir label
  `'openkan-planning-'` (line 19) stays as a tmp-dir name,
  not a CLI name.
- `tests/m19-profiles.test.mts` lines 285 and 299 both
  redefine `const CLI = \`node --experimental-strip-types
  ${join(PROJECT_ROOT, "bin", "openkan.ts")}\`` — switched to
  `${join(PROJECT_ROOT, "bin", "ok.ts")}` in both tests.
  Tmpdir labels at lines 286 and 300 stay as
  `'openkan-m19-cli-'`.

Both tests are now in the M4 `Files:` list with explicit
per-line edit instructions.

### 9.2 CR2 — `tests/install-agent-prompt.test.mjs`

Line 64 asserts `/openkan agent install/` against the
stdout of `bin/install-agent.mjs`. M2 rewrites that hint
to `Run \`ok skill install\` to retry.` (per the M2
`bin/install-agent.mjs` section), so the assertion must
change to `/ok skill install/`. Lines 65-66 were re-checked
and only assert file presence (`agents/openkan.md`,
`skills/openkan/SKILL.md`); both are brand filenames, not
CLI command names, and stay unchanged.

### 9.3 CR3 — `scripts/release.mjs` cannot auto-bump to 0.5.0

The script's `bumpPatch` (line 68) only knows patch
increments. With the current npm `latest` at `0.4.9`,
`RELEASE_CHANNEL=stable` without `RELEASE_VERSION` computes
`0.4.10` — a patch release, NOT `0.5.0`. The
`RELEASE_VERSION` override path (line 91) DOES parse
`0.5.0` as semver, but the auto-bump path never reaches it.

The prior spec conflated the override path (which parses
`0.5.0`) with the auto-bump path (which produces `0.4.10`).
Iteration-2 rewrites the M2 `scripts/release.mjs` section
to state this plainly and adds an explicit precondition
in the M5 acceptance criteria:
`RELEASE_VERSION=0.5.0 RELEASE_CHANNEL=stable
RELEASE_SHA=<commit-sha>` — without this override the
release engineer would publish `0.4.10`, breaking
cross-phase gate 1 (`"version": "0.5.0"`). A dry-run with
the same env vars must print `nextVersion: 0.5.0` before
the live publish.

### 9.4 CR4 — `tests/openkan-skill-content.test.mjs`

The prior narrow bullet listed only two assertion
changes (`default-to-openkan` → `default-to-ok`, and
`openkan api` → `ok api`). The file actually has seven
`openkan <cmd>` regex anchors (lines 92, 109, 116, 120,
121, 122). Iteration-2 replaces the narrow bullet with a
full per-line rewrite:

- `default-to-openkan` directive assertion (line 63) →
  `default-to-ok`.
- `openkan api` curl-replacement assertion (line 92) →
  `ok api`.
- `openkan board add` (line 109) → `ok board add`.
- `openkan init` (line 116) → `ok init`.
- `openkan task add` (line 120) → `ok task add`.
- `openkan task claim` (line 121) → `ok task claim`.
- `openkan task complete` (line 122) → `ok task complete`.

The describe-block label at line 60 (the "default to
openkan" directive test) is updated to match. The
`name: openkan` brand assertion (line 40), the `Do not
curl` reminder (line 50), and the `references/api.md`
link (line 126) all stay unchanged. A new regression
assertion is added to guard against a future copy-paste
that re-introduces a bare `openkan <cmd>` directive in
the first 30 body lines.

### 9.5 CR5 — M1 DoD line 283 wording

> **Note (iteration 5):** the wording below quotes an M1
> design that was abandoned in iteration 4. Iteration 4
> deleted the shim entirely; see section 9.12 for the
> surviving M1 design.

Rewrote the M1 DoD line from
`No behavior change observable to a user running the CLI.`
to
`No behavior change observable to a user running the CLI
except that \`openkan --help\` now prints the \`ok\`-flavoured
catalogue table (the \`bin/openkan.ts\` shim re-exports
\`printHelp\` from \`bin/ok.ts\`, so the catalogue visible
under \`openkan --help\` is the new \`ok <command>\` form).
All other subcommands still produce byte-identical stdout,
stderr, and exit codes.`
This makes the one observable behavior change explicit
(the help-text catalogue) so reviewers don't have to
deduce it from the shim description.

### 9.6 CR6 — Stale `bin/openkan.ts` comments

Added a comment-only cleanup bullet under M1's Reuse
section. The files `bin/tray.ts` (header comment lines
69-70, `openkan stop` line 188, `openkan tray:` stderr
prefixes at lines 189 and 206), `bin/ok.ts` (header
comment at line 4 about `bin/openkan.ts shape`; the
`\`openkan --help\`` reference in `printHelp` at line 22),
and `bin/ok.mjs` (header comment line 3 `Mirrors
bin/openkan.mjs`) all carry stale `bin/openkan.ts`
references. These land as comment-only edits alongside
the M2 file deletions so reviewers see them in the same
commit and the deleted-binary story is self-consistent.

### 9.7 CR7 — `docs/specs/ralplan/agent-profiles-and-mcp.md`

The format-reference doc keeps the `name: openkan` brand
but every `openkan <cmd>` reference (notably `openkan
onboard` at lines 62, 160, 180, 188, `openkan mcp` at
lines 68, 207, and `bin/openkan.ts` at line 49) is
rewritten to `ok onboard` / `ok mcp` / `bin/ok.ts`. A
brief footer note under the frontmatter `related:` block
records the rename for future readers. Iteration-2 adds
this to the M3 `Files:` bullet for
`docs/specs/ralplan/agent-profiles-and-mcp.md`.

### 9.8 CR8 — `docs/chat-daemon-plan.md`

The doc has 13 `openkan` references (lines 10, 30, 31,
33, 60, 77, 116, 150, 151, 152, 153, 155) plus four
`bin/openkan.ts` / `bin/openkan.mjs` references (lines
30, 31, 60, 116). Iteration-2 adds an explicit M3
sub-bullet that rewrites every `openkan <cmd>` and
`bin/openkan.ts` reference to `ok <cmd>` and `bin/ok.ts` /
`bin/ok.mjs` / `ok/commands/serve.ts` equivalents,
preserving the narrative about the daemon lifecycle, the
PID file, the log redirection, and the SIGTERM/SIGINT
drain behaviour unchanged.

### 9.9 CR9 — Release-engineer-only note

No spec change. The release engineer runs the publish
step with the `RELEASE_VERSION=0.5.0` override per CR3;
this is enforced by the M5 acceptance criterion and the
M2 `scripts/release.mjs` precondition, not by the spec
itself.

### 9.10 Verification trail

Each edit was verified against the actual file contents
in the working tree before the spec edit was written:

- `tests/planning-commands.test.mjs` line 11:
  `const cli = fileURLToPath(new URL('../bin/openkan.ts', import.meta.url));`
  — confirmed.
- `tests/m19-profiles.test.mts` lines 285 and 299:
  `const CLI = \`node --experimental-strip-types ${join(PROJECT_ROOT, "bin", "openkan.ts")}\`;`
  in the `cmdOnboard` and `cmdMcp` stub tests — confirmed.
- `tests/install-agent-prompt.test.mjs` line 64:
  `assert.match(result.stdout, /openkan agent install/);`
  — confirmed (and lines 65-66 confirmed not to pin a
  CLI name).
- `tests/openkan-skill-content.test.mjs`: 7 `openkan <cmd>`
  regex anchors at lines 92, 109, 116, 120, 121, 122, plus
  the `default-to-openkan` directive assertion at line 63 —
  all confirmed.
- `scripts/release.mjs`: `bumpPatch` function at line 68
  is the only auto-bump path; lines 91-99 are the override
  selection (`if (forcedVersion) … else if (channel ===
  'stable') nextVersion = bumpPatch(latestTag); …`) —
  confirmed: with no `forcedVersion` and `channel=stable`
  on `0.4.9`, the result is `0.4.10`, not `0.5.0`.
- `bin/install-agent.mjs`: the actual string on lines
  178, 185, 192, 194, 198, 205, 207 contains `openkan
  agent install`, confirming the test assertion at line 64
  is bound to a string M2 changes.
- `bin/tray.ts`, `bin/ok.ts`, `bin/ok.mjs`: stale
  `bin/openkan.ts` references confirmed at lines 69-70,
  188, 189, 206, 247 (`tray.ts`); lines 4, 22 (`ok.ts`);
  line 3 (`ok.mjs`).
- `docs/specs/ralplan/agent-profiles-and-mcp.md`:
  `openkan onboard` references at lines 62, 160, 180, 188;
  `openkan mcp` at lines 68, 207; `bin/openkan.ts` at
  line 49 — confirmed.
- `docs/chat-daemon-plan.md`: 13 `openkan` references at
  lines 10, 30, 31, 33, 60, 77, 116, 150, 151, 152, 153,
  155 — confirmed.


### 9.11 Iteration 3 — CR7 contradiction fix

Replaced the M3 Files-list line for
`docs/specs/ralplan/agent-profiles-and-mcp.md` with a
directive that mirrors the CR7 sub-bullet in the M3
Scope section, so a worker reading only the Files list
performs the same `openkan <cmd>` / `bin/openkan.ts`
rewrite + footer-note addition described in the Scope.
No other sections touched.

### 9.12 Iteration 4 — M1 shim removal per user choice

The user explicitly chose **option "M1 deletes `bin/openkan.ts`
immediately"** over "M1 keeps shim, M2 deletes it". Their
verbatim description:

> M1 deletes `bin/openkan.ts` immediately along with the
> relocation. No transitional shim. M2 becomes a smaller
> diff (just package.json `bin` field flip + version bump
> + docs/test updates). Risk: M1 is a larger atomic commit
> that combines relocation + deletion; harder to bisect if
> M1 breaks.

**Diff scope:**

- **M1 Scope (lines 207-211 of the prior round).** Deleted the
  `kept in this milestone as a compatibility shim` paragraph.
  Replaced it with a 6-line note stating that M1 deletes
  `bin/openkan.ts` together with the relocation, that there
  is no transitional shim, and that the published
  `bin/openkan.mjs` is still dropped in M2 (since M1 only
  handles the source relocation + deletion).
- **M1 Files list (line 233).** Replaced the
  `bin/openkan.ts (modify: become a thin shim …)` line with
  `bin/openkan.ts (delete — combined with the relocation;
  no shim)`.
- **M1 Acceptance criteria (lines 274-275).** Rewrote the
  "`bin/openkan.ts` still exists at the end of M1" criterion
  to "`M1 deletes `bin/openkan.ts`; running
  `node --experimental-strip-types bin/openkan.ts …`
  returns `Cannot find module` (expected)`".
- **M1 Manual smoke (lines 287-288).** Deleted the
  `node --experimental-strip-types bin/openkan.ts --version`
  smoke line. Replaced with: "`node --experimental-strip-types
  bin/ok.ts --version` is the only entry point now (the old
  `bin/openkan.ts` path is gone — `node … bin/openkan.ts …`
  must report `Cannot find module`)."
- **M1 DoD (lines 296-299).** Rewrote the three-line
  shim-flavoured DoD text. The new DoD states that `openkan`
  is no longer a valid command after M1 lands, that the only
  entry point is `ok`, and that the diff is reviewable as
  relocation + deletion.
- **M2 Goal + scope trim.** Added a 7-line lead-in note to M2
  explaining that M2 is now a smaller follow-up because M1
  already performed the relocation + deletion. Removed
  `bin/openkan.ts` from the M2 Scope deletion list (it's
  already gone from M1). Removed the `bin/openkan.ts (delete)`
  line from the M2 Files list, leaving only
  `bin/openkan.mjs (delete — published shim)`. Rewrote the M2
  acceptance criterion about file absence to clarify that
  `bin/openkan.ts` was deleted in M1 and M2 only needs to
  confirm absence.
- **Section 4.2 layout target.** Updated the two-line
  diagram so `openkan.ts` shows `DELETED in M1` (was
  `DELETED in M2`) and `openkan.mjs` shows `DELETED in M2`.
- **Section 9.5 CR5 supersession note.** The CR5
  historical entry (added in iteration 2) described the
  old shim-based M1 DoD wording. That wording no longer
  exists in M1 — the new M1 DoD (written by iteration 4)
  is the source of truth. The CR5 entry is retained as a
  historical record of what iteration 2 produced, but
  iteration 4 supersedes it.

See the M2 Goal lead-in above for the surviving M2
scope and the rationale that M2 is now a smaller follow-up
because M1 already performed the relocation + deletion.
The full list of artifacts M2 owns (the `package.json`
`bin` field flip, the `bin/openkan.mjs` deletion, the
`version` bump, the `install.sh` / `README` /
`CHANGELOG` / `scripts/release.mjs` / `bin/install-agent.mjs`
updates, and the `bin/ok.mjs` header-comment rewrite added
in iteration 5) lives in section M2 Goal + M2 Files.

### 9.13 Iteration 5 — propagate M1 deletion cascade per critic round 4

The critic round 4 found that iteration 4's conceptual
choice — "M1 deletes `bin/openkan.ts` immediately, no
shim" — was not propagated through the rest of the spec.
The seven CR-NEW fixes below close that cascade.

**Diff scope:**

- **CR-NEW-1 (CRITICAL) — Test-file rewrites moved from
  M4 into M1.** The 10 files that hardcode `bin/openkan.ts`
  or `openkan <cmd>` (`tests/cli.test.mjs`,
  `tests/cli-update-version.test.mjs`,
  `tests/cli-qa-fixes.test.mjs`,
  `tests/qa-cli-fixes.test.mts`,
  `tests/serve-cli.test.mjs`, `tests/install.test.mts`,
  `tests/planning-commands.test.mjs`,
  `tests/m19-profiles.test.mts`,
  `tests/install-agent-prompt.test.mjs`,
  `tests/openkan-skill-content.test.mjs`) moved from the
  M4 Files list into the M1 Files list. Rationale: M1
  deletes `bin/openkan.ts` and the test files reference
  it; if the rewrites stayed in M4, the M1 commit would
  fail `npm test` with `ENOENT` even though the
  relocation is logically correct. The M4 Files list
  now contains only `tests/cli-migration.test.mts` (new),
  which adds the remaining migration gates
  (`package.json` `bin` field, version, `npm pack
  --dry-run`, `install.sh` symlink target).
- **CR-NEW-2 (MAJOR) — Comment-only cleanup split across
  M1 and M2.** The M1 Reuse section now spells out that
  M1 owns the comment-only edits to `bin/tray.ts` (header
  comment at lines 69-70, `openkan stop` at line 188,
  `openkan tray:` stderr prefixes at lines 189 and 206,
  `defaultIconDir` at line 247) and to `bin/ok.ts`
  (header comment at line 4, `\`openkan --help\`` reference
  in `printHelp` at line 22). M2 owns the comment-only
  edit to `bin/ok.mjs` (header comment at line 3: `Mirrors
  bin/openkan.mjs` → `Mirrors bin/ok.mjs`). The split
  matches the actual file-deletion ownership: M1 deletes
  `bin/openkan.ts`, M2 deletes `bin/openkan.mjs`.
- **CR-NEW-3 (MAJOR) — Affected files added to Files
  lists.** M1 Files list now includes `bin/tray.ts`
  (modify: rewrite header and stderr references; see M1
  Reuse section). M2 Files list now includes
  `bin/ok.mjs` (modify: rewrite header comment `Mirrors
  bin/openkan.mjs` → `Mirrors bin/ok.mjs`).
- **CR-NEW-7 (MAJOR) — Automated test duplicated in M1's
  atomic commit.** The `bin/openkan.ts` absence gate
  (`tests/cli-migration.test.mts`, the
  `assert.equal(existsSync('bin/openkan.ts'), false)`
  test) is added to the M1 Files list with a duplicate
  guard in M1's commit. This protects the gap between M1
  landing and M4 landing: if M1 is reverted while M4 is
  still in flight, `npm test` fails immediately. M1
  Verification section now lists the 10 rewritten test
  files plus this absence test as the M1 automated gate.
- **CR-NEW-4 (MINOR) — CR5 historical entry annotated.**
  Section 9.5 now opens with an iteration-5 note:
  "the wording below quotes an M1 design that was
  abandoned in iteration 4. Iteration 4 deleted the shim
  entirely; see section 9.12 for the surviving M1
  design." This pre-empts reviewer confusion about the
  shim-flavoured wording that iteration 2 originally
  produced and iteration 4 superseded.
- **CR-NEW-5 (MINOR) — Duplicate "M2 is smaller"
  narrative collapsed.** The 7-line narrative that
  appeared both at the M2 Goal lead-in and at the end of
  section 9.12 is now collapsed: the M2 Goal lead-in is
  the canonical source; the section 9.12 closing
  paragraph is reduced to a one-line cross-reference
  ("See the M2 Goal lead-in above for the surviving M2
  scope and the rationale that M2 is now a smaller
  follow-up because M1 already performed the relocation
  + deletion"). The full list of M2 artifacts (including
  the new `bin/ok.mjs` header-rewrite entry added in
  CR-NEW-3) lives in the M2 Files list.
- **CR-NEW-6 (MINOR UNVERIFIED) — R-NEW-1 added to
  Risks.** Section 7.1 Risks now includes
  "R-NEW-1 (release workflow double-publish)" describing
  the `.github/workflows/release.yml` failure mode where
  `push: branches: [main, beta]` and `workflow_dispatch`
  triggers can both fire for the same `0.5.0` release if
  a backport lands on `main` between the version-bump
  commit and the tag push. Mitigation steps:
  (a) the release engineer MUST confirm `git log main`
  shows no concurrent `0.4.x` patch backport before
  tagging `0.5.0`; (b) the workflow file should be
  updated in M5 to disable the `push:` trigger for
  releases, retaining only `workflow_dispatch` for manual
  releases. Verify with `gh workflow view release.yml`
  before the M5 release.

**Intact from prior iterations:**

- The round-3 CR7 fix (section 9.11 — replaced the M3
  Files-list line for
  `docs/specs/ralplan/agent-profiles-and-mcp.md` with a
  directive that mirrors the CR7 sub-bullet) is intact.
- The round-4 shim removal (section 9.12 — "M1 deletes
  `bin/openkan.ts` immediately, no transitional shim")
  is intact. Section 9.12 retains the historical
  record of what iteration 2 produced and notes the
  iteration-4 supersession; iteration 5 narrows the
  closing summary to a cross-reference rather than
  duplicating the M2 Goal lead-in.
- The M1 atomic-commit acceptance criterion ("M1 deletes
  `bin/openkan.ts`; running
  `node --experimental-strip-types bin/openkan.ts …`
  returns `Cannot find module` (expected) and the
  existing `npm test` suite passes") is intact. The
  "existing `npm test`" wording now relies on the 10
  rewritten test files plus the duplicate
  `tests/cli-migration.test.mts` guard added in M1's
  Files list.

**Iteration cap reached.** This is iteration 5 of 5.
After this round the plan MUST be approved by the user
or the workflow fails. The spec is ready for review.

### 9.14 Direct patch per user choice — apply 5 round-5 critic fixes

Round 5 of ralplan reached the iteration cap with verdict
`CHANGES REQUIRED` (2 CRITICAL + 2 MAJOR + 1 MINOR + 3
UNVERIFIED). The user explicitly chose the **"Direct patch +
re-review"** path over a new planner/critic cycle: apply the 5
outstanding mechanical fixes by hand, then send the spec back for
a single Linda critic re-review pass.

The 5 fixes landed in this patch:

- **F1 (M4 Scope):** Removed the 7 stale per-line rewrite bullets
  for `tests/cli.test.mjs`, `tests/cli-update-version.test.mjs`,
  `tests/cli-qa-fixes.test.mjs`, `tests/qa-cli-fixes.test.mts`,
  `tests/serve-cli.test.mjs`, `tests/install.test.mts`, and
  `tests/openkan-skill-content.test.mjs`. Replaced with a single
  cross-reference sentence pointing at M1's atomic commit.
- **F2 (M4 CR1/CR2 sub-bullets):** Retired the historical
  per-line rewrite instructions for `tests/planning-commands.test.mjs`,
  `tests/m19-profiles.test.mts`, and `tests/install-agent-prompt.test.mjs`.
  Each sub-bullet now leads with `**Note (iteration 5 —
  historical):**` and resolves to a single cross-reference back
  at M1's Files list.
- **F3 (M4 Goal):** Rewrote the lead-in so the new
  `tests/cli-migration.test.mts` gate comes first, and the 10
  rewrites are flagged as already-landed M1 work rather than M4
  scope.
- **F4 (M5 release.yml):** Per R-NEW-1 step (b), added
  `.github/workflows/release.yml` to M5's Files list (drop the
  `push:` trigger, retain only `workflow_dispatch`), plus matching
  acceptance and verification bullets so the release engineer
  cannot accidentally ship the double-publish path.
- **F5 (frontmatter inputs):** Extended the `inputs:` list from
  7 to 11 test files so the frontmatter matches the full spec:
  `tests/cli.test.mjs, tests/cli-update-version.test.mjs,
  tests/cli-qa-fixes.test.mjs, tests/qa-cli-fixes.test.mts,
  tests/serve-cli.test.mjs, tests/install.test.mts,
  tests/planning-commands.test.mjs, tests/m19-profiles.test.mts,
  tests/install-agent-prompt.test.mjs,
  tests/openkan-skill-content.test.mjs, tests/cli-migration.test.mts`.

Sections 9.11 (CR7), 9.12 (M1 shim removal record), and 9.13
(round-4 cascade propagation) are preserved unchanged. The
structural decisions captured there (brand-name preservation,
`openkan` keeps owning the skill/agent/MCP naming, M1's atomic
commit performs the deletion with no transitional shim) all still
hold.

The next step is a single Linda critic re-review pass against
this patched spec, not another full ralplan cycle. After Linda's
verdict, the user reviews the patch and either approves or sends
the spec back for further iteration.

### 9.14b Linda re-review pass — apply 3 reviewer findings

The Linda re-review verdict on the iteration-5 patch was
`CHANGES REQUIRED` (1 MAJOR + 1 CRITICAL + 1 MINOR). Mechanical
cleanup applied by hand per the user's "Direct patch + re-review"
choice — three reviewer findings addressed, plus confirmation that
UNVERIFIED-2 (workflow triggers) was reaffirmed during re-review.

The 3 fixes landed in this patch:

- **M1 (MAJOR) — cross-reference count corrected.** Line 717
  was updated from "These 7 test-file rewrites" to "These 10
  test-file rewrites" so the M4 Scope cross-reference matches
  the actual M1 ownership: the 7 rewrites from F1 plus the 3
  rewrites from F2 (`tests/planning-commands.test.mjs`,
  `tests/m19-profiles.test.mts`,
  `tests/install-agent-prompt.test.mjs`).
- **C1 (CRITICAL, pre-existing) — install-script-prompt.test.mts
  added to M2.** The file's line 146 assertion
  (`/openkan agent install/`) was not in M1's or M2's Files
  list, but M2 changes `bin/install-agent.mjs` (per section 9.2
  lines 1224-1227) and the assertion is bound to that string.
  Added the file to M2's Files list with explicit line-146
  rewrite instructions, plus a matching acceptance criterion
  asserting the rewrite landed.
- **m1 (MINOR) — `schedule:` trigger clarified in R-NEW-1.**
  R-NEW-1 (section 7.1 Risks) described the release.yml
  double-publish risk in terms of `push:` + `workflow_dispatch:`
  but the workflow file also has
  `schedule: cron: '17 2 * * *'` for nightly releases. Added
  an explicit clarification that the `schedule:` trigger is
  intentionally retained (lines 6-7 of the workflow file) and
  does not contribute to the double-publish risk; R-NEW-1
  mitigation targets the `push:` and `workflow_dispatch:`
  triggers only.

UNVERIFIED-2 was reaffirmed during the Linda re-review pass.
Sections 9.11 (CR7), 9.12 (M1 shim removal record), 9.13
(round-4 cascade propagation), and 9.14 (round-5 direct patch)
are intact and unchanged in this cleanup pass. The next step
remains a Linda re-review verdict on this patched spec.
