# Random dev notes

This file lives under `notes/` rather than `docs/`, so it does NOT match the
default `docs/**` glob. It should NOT be imported by `kanban_import` out of
the box — only if you add `notes/**` to your include list.

- [ ] This one should never appear in the default Backlog
- [ ] Neither should this one

Use it to verify that the include glob is doing its job. Run
`kanban_import include='["notes/**"]'` and these two will finally appear.
