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

## Visual identity — brand assets and Insights tab

> Plan author: `@brad` (Brand Designer). This section is the **plan**.
> Implementation routes to `@mike` (or `@todd`/`@karen` for code) — see
> "What `@mike`/`@todd`/`@karen` will build" at the bottom.

### Aesthetic direction

OpenKan's brand is **focused, capable, calm, technical, and collaborative**
(see "Brand" above). The new brand assets keep that posture: a single
chromatic mark in `--coral` against the existing neutral ink ladder and
dark surfaces — no gradients, no glassmorphism, no glow, no decorative
texture. The mark is a stylized "K" glyph that reads as both the letter
and three kanban cards stacked edge-on. The Insights tab extends the
same vocabulary: summary cards as flat tiles with a single ink-80 number
and an ink-50 label; one stacked-bar chart in five existing categorical
hues (no new palette entries); zero ornament.

Two reference frames for the mood, described inline because the project
is local-first and offline:

- **Linear / height.app shell** — dark surface, single accent for the
  active state, neutral text ladder, no chrome drama.
- **GitHub Primer / Primer Octicons** — flat iconography, viewBox-based,
  system fonts, restrained ink scale, accent reserved for the single
  moment that matters.

Neither is reproduced; both are referenced to anchor the *restraint*.

### Reused tokens (NO new tokens)

All visual values are existing custom properties from `web/style.css`.
No new hex values, no new gradients, no new shadows.

```yaml
# Surfaces
--bg:          #0d1117   # base canvas
--bg-elev:     #161b22   # topbar, panels
--bg-elev-2:   #1f242c   # cards, inputs

# Ink ladder (foreground-only)
--ink-80:      #e6ebf3   # primary text, headline numbers
--ink-60:      #aeb6c4   # secondary text
--ink-50:      #748098   # labels, axis ticks, helper text
--ink-30:      rgba(230,235,243,0.18)  # dividers, gridlines

# Brand accent (sole chromatic mark color)
--coral:       #FF6B5B
--coral-hover: #FF8273
--coral-soft:  rgba(255,107,91,0.12)   # subtle hover/selected fills

# Categorical status (reused for chart series; see "Chart" below)
--accent:      #4493f8   # "doing"
--success:     #2ea043   # "done"
--warn:        #d29922   # "todo"
--danger:      #f85149   # reserved, NOT used in chart

# Geometry
--radius-sm:   4px
--radius-md:   6px
--radius:      8px
--radius-pill: 999px

# Motion
--transition:  120ms cubic-bezier(0.2, 0.7, 0.2, 1)
```

Light theme override for `:root[data-theme="light"]` reuses the same
names with the existing light values; SVGs use `currentColor` plus
inline `fill` attributes that resolve to the same hue tokens via CSS
custom properties in the consuming context.

### Logo spec — `web/brand/logo.svg` (32×32)

The mark is a **"K" formed by three flat rectangles** in `--coral`,
viewBox `0 0 32 32`, no stroke, no gradient, no embedded text.

| Element         | Geometry (viewBox units)                                   | Fill         |
|-----------------|------------------------------------------------------------|--------------|
| Vertical bar    | `<rect x="5" y="4" width="4" height="24" rx="0.5" />`      | `--coral`    |
| Upper diagonal  | `<polygon points="9,16 21,4 25,4 13,16" />`                | `--coral`    |
| Lower diagonal  | `<polygon points="13,16 25,28 21,28 9,16" />`              | `--coral`    |

The three shapes form a clean letterform with 1-unit rounding on the
vertical bar to soften the optical corner. The intersection at
`x=9..13, y=16` is filled by overlapping polygons (acceptable; they
paint the same color). Optional: add a 1-unit-radius `<rect>` at the
junction for visual smoothing if the implementer wants, but flat is the
default.

