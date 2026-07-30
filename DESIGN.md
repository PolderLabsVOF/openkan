# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-07-30
- Primary product surfaces: task board, task workspace, documentation reader,
  changelog, contributors, Bizar control plane, settings and project switching.
- Evidence reviewed: `web/index.html`, `web/style.css`, `web/app.js`,
  `web/task-view.js`, `web/docs-view.js`, `web/bizar.js`,
  `artifacts/ui-overhaul/before-desktop.png`,
  `artifacts/ui-overhaul/before-mobile.png`,
  `artifacts/ui-overhaul/before-task.png`, and
  `artifacts/ui-overhaul/before-doc-reader.png`.

## Brand
- Personality: focused, capable, calm, technical, and collaborative.
- Trust signals: visible connection state, explicit task ownership, durable
  evidence, clear destructive actions, and predictable state transitions.
- Avoid: noisy gradients, novelty icons, cramped toolbars, invisible
  navigation, dashboard ornament without function, and low-contrast metadata.

## Product goals
- Goals: make active work legible in seconds; make task creation and movement
  effortless; expose collaboration without overwhelming the board; keep every
  major surface usable on laptop and mobile screens.
- Non-goals: enterprise reporting, remote hosting, decorative analytics, or a
  replacement for source control.
- Success signals: all five columns are understandable at common desktop
  widths; filters do not dominate the screen; task detail keeps content above
  the fold; primary actions are reachable by keyboard and touch.

## Personas and jobs
- Primary personas: individual developers, technical leads, and coding agents.
- User jobs: identify current work, claim or delegate a task, inspect evidence,
  resolve blockers, review changes, and understand project history.
- Key contexts of use: a desktop beside an editor, a narrow split pane, and a
  mobile status check.

## Information architecture
- Primary navigation: Tasks, Changelog, Contributors, Docs, Bizar.
- Core routes/screens: board, task workspace, document reader, control plane,
  project switcher, command palette, settings.
- Content hierarchy: project and connection context; primary navigation;
  page heading and health summary; focused controls; durable content.

## Design principles
- Progressive disclosure: show search and essential board controls first;
  reveal categorical filters only when requested.
- Status before decoration: counts, ownership, state, and blockers must be more
  prominent than visual flourish.
- One strong action per surface: New Task on the board, next-state transition
  in a task, and Send/Start in Bizar.
- Preserve context: switching tabs closes task detail cleanly; mobile layouts
  scroll one coherent region rather than clipping nested panes.
- Tradeoffs: prefer slightly denser cards so five columns fit on common laptop
  widths, while keeping task detail spacious for reading.

## Visual language
- Color: deep graphite surfaces, cool indigo primary action, cyan connection
  accent, semantic amber/red/green states, and accessible light equivalents.
- Typography: native UI sans for speed and familiarity; native monospace for
  paths, IDs, models, and command context.
- Spacing/layout rhythm: 4px base with 8/12/16/24/32px steps.
- Shape/radius/elevation: 10–16px radii, hairline borders, restrained shadows,
  and layered surfaces rather than heavy outlines.
- Motion: 140–180ms state changes; no essential information conveyed only by
  animation.
- Imagery/iconography: compact geometric marks and familiar symbols; avoid
  emoji as the sole label for critical actions.

## Components
- Existing components to reuse: tabs, buttons, status pill, task cards, filter
  chips, modals, task workspace panels, docs tree, toast, command palette.
- New/changed components: workspace heading, board health summary, collapsible
  filter panel, responsive mobile board rail, compact task metadata strip.
- Variants and states: default, hover, focus, selected, connected, waiting,
  stale, archived, destructive, empty, and loading.
- Token/component ownership: CSS custom properties and surface overrides live
  in `web/workspace.css`; behavior remains in the existing view modules.

## Accessibility
- Target standard: WCAG 2.2 AA for contrast, keyboard operation, and focus.
- Keyboard/focus behavior: preserve the skip link, visible focus rings, tab
  semantics, Escape behavior, and labelled icon buttons.
- Contrast/readability: body text at least 4.5:1; muted text reserved for
  secondary information; never use color alone for task state.
- Screen-reader semantics: keep landmark, tablist, region, dialog, and live
  status roles; filter disclosure reports `aria-expanded`.
- Reduced motion and sensory considerations: honor `prefers-reduced-motion`;
  pulse effects are optional and non-essential.

## Responsive behavior
- Supported breakpoints/devices: 360px mobile through wide desktop.
- Layout adaptations: five-column desktop grid; horizontal snap rail on
  narrow screens; two-row mobile header; compact summaries and metadata.
- Touch/hover differences: 44px minimum primary touch targets; do not hide
  required actions behind hover alone.

## Interaction states
- Loading: skeletons or concise status copy in the content region.
- Empty: explain the next action and provide the creation affordance nearby.
- Error: retain context, state what failed, and provide a retry path.
- Success: toast plus immediate visible state update.
- Disabled: reduced emphasis with preserved readable labels.
- Offline/slow network: connection pill remains visible; never discard local
  task context because Bizar is unavailable.

## Content voice
- Tone: concise, direct, calm, and operational.
- Terminology: use “task”, “project”, “In Progress”, “Review”, “agent”, and
  “session” consistently.
- Microcopy rules: lead with verbs; explain empty states; avoid implementation
  jargon in primary controls.

## Implementation constraints
- Framework/styling system: dependency-free HTML, CSS, and browser JavaScript.
- Design-token constraints: extend existing custom properties; no new UI
  framework or external font dependency.
- Performance constraints: no runtime styling library; keep initial assets
  cacheable and interaction code small.
- Compatibility constraints: current evergreen browsers and Node-served static
  assets; preserve existing IDs and API contracts.
- Test/screenshot expectations: typecheck, 350+ unit tests, sanity check, Bizar
  E2E, browser interaction tests, console checks, and desktop/mobile screenshots.

## Open questions
- [ ] Whether a future release should offer list and timeline views in addition
  to the board; owner: product; impact: information architecture.
- [ ] Whether Bizar connection health should appear in the global header;
  owner: integration; impact: cross-surface status design.
