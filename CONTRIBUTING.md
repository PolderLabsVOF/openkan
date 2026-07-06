# Contributing to openkan

openkan is a small, single-user tool and the codebase reflects that.
Contributions should be proportional to the scope of the project.

## Code of Conduct

This project is governed by the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating, you agree to uphold its standards — be respectful, assume
good faith, and give constructive feedback.

## Branching

openkan uses a `main` / `beta` / `dev` branch model (see
[docs/BRANCHING.md](docs/BRANCHING.md)). All pull requests target `dev`.

## Reporting bugs

Open a [Bug report](.github/ISSUE_TEMPLATE/bug.yml) issue with your openkan
commit hash, OpenCode version, reproduction steps, and relevant logs.

## Suggesting features

Open a [Feature request](.github/ISSUE_TEMPLATE/feature.yml) issue with the
problem, your proposed solution, and alternatives considered.

## Reporting security issues

Do **not** open a public issue. Send details to security@polderlabs.com.
See [SECURITY.md](.github/SECURITY.md) for the full policy.

## Development setup

Clone the repo, install dependencies, and symlink the plugin into OpenCode's
config so it picks up local edits:

```sh
git clone https://github.com/PolderLabsVOF/openkan.git
cd openkan
bun install
ln -sf $(pwd)/plugins/kanban.ts ~/.config/opencode/plugins/kanban.ts
ln -sf $(pwd)/plugins/tools.ts ~/.config/opencode/plugins/tools.ts
ln -sf $(pwd)/kanban ~/.config/opencode/kanban
ln -sf $(pwd)/web ~/.config/opencode/web
```

Restart OpenCode and open http://127.0.0.1:7777. Edit `kanban/*.ts`,
`plugins/*.ts`, or `web/*` — the UI refreshes live; plugin changes need an
OpenCode restart. Use `./install.sh` to copy files instead of symlinking.

## Project layout

```
kanban/       Board state (board.ts), MDX serialisation (mdx.ts), server (server.ts)
plugins/      Plugin entry (kanban.ts) and custom tools (tools.ts)
web/          Kanban UI — index.html, style.css, app.js
docs/         Roadmap (README.mdx) and milestone docs (milestones/M*.mdx)
install.sh    Copies plugin files into the global OpenCode config
package.json  Dependencies merged into OpenCode config at install time
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):
`<type>: <short description>`. Types: `feat`, `fix`, `docs`, `chore`,
`refactor`.

Examples:
```
feat: add drag-to-reorder within columns
fix: server crash on missing .openkan directory
docs: document KANBAN_PORT env var
```

## Pull requests

- Open against `dev`. Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
- One feature or fix per PR.
- Run the typecheck before submitting:
  ```sh
  bunx tsc --noEmit --allowJs --checkJs --target ES2022 --module ESNext \
           --moduleResolution Bundler kanban/*.ts plugins/*.ts
  ```

## Release process

Releases are tagged manually from `main`. See
[docs/RELEASING.md](docs/RELEASING.md) for the checklist.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