Constraints:
- `viewBox="0 0 32 32"`, `width="32" height="32"` as defaults.
- No `<text>`, no `<image>`, no external font reference.
- No `filter`, no `feGaussianBlur`, no `feDropShadow`.
- Root `<svg>` declares `xmlns="http://www.w3.org/2000/svg"`.
- Fill uses `currentColor` so the consuming context can recolor with
  CSS (`color: var(--coral)` on the `<img>` or `<svg>` parent).

### Wordmark spec — `web/brand/logo-wordmark.svg` (~160×40)

Mark + wordmark on one horizontal line.

- viewBox `0 0 160 40`.
- The 32×32 K mark scaled to fit in the left 32px column, vertically
  centered (`y=4`, height 32). Fill `currentColor`.
- Wordmark text "OpenKan" — `<text x="40" y="26" font-family="-apple-system,
  BlinkMacSystemFont, 'Segoe UI', system-ui, 'SF Pro Text', 'Inter',
  'Roboto', 'Helvetica Neue', Arial, sans-serif" font-size="20"
  font-weight="600" letter-spacing="-0.01em" fill="currentColor">OpenKan</text>`.
- No second accent color, no separator, no tagline.

### Favicon spec — `web/brand/favicon.svg`

Identical to `logo.svg` (32×32 K mark) with one addition: a 1-unit
transparent padding ring so the mark sits comfortably inside a 16×16
tab icon. Fill `currentColor`; the browser default `color` on `<link
rel="icon">` is fine for monochrome rendering. Browsers that rasterize
SVG favicons will use `--coral` if the host page sets it; otherwise
fall back to a sensible default.

### Hero banner spec — `web/brand/banner.svg` (1280×320)

The README hero. Two-zone composition: **wordmark left**, **column
silhouettes right**. Single coral accent line at the bottom edge.

Layout (viewBox `0 0 1280 320`):

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   [K] OpenKan                                                │  ← wordmark, x=64..480, y=110..200
│       Local-first kanban for people and coding agents.       │  ← tagline, x=64..720, y=216, ink-60
│                                                              │
│                                       ▓ ▓ ▓ ▓ ▓             │  ← column silhouettes, right side
│                                                              │
│ ───────────────────────────────────────────────────────────  │  ← coral accent line, x=0..1280, y=296
└──────────────────────────────────────────────────────────────┘
```

Layers, bottom to top:
1. Background fill: `var(--bg)` (`#0d1117`). Full bleed.
2. Column silhouettes: five rectangles at the right edge, each 32px
   wide, 200px tall, anchored at the bottom (`y=80`), spaced 12px
   apart. Heights stepped: 80/120/160/200/240 (backlog shortest,
   done tallest, suggesting flow). Fill `--coral-soft`
   (`rgba(255,107,91,0.12)`); stroke `--coral` 1px; rx `var(--radius-sm)`.
   Group right-anchored, `transform="translate(880, 0)"`.
3. Wordmark: the 64×64 K mark + "OpenKan" `<text>` at 40px font-size,
   600 weight, `letter-spacing="-0.01em"`. Fill `--ink-80`. Position
   x=64, y=110..200. Implemented as inline `<g>` (not a nested
   `<image>` reference to `logo.svg`).
4. Tagline `<text>` at 16px, weight 400, fill `--ink-60`. Position
   x=64, y=232. Text: `Local-first kanban for people and coding agents.`
5. Accent line: `<rect x="0" y="304" width="1280" height="2" fill="var(--coral)" />`.

No gradients, no shadow, no glow. No icons. No "AI" badge. No emoji.
The tagline is the same line that already appears in `README.md` —
do not invent a different one.

### Docs banner spec — `web/brand/banner-docs.svg` (960×200)

A lighter version of the hero, sized for `docs/OK-PLANNING.md` and
`docs/CLAUDE-NATIVE.md`. viewBox `0 0 960 200`.

- Background fill: `--bg-elev` (`#161b22`) instead of `--bg` (the docs
  pages render on a slightly lighter surface).
- Wordmark: K mark 40×40 + "OpenKan" at 22px, fill `--ink-80`. x=48,
  y=72..112.
