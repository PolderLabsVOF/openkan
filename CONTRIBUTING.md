# Contributing to OpenKan

OpenKan is a local-first, single-user tool. Keep changes proportional,
reviewable, and covered by tests.

## Development setup

```sh
git clone https://github.com/PolderLabsVOF/openkan.git
cd openkan
npm install
npm test
```

Run the CLI directly from the checkout:

```sh
npm run openkan -- init
npm run openkan -- start
```

The dashboard is available at `http://127.0.0.1:7777/`.

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

## Verification

Run all gates before submitting:

```sh
npm test
npm run typecheck
npm run check
npm run e2e
npm audit --audit-level=high
```

Installer changes must also pass `tests/install.test.mts`. The test installs
into an isolated temporary home and verifies both fresh installation and
atomic update behavior.

## Commit messages

Use Conventional Commits:

```text
<type>: <short description>
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, and `chore`.

## Pull requests

- Target the repository's active development branch.
- Keep one logical change per pull request.
- Include tests for changed behavior.
- Keep documentation synchronized with code.

## Security

Do not open public issues for vulnerabilities. Follow
[`SECURITY.md`](.github/SECURITY.md).

## License

Contributions are licensed under the [MIT License](LICENSE).
