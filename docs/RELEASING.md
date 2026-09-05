# Release process

OpenKan publishes three npm channels from three protected promotion branches.
The release workflows run CI against the exact commit SHA before publishing and
fail closed: a missing npm trusted-publishing configuration prevents publication.
They never use a long-lived npm token.

## Channels and branches

| Branch | Purpose | npm dist-tag | Release type |
| --- | --- | --- | --- |
| `main` | Stable releases and the default visitor branch | `latest` | Stable GitHub and npm release |
| `beta` | Release-candidate testing | `beta` | npm prerelease and prerelease GitHub release |
| `dev` | Active development | `nightly` | Scheduled npm prerelease |

Promote changes through merge pull requests in this order:

```text
feature branch -> dev -> beta -> main
```

Do not squash a promotion pull request. The release branch must contain the
same commits that passed the preceding channel. Contributors start feature
branches from `dev`; only stable release work lands on `main`.

## Automated releases

### Stable (`main`)

Every push to `main` runs the stable release workflow. It publishes only when
the `package.json` stable version does not already exist in npm. Existing
versions are skipped; the workflow does not replace, unpublish, or roll back a
published version. A successful stable publication uses the `latest` dist-tag
and creates a non-prerelease GitHub release with the built package tarball.

### Beta (`beta`)

Every push to `beta` publishes a beta prerelease under the `beta` dist-tag and
creates a prerelease GitHub release with its package tarball.

### Nightly (`dev`)

The nightly workflow runs at **02:17 UTC**. Its schedule is defined on `main`,
but it explicitly checks out `dev` before building, testing, and publishing.
It publishes a nightly prerelease under the `nightly` dist-tag.

GitHub schedules can be delayed during periods of high load and may be disabled
after 60 days of repository inactivity. See GitHub's
+[scheduled workflow documentation](https://docs.github.com/actions/reference/events-that-trigger-workflows#schedule).

## Prerelease versioning

`scripts/release.mjs` computes the next version from the current `latest`
dist-tag on npm:

| Channel | Formula | Example |
| --- | --- | --- |
| `stable` | bump patch of the latest npm version | `0.4.0` → `0.4.1` |
| `beta` | bump patch, append `-beta.<n>` (monotonic) | `0.4.1-beta.1` → `0.4.1-beta.2` |
| `nightly` | latest version + `-nightly.<UTC YYYYMMDD>` | `0.4.0-nightly.20260905` |

A workflow_dispatch run can override the auto-computed version by setting the
`version` input (or `RELEASE_VERSION` env). This is the supported path for
stable minor or major releases. The script rejects any version that already
exists on npm, so retries cannot publish duplicates.

## Preparing a stable version

A push to `main` automatically publishes the next patch version of the
current `latest` npm version (for example, `0.4.0` → `0.4.1`). For minor or
major stable releases, force the version with the `version` workflow_dispatch
input (or the `RELEASE_VERSION` environment variable). The script reads the
current `latest` dist-tag from npm, so manual edits to `package.json`'s
`version` field are not used at publish time.

Promote changes through pull requests in this sequence so the tested commits
are preserved:

```text
feature branch -> dev -> beta -> main
```

Run the local release checks before opening a promotion pull request:

```sh
npm ci
npm run typecheck
npm test
npm run check
npm run test:package
```

The release workflow repeats this CI sequence on Node.js 22 and 24 before it
packs and publishes the exact checked-out SHA. The produced tarball is retained
as a workflow artifact and attached to the GitHub release.

## Manual runs

The release workflow supports `workflow_dispatch` from `main` only. Select one
of `stable`, `beta`, or `nightly`. Its `dry_run` input defaults to `true`.
A dry run performs version calculation, package creation, and release
validation without publishing to npm or creating a GitHub release. Set
`dry_run` to `false` only when intentionally running the selected channel.

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