- Subtitle slot: empty by default (the consuming markdown supplies its
  own H1). One horizontal divider line in `--ink-30`, x=48..912, y=140.
- Column silhouettes: same five-rect motif as the hero, scaled to
  24×120, group right-anchored at `transform="translate(680, 0)"`. Fill
  `--coral-soft`, stroke `--coral` 1px. Heights stepped
  40/70/100/120/150.
- No accent line at the bottom (the docs banner is calmer than the hero).
- No tagline.

### Empty-state illustrations — 320×200

Two illustrations, same composition grammar, different caption slot.

**`empty-tasks.svg`** — used when the board has zero tasks AND when
the Insights chart has no changelog activity.

**`empty-sessions.svg`** — used when the session list is empty.

Composition for both (viewBox `0 0 320 200`):

- Background: transparent (so it inherits the page surface).
- Three thin vertical bars at the bottom, representing three of the
  five kanban columns. Each 18px wide, 96px tall, rx 4. Fill `--ink-30`,
  stroke `--ink-50` 1px. x=64, 124, 184. y=88. (The two missing columns
  visually suggest "more will appear".)
- One task-card outline hovering above the middle bar: 64×40 rect,
  rx 6, fill `--bg-elev-2`, stroke `--ink-50` 1px, x=128, y=44.
- One horizontal line inside the card representing a title row, x=140,
  y=60, width 40, height 4, fill `--ink-50`.
- One short downward arrow from the card to the middle column:
  `<path d="M160 96 L160 116 M156 112 L160 116 L164 112" stroke="var(--coral)"
  stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />`
  (arrow tip just above the column top).

The two illustrations differ in **caption glyph** in the 24px space at
the bottom (y=176..192):
- `empty-tasks.svg`: three small horizontal lines (text rows) — `<rect
  x="120" y="172" width="80" height="4" rx="2" fill="var(--ink-50)"/>` plus
  two shorter lines beneath.
- `empty-sessions.svg`: a single dot + two short lines (a session row
  glyph) — `<circle cx="128" cy="174" r="3" fill="var(--ink-50)"/>` plus
  two short rects.

The HTML caption (`"No changelog activity yet. Start moving cards to
populate this chart."`) lives in the surrounding markup, NOT in the
SVG — the SVG is illustration only.

### Social card spec — `web/brand/social-card.svg` (1200×630)

GitHub OG image. viewBox `0 0 1200 630`.

- Background: `--bg` full bleed.
- Wordmark centered vertically and horizontally-left: K mark 96×96 +
  "OpenKan" at 96px font-size, 600 weight. x=120, y=240..360.
- Tagline `<text>` at 28px, weight 400, fill `--ink-60`. x=120, y=400.
  Text: `Local-first kanban for people and coding agents.`
- Column silhouettes: same five-rect motif as the hero, scaled to
  48×360, right-anchored at `transform="translate(720, 0))"`. Heights
  stepped 120/180/240/300/360.
- Coral accent line: `<rect x="120" y="476" width="960" height="3" fill="var(--coral)"/>`
  — sits beneath the wordmark/tagline, spans 80% of the width.
- No additional decoration.

### Topbar logo replacement — `web/index.html` and `web/style.css`

Current topbar header (line 17–19):

```html
<div class="brand">
  <span class="logo" aria-hidden="true"></span>
  <h1>OpenKan</h1>
  ...
</div>
```

Replace with:

```html
<div class="brand">
  <img src="./brand/logo-wordmark.svg" alt="OpenKan" height="24"
       class="brand-wordmark" />
  ...
</div>
```

Add to `web/style.css` (new classes only, per scope):

```css
.brand-wordmark {
  height: 24px;
  width: auto;
  display: block;
  color: var(--ink-80); /* resolves currentColor in the SVG */
}
```

