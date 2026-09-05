# Contributing to OpenKan

OpenKan is a local-first, single-user tool. Keep changes focused, reviewable,
and covered by tests.

## Development setup

OpenKan requires Node.js 22.6 or newer. CI tests Node.js 22 and 24.

```sh
git clone https://github.com/PolderLabsVOF/openkan.git
cd openkan
git switch dev
npm ci
```

Run the CLI from the checkout while you work:

```sh
npm run openkan -- init
npm run openkan -- start --no-open
```

The dashboard is available at `http://127.0.0.1:7777/`.

## Development workflow

`dev` is the active-development branch. Start feature work from it and open a
pull request back to it:

```sh
git switch dev
git pull --ff-only origin dev
git switch --create feature/short-description
```

Use a focused branch name such as `fix/installer-target` or
`docs/release-process`. Do not develop directly on `beta` or `main`.

Promotion follows this sequence:

```text
feature branch -> dev -> beta -> main
```

Merge each promotion pull request; do not squash a promotion pull request.
This preserves the tested commit history as it moves between channels. `main`
is the default branch for stable users and documentation links.

## Verification

Run the same checks that CI runs before opening a pull request:

```sh
npm run typecheck
npm test
npm run check
npm run test:package
```

`npm run test:package` builds the package, packs it, installs the tarball, and
smoke-tests the installed artifact. CI runs these checks after `npm ci` on
Node.js 22 and 24 and uploads the built tarball as an artifact.

Run an individual test file while iterating:

```sh
node --test --experimental-strip-types tests/cli.test.mts
```

`npm run build` writes generated files to `dist/`. Use
`npm run openkan -- ...` to run edited source instead of a pre-existing build.

## Project layout

```text
bin/             CLI entrypoints
commands/        Agent command prompts
kanban/          Board state, persistence, server, and APIs
skills/openkan/  Portable agent guidance and templates
web/             Browser application
tests/           Unit, integration, installer, and contract tests
install.sh       Atomic dedicated-location installer
```

## Releases

The automated channels are documented in [Release process](docs/RELEASING.md).
Contributors normally promote through pull requests; maintainers prepare the
stable version on `dev` before its promotion to `beta` and `main`.

## Commit messages

Use Conventional Commits:

```text
<type>: <short description>
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, and `chore`.

## Pull requests

- Target `dev` for feature work.
- Keep one logical change per pull request.
- Include tests for changed behavior.
- Keep documentation synchronized with code.
- Use promotion pull requests for `dev` to `beta` and `beta` to `main`; merge
  them without squashing.

## Security

Do not open public issues for vulnerabilities. Follow
[`SECURITY.md`](.github/SECURITY.md).

## License

Contributions are licensed under the [MIT License](LICENSE).
