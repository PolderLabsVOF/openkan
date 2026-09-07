# Release process

OpenKan ships from three long-lived branches that map to three npm release
channels. Releases are **scheduled** (nightly against `dev`) or **manually
dispatched** (any channel from any branch). A push to a long-lived branch
does **not** trigger a release; pushes only run CI.

The release workflow runs the full CI matrix (Node 22 and 24) against the
exact commit SHA before publishing, fails closed when npm trusted publishing
is not configured, and never uses a long-lived npm token.

## Branches and channels

| Branch | Channel | npm dist-tag | Triggered by |
| --- | --- | --- | --- |
| `main` | `stable` | `latest` | Manual `workflow_dispatch` with `channel=stable` |
| `beta` | `beta` | `beta` | Manual `workflow_dispatch` with `channel=beta` |
| `dev` | `nightly` | `nightly` | Cron at 02:17 UTC, plus manual `workflow_dispatch` |

`main` is the default visitor branch and only receives stable release work.
`dev` is the active-development branch and the only branch whose tip is
published on a schedule.

## Promotion flow

Promote changes through merge pull requests in this order:

```text
feature branch -> dev -> beta -> main
```

Merge each promotion pull request with `git merge --no-ff`; never squash a
promotion merge. The release branch must contain the same commits that
passed the preceding channel. Contributors start feature branches from
`dev`; only stable release work lands on `main`.

Each promotion pull request runs CI on Node 22 and 24 but does **not**
publish a release. Releases happen only when the release workflow is
dispatched (manually or by cron).

## Versioning

`scripts/release.mjs` computes the next version from the current `latest`
dist-tag on npm:

| Channel | Formula | Example |
| --- | --- | --- |
| `stable` | bump patch of the latest npm version | `0.5.0` → `0.5.1` |
| `beta` | bump patch, append `-beta.<n>` (monotonic) | `0.5.1-beta.1` → `0.5.1-beta.2` |
| `nightly` | latest version + `-nightly.<UTC YYYYMMDD>` | `0.5.0-nightly.20260907` |

A `workflow_dispatch` run can override the auto-computed version by setting
the `version` input (or `RELEASE_VERSION` env). This is the supported path
for stable minor or major releases. The script rejects any version that
already exists on npm, so retries cannot publish duplicates.

## Triggers and operations

### Nightly cron

The release workflow runs on a schedule:

```yaml
schedule:
  - cron: '17 2 * * *'
```

It fires daily at 02:17 UTC. The `source` job maps the `nightly` channel
to `dev`, checks out the tip of `dev`, and pins the SHA. `verify` then
runs CI on that exact SHA, and `publish` packs and publishes under the
`nightly` dist-tag. GitHub cron can be delayed under load and may be
disabled after 60 days of repository inactivity. See
+[scheduled workflow documentation](https://docs.github.com/actions/reference/events-that-trigger-workflows#schedule).

### Manual dispatch

Trigger a release from the Actions tab: select **Release**, then
**Run workflow**. Pick any branch and provide three inputs:

- `channel`: `nightly` (default), `beta`, or `stable`. The `source` job
  maps the chosen channel to its branch (`stable` → `main`, `beta` →
  `beta`, `nightly` → `dev`); the dispatch branch is irrelevant.
- `dry_run`: `true` (default) or `false`. See [Dry runs](#dry-runs).
- `version`: optional semver override for minor or major stable releases.
  Ignored for `nightly`.

`source` pins the SHA of the mapped branch tip. `verify` runs CI on that
SHA, and `publish` packs and publishes.

### Concurrency

```yaml
concurrency:
  group: openkan-releases
  cancel-in-progress: false
```

A single publish runs at a time across all channels. An in-flight publish
is never cancelled; queued runs wait for the active publish to finish.

## Dry runs

`dry_run: true` performs version calculation, package creation, and CI
validation without publishing to npm and without creating a GitHub release.
Use dry runs to validate a release path before going live. The default for
`workflow_dispatch` is `true`; set it to `false` only when intentionally
publishing.

## npm trusted publishing

npm publication uses OpenID Connect provenance and npm trusted publishing for
the `PolderLabsVOF/openkan` repository's `release.yml` workflow. Configure the
trusted publisher in npm without an npm environment and do not add a long-lived
`NPM_TOKEN` secret.

The npm CLI `npm trust setup` command may return HTTP 403 for granular tokens
that bypass 2FA. Complete trusted-publisher setup in the npm account UI with a
2FA-enabled account, or run `npm trust` interactively with that account. Until
the trust relationship is present, publication fails closed; dry runs remain a
safe way to validate the release path.

For setup requirements and supported configuration, see npm's
+[trusted publishers documentation](https://docs.npmjs.com/trusted-publishers/).

## Recovery and rollback

Published npm versions are immutable. Do not overwrite, unpublish, or retag a
bad stable release as a rollback. Fix the issue, prepare a new patch version,
and promote it through the normal branch sequence. If needed, document the
affected version in GitHub Releases and the changelog while the forward fix is
in progress.

## Manual promotion checklist

Before opening a `dev → beta` or `beta → main` promotion pull request, run
the release-path checks locally on the candidate branch tip:

```sh
npm ci
npm run typecheck
npm test
npm run check
npm run test:package
```

Open the promotion PR and wait for CI on Node 22 and 24 to pass. Merge with
`git merge --no-ff`; do not squash. Then dispatch the matching release
(`channel=beta` from `beta`, or `channel=stable` from `main`) once you are
ready to publish.