The pre-existing `.logo` class (gradient square) is removed ONLY from
the topbar — `web/workspace.css` has its own `.logo` selector at line
77 for the task workspace; that one is out of scope and must not be
touched. The topbar selector `.topbar .logo` (or the equivalent
unscoped `.logo` if workspace.css wins the cascade) gets `display:none`
as a defensive belt-and-braces, or simply is left to the markup
removal — pick one, do not do both.

### Favicon wiring — `web/index.html`

Inside `<head>`, after the existing stylesheet links:

```html
<link rel="icon" type="image/svg+xml" href="./brand/favicon.svg" />
```

No `<link rel="mask-icon">`, no PNG fallback (the brief says no rasters).

### Insights tab — visual direction

The tab mirrors the existing top-level tabs (Tasks, Changelog,
Contributors, Docs, Bizar, Claude) — same `.tab` button chrome, same
`.tab-pane` host, same active-underline token (`--tab-active` resolves
to `--coral`). The visual content is **flat**: a three-card summary
row above one stacked-bar chart. No filter row, no settings gear, no
download button.

**Layout (Insights tab pane, viewBox equivalent):**

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│   │     42       │  │     3.4d     │  │   Tue 9/02   │      │
│   │ Tasks done   │  │ Avg lead time│  │ Busiest day  │      │
│   └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│   Tasks moved per column, last 30 days                       │  ← chart title (ink-60)
│                                                              │
│   8 ┤                                                        │
│   6 ┤      ▓▓▓                                               │
│   4 ┤   ▓▓▓▓▓▓▓▓▓▓                                           │
│   2 ┤▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                                 │
│   0 └────────────────────────────────────────────            │
│       Aug 04      Aug 09      Aug 14      Aug 19             │
│                                                              │
│   ─────── ─────── ─────── ─────── ───────                    │  ← legend, five swatches
│   backlog  todo   doing  review   done                       │
└──────────────────────────────────────────────────────────────┘
```

Empty state (when `days[].every(d => all columns are 0 for that day)`):

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│               [empty-tasks.svg, 320×200]                     │
│                                                              │
│   No changelog activity yet. Start moving cards to           │
│   populate this chart.                                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Insights — component composition

**Summary card row** — three tiles, equal width, gap `--radius-md`
(actually `12px` per the spacing scale), each:

- Surface: `--bg-elev`, 1px `--border`, `border-radius: var(--radius)`.
- Padding: 16px on all sides.
- Inside, top to bottom:
  - Headline number: 28px, weight 600, `--ink-80`, `font-variant-numeric:
    tabular-nums` (the existing `--num-features` token already enables
    `tnum`).
  - Label: 12px, weight 500, `--ink-50`, uppercase `letter-spacing:
    0.04em`. Text: "Tasks done", "Avg lead time", "Busiest day".
- Busiest-day tile highlights the date with `--coral` underline
  (`border-bottom: 2px solid var(--coral)`, `padding-bottom: 4px`).
  One deliberate accent moment, per antislop-ui rule (one accent, one
  place).
- No shadow, no gradient, no glow, no hover state beyond the existing
  `--transition` on `border-color`.

**Chart card** — one card below the summary row:

- Surface: `--bg-elev`, 1px `--border`, `border-radius: var(--radius)`.
- Padding: 24px on all sides.
- Chart title at top: "Tasks moved per column, last 30 days" — 14px,
  weight 500, `--ink-60`. Right side (same row): legend with five
  swatches (8×8 px squares, gap 6px) + 12px label text (`--ink-50`).
- SVG plot area: 30 columns × 5 stacked segments, drawn at viewBox
  `0 0 720 240`, with 32px reserved at left for the y-axis labels
  and 24px reserved at bottom for the x-axis labels. Plot region is
  `32,16 → 704,200`.
- Plot enters on mount with a single 200ms opacity transition
  (`opacity 0 → 1` over `var(--transition)`). No per-bar animation.
  No perpetual motion.

### Insights — chart spec (`web/charts.js`)

**Form** — stacked bar chart, one bar per day, 30 bars. Stacks are the
five columns in fixed order (backlog, todo, doing, review, done). The
brief calls this "task velocity / column flow over time"; a stacked bar
is the right form for "volume per category per time bucket" (per
dataviz `choosing-a-form.md`). A Sankey would imply flow magnitude
between specific pairs, which the changelog does not cleanly support
without source-tracking reconstruction.

**Marks** — per dataviz `marks-and-anatomy.md`:
- Bar width: 18px. Bar gap: 6px. Plot inner padding: 0.
- Segment edge rounding: 4px radius only on the top-most segment's
  top corners and bottom-most segment's bottom corners. Middle
  segments are flush rectangles.
- 2px surface gap between adjacent stacked segments is achieved by a
  1-unit inset on the top edge of every segment except the first; the
  visual is "stacked plates, slightly separated", not "one solid
  block".
- Segments with count = 0 are not drawn (no zero-height rects).

**Axes** — recessive:
- Y-axis: 3 ticks at 0, ceil(max/2), max. Labels in 11px `--ink-50`,
  right-aligned. Tick lines: 1px `--ink-30` from tick to plot right
  edge (full gridlines, recessive).
- X-axis: 7 ticks every 5 days starting at day 0 (days 0, 5, 10, ...,
  25) plus day 29. Labels in 11px `--ink-50`, centered under the bar.
  Format: `Mmm DD` (e.g. "Aug 04"). Use `Intl.DateTimeFormat` with
  `month: "short", day: "2-digit"`, locale-respecting.
- Axis lines: 1px `--ink-30`, only on the bottom and left edges.

**Color** — categorical, five hues, **fixed order**, never cycled:

| Series   | Token          | Hex      | Reason                                            |
|----------|----------------|----------|---------------------------------------------------|
| backlog  | `--ink-50`     | `#748098`| Coldest, least-active state                       |
| todo     | `--warn`       | `#d29922`| Queued — warm, not-yet-active                     |
| doing    | `--accent`     | `#4493f8`| Active work — primary brand-side accent           |
| review   | `--coral`      | `#FF6B5B`| Verification — chromatic brand moment in chart    |
| done     | `--success`    | `#2ea043`| Complete — terminal state                         |

