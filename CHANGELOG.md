# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Documentation directory (`docs/`) with roadmap, milestones, branching guide,
  and release checklist.
- Community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`,
  `CHANGELOG.md`, issue and PR templates, CI workflow, `SECURITY.md`,
  `SUPPORT.md`, `CODEOWNERS`, `.editorconfig`, `.gitattributes`.

### Changed

- Original flat README split: roadmap content moved to `docs/README.mdx`;
  milestones live in `docs/milestones/M0.mdx` through `M6.mdx`.

## [0.1.0] — 2026-07-06

### Added

- Initial plugin release — openkan v0.1.
- Five-column kanban board (Backlog, To Do, In Progress, Review, Done) served
  at `http://127.0.0.1:7777/`.
- Live UI updates over Server-Sent Events with polling fallback.
- Drag-and-drop between columns with optimistic UI and revert on error.
- Four custom OpenCode tools: `kanban_add`, `kanban_move`, `kanban_start`,
  `kanban_view`.
- Per-task actions: Start (dispatches the agent), Abort, Delete, View Artifact.
- MDX artifact mirror under `.openkan/tasks/` and `.openkan/sessions/`.
- Install script (`install.sh`) that copies the plugin into the global OpenCode
  config directory.

[Unreleased]: https://github.com/PolderLabsVOF/openkan/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PolderLabsVOF/openkan/releases/tag/v0.1.0