`--danger` is intentionally NOT used in this chart. All five hues are
already-defined tokens. No new entries.

Contrast against `--bg-elev` (`#161b22`) for all five: passing for
`--ink-50` and `--accent` borderline; the chart card sits on a flat
surface and uses labels in `--ink-50` rather than series-color text,
so identity is never color-alone (legend always present, 5 series).

**Hover layer** — per dataviz `interaction.md`:
- Each rendered `<rect>` segment carries a child `<title>` element
  with text `"<column> on <Mon DD>: <count> move(s)"`.
- No custom tooltip JS, no crosshair, no focus ring on bars. Native
  browser tooltip via `<title>` is the brief's spec ("Hover tooltip
  via `<title>` element").
- Hit target: each bar's full column (a single invisible `<rect>`
  the width of the bar's footprint and the full plot height) carries
  the `<title>`, so hover works even over zero-count gaps within a
  day.

**Accessibility**:
- A `<desc>` element at the top of the chart SVG summarises the data:
  `"Stacked bar chart of tasks moved per column over the last 30
  days, generated <ISO date>."`.
- The chart card has `role="img"` and `aria-label` matching the
  `<desc>`.
- Legend is real `<text>` + colored `<rect>` swatches; the legend
  `<ul>` lives in HTML (not inside the SVG) so screen readers can
  navigate it.
- A keyboard-accessible table view is provided as a `<details>`
  disclosure under the chart card: "Show data table" — same five
  columns × 30 rows. Implements dataviz R-27 (table view exists).

### Anti-patterns banned (per `antislop-ui`)

- **No new gradients.** The existing `.logo` linear-gradient (lines
  183–184 of `web/style.css`) is pre-existing and out of scope; do
  not extend the gradient pattern anywhere new. The brand mark is
  flat fill. The banners have no gradient. The chart has no gradient.
- **No glassmorphism.** No `backdrop-filter` on the summary cards or
  chart card. The topbar's existing glass is pre-existing and
  untouched.
- **No excessive radius.** Cards use `--radius` (8px); buttons and
  inputs already use `--radius-md`/`--radius-sm`. No 24px or pill
  radius on data-display surfaces.
- **No glow, no shadow on data cards.** Only `--shadow-1` is allowed
  and only on modals (existing).
- **No background grid / dot pattern / texture behind the chart.**
  The chart IS the content. Surrounding surface is flat `--bg-elev`.
- **No emoji anywhere** (per `antislop-ui` R-04).
- **No invented numbers.** Summary card values come from real
  computation against the live changelog. Empty state shows the
  illustration + a real cause-and-action sentence.
- **No fake terminal window, no capsule "AI" badge, no "Trusted By"
  logo row** — none apply, but called out so the implementer does
  not add them later.
- **No external font.** The wordmark uses the system stack already
  declared in `web/style.css` line 131–132.
- **No chart library** (no d3, no Chart.js). Pure SVG primitives via
  `document.createElementNS`.
- **No PNG/JPG raster anywhere.** Favicon is SVG; empty-state
  illustrations are SVG; banners are SVG; social card is SVG.
- **No new CSS hex values.** All colors resolve to existing tokens
  via `var(--…)` or `currentColor`.

### Motion language

Per `antislop-ui` R-19 and the brand's calm posture:

- The Insights chart fades in once on mount: `opacity 0 → 1` over
  `200ms`, easing `var(--transition)`. Single play, no loop.
- Summary cards do not animate in. They are present from mount.
- Tab switch uses the existing `.tab` button transition (border-color
  via `--transition`); no new motion.
- No pulsing dots, no bouncing arrows on the empty-state illustration,
  no shimmer on summary cards.
- Hover tooltip uses native browser `<title>` rendering — no JS
  animation, no fade.

The motion dial for this surface is **1** (hover/static only). The
single 200ms fade-in is justified by R-19 because it serves the UX
purpose of hiding the first paint of unmounted axis text; it does
not loop.

### What `@mike`/`@todd`/`@karen` will build

This plan was authored by `@brad`. **Implementation routes to
`@mike` (orchestrator)**, who dispatches the code-writing agents per
the worktree protocol. The implementer creates the worktree before
starting:

```sh
git worktree add .claude/worktrees/visuals -b wt/brad-visuals-and-insights main
```

Then dispatches **7 atomic commits** in order:

1. **`feat(brand): add SVG logo, favicon, banner, empty-state, social-card`**
   - New files in `web/brand/`:
     - `logo.svg` — 32×32 K mark.
     - `logo-wordmark.svg` — ~160×40 mark + wordmark.
     - `favicon.svg` — 32×32 K mark.
     - `banner.svg` — 1280×320 README hero.
     - `banner-docs.svg` — 960×200 docs banner.
     - `empty-tasks.svg` — 320×200 empty-board illustration.
     - `empty-sessions.svg` — 320×200 empty-session illustration.
     - `social-card.svg` — 1200×630 OG image.
   - Constraints per the spec above (viewBox, no rasters, no fonts,
     no gradients, no glass, no glow). Each SVG opens cleanly in a
     browser tab at native size.

2. **`feat(kanban/insights): velocity aggregator reading changelog.jsonl`**
   - New file: `kanban/insights.ts`.
   - Exports:
     ```ts
     export type VelocityBuckets = {
       days: string[];                  // YYYY-MM-DD, oldest first
       backlog: number[];
       todo: number[];
       doing: number[];
       review: number[];
       done: number[];
     };
     export function computeVelocity(
       okDir: string,
       days?: number,                   // default 30
     ): VelocityBuckets;
     ```
   - Reads `.ok/changelog.jsonl` via the existing `readEvents`
     helper from `kanban/changelog.ts`. **The aggregator must be
     defensive about the existing `task.moved` payload quirk: in
     `kanban/server.ts:645`, `payload.from` actually contains the
     destination column (not the source). See "Open questions for
     the implementer" below.**
   - Bucketing: local-date `YYYY-MM-DD` via `toLocaleDateString("en-CA")`,
     matching the existing `readSummary` convention in
     `kanban/changelog.ts:239`.
   - For each `task.moved` event: parse `summary` for the destination
     column (`/moved '.*' to (\w+)/`), increment that column's
     bucket for that day.
   - For the source column (moves-out): look up the most recent
     prior `task.moved` event for the same `taskId`; that prior
     move's destination is this move's source. Decrement that
     column's bucket for that day. If no prior move, the task was
     created into its starting column; skip the decrement.
   - Empty / missing changelog: return zero-filled arrays of length
     `days`, all buckets zero.
   - Bad JSONL line: existing `parseLine` in `changelog.ts` already
     warns to stderr and returns null; the aggregator trusts that
     contract.

3. **`feat(api): GET /api/insights/velocity endpoint`**
   - In `kanban/server.ts`, add a new route registration alongside
     the existing `/api/changelog/summary` (around line 2577):
     ```ts
     if (path === "/api/insights/velocity" && req.method === "GET")
       return apiGetInsightsVelocity(req);
     ```
   - Add a new handler:
     ```ts
     async function apiGetInsightsVelocity(req: Request): Promise<Response> {
       const url = new URL(req.url);
       const days = Math.max(1, Math.min(365,
         parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
       const buckets = computeVelocity(KANBAN_DIR, days);
       return jsonResponse({
         days: buckets.days,
         columns: {
           backlog: buckets.backlog,
           todo: buckets.todo,
           doing: buckets.doing,
           review: buckets.review,
           done: buckets.done,
         },
         windowDays: days,
         generatedAt: new Date().toISOString(),
       });
     }
     ```
   - Scope check: this commit modifies `kanban/server.ts` ONLY at
     the route registration block and the new handler. It does NOT
     modify the existing `task.moved` emit at line 641–646.

4. **`feat(web/charts): stacked-bar SVG renderer with empty-state path`**
   - New file: `web/charts.js`.
   - Exports:
     ```js
     export function renderStackedBar(svgEl, data) { /* ... */ }
     export function isAllZero(data) { /* ... */ }
     ```
   - `data` shape matches the API response: `{ days: string[],
     columns: { backlog, todo, doing, review, done }, windowDays,
     generatedAt }`.
   - Implementation: pure SVG via `document.createElementNS`. No
     dependencies. Max 200 LOC; if it grows, split into
     `web/charts-axes.js` and `web/charts-bars.js`.

5. **`feat(web): Insights tab with velocity chart + summary cards`**
   - New files: `web/insights.js`.
   - Modifies: `web/index.html` (add tab button + tab pane), `web/app.js`
     (register `insights` in `activateTab`'s valid array + lazy-mount).
   - The tab mounts on `data-tab="insights"`. Fetches
     `/api/insights/velocity`, computes summary cards (tasks done =
     `sum(columns.done)`, avg lead time = derived from
     `first-move-into-doing → move-into-done` per task, busiest day =
     `argmax(sum-of-five-columns-per-day)`).
   - Empty-state path: if every bucket is zero, show the empty
     illustration + caption.
   - Adds `<script src="charts.js" defer></script>` and
     `<script src="insights.js" defer></script>` in `web/index.html`
     before `<script src="app.js" defer></script>`.
   - Exposes `window.OpenKanInsights = { mount(root), unmount() }`,
     matching the existing pattern for `OpenKanChangelog`,
     `OpenKanContributors`, etc.

6. **`feat(web): logo + favicon in app shell`**
   - `web/index.html`: replace the topbar `<span class="logo">` and
     `<h1>OpenKan</h1>` with `<img src="./brand/logo-wordmark.svg"
     alt="OpenKan" height="24" class="brand-wordmark">`. Add the
     favicon `<link>` in `<head>`.
   - `web/style.css`: add only the `.brand-wordmark` rule (new class,
     per scope). No other edits.
   - Confirms: the topbar logo replacement does not break
     `web/workspace.css`'s `.logo` class (different file, different
     selector, out of scope).

7. **`docs: prepend brand banners to README and docs/`**
   - `README.md`: after the H1, add `![OpenKan banner](./web/brand/banner.svg)`.
   - `docs/OK-PLANNING.md`: after the H1, add `![Planning banner](./web/brand/banner-docs.svg)`.
   - `docs/CLAUDE-NATIVE.md`: after the H1, add `![Claude-native banner](./web/brand/banner-docs.svg)`.
   - No body content changes. Image alt-text describes the section.

If any phase grows past ~300 LOC, split it (per the brief). The
biggest split risk is `web/insights.js` if summary-card math gets
involved — extract `web/insights-summary.js` if so.

### Tests — required (`npm test` target 450+ passing)

**`tests/insights.test.mts`** — new file:
- Empty changelog → zero-filled arrays of length 30.
- 30-day window truncates correctly (events older than 30 days ignored).
- Mixed event kinds aggregate per day and per column: emit 5 events
  on day T across 3 columns, verify the bucket counts.
- JSONL parse error in one line does not abort the whole computation:
  inject a corrupt line among 5 valid lines, verify the 5 valid lines
  are counted and the corrupt line is skipped.

**`tests/charts.test.mts`** — new file:
- `renderStackedBar` produces 30 bars and up to 150 segments (30 days
  × 5 columns). Verify `svgEl.querySelectorAll("rect").length` and
  `svgEl.querySelectorAll("title").length`.
- Zero-data renders the empty-state path without throwing (the
  caller decides whether to invoke the empty path; this test only
  asserts `renderStackedBar` does not throw on zero data and the
  caller-side check `isAllZero(data)` returns true).

### Open questions for the implementer

- [ ] **`task.moved` payload quirk (`kanban/server.ts:645`).** The
      existing emit writes `payload: { from: patch.column }`, but
      `patch.column` at that point is the *destination* (the patch
      was already applied to `task.column` at line 600). This is
      outside the route-registration scope, so the aggregator in
      `kanban/insights.ts` must derive the destination from
      `summary` (regex parse) and infer the source from the most
      recent prior `task.moved` for the same taskId. Flag this for
      future cleanup; do NOT fix `server.ts` in this work.
- [ ] **`task.created` initial column.** When a task is created, its
      first `task.moved` event has no prior move to derive the source
      from. The aggregator currently treats the first move as a
      move-into with no matching move-out, which under-counts "done"
      by the number of tasks created directly into `done`. Acceptable
      for v1; revisit if the chart's `done` totals look wrong.
- [ ] **Average lead time semantics.** The brief says "first-move-into-doing
      → move-into-done". If a task never moved through `doing`
      (created directly into `done`), exclude it from the average.
      Document this exclusion in the Insights tab microcopy or in a
      tooltip on the "Avg lead time" card.
- [ ] **Conflict pre-staging with `feat/chat-orchestrator-sidebar`.**
      That branch is touching the same files (`web/index.html`,
      `web/app.js`, `web/style.css`, `kanban/server.ts`). The
      orchestrator resolves. See `HEADS-UP.md` for the planned touch
      list.

## Open questions
- [ ] Whether a future release should offer list and timeline views in addition
  to the board; owner: product; impact: information architecture.
- [ ] Whether Bizar connection health should appear in the global header;
  owner: integration; impact: cross-surface status design.
- [ ] Brand mark variants (light-theme `social-card.svg`); owner: design.
- [ ] Insights chart: optional second view (cumulative done over time); owner:
  product; impact: chart surface complexity.
