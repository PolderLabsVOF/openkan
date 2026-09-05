// tests/web-subtask-nesting.test.mts — regression coverage for the
// board-level subtask nesting fix.
//
// User-reported bug (verbatim):
//   "in the tasks view when i crerate subtasks inside a tasks they get
//    displayes as seperate task cards, they need to be included in the
//    top level task as a dropdown or something."
//
// Acceptance criteria this suite guards:
//   1. Subtasks are filtered out of the top-level kanban columns — only
//      the parent card appears in the column body.
//   2. The parent card contains a <details class="card-subtasks"> element
//      with each child rendered as a checkbox row.
//   3. The disclosure is collapsed by default (no `open` attribute).
//   4. The summary text reads "Subtasks (N)" where N matches
//      parent.subtaskIds.length.
//   5. Each expanded subtask row has a checkbox input bound to a done
//      toggle (PATCH /api/tasks/:id with { state }).
//   6. Subtask rows inside a parent card do NOT carry draggable="true"
//      and must not be droppable to other columns (parent-only drag).
//
// The harness here is string-analysis on web/app.js + web/workspace.css,
// matching the convention used by tests/web-task-panel-tighten.test.mts
// and tests/scrollbar-tasks.test.mts. No DOM stub, no jsdom — keeps the
// suite in plain Node + node:test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const appJs = readFileSync(resolve(root, 'web/app.js'), 'utf8');
const workspaceCss = readFileSync(resolve(root, 'web/workspace.css'), 'utf8');

const COLUMNS_IDS = ['backlog', 'todo', 'doing', 'review', 'done'];

test('renderBoard filters tasks whose parentId is non-null', () => {
  // The fix is one well-placed continue. We anchor on the `byColumn`
  // grouping loop so a refactor that drops the filter (or accidentally
  // moves it outside the loop) is caught here.
  const loopMatch = appJs.match(/const byColumn = new Map\(\);[\s\S]*?for \(const t of tasks\.values\(\)\) \{[\s\S]*?\}\n\s*\}/);
  assert.ok(loopMatch, 'expected the byColumn grouping loop in renderBoard');
  const loopBody = loopMatch![0];
  assert.match(
    loopBody,
    /if\s*\(\s*t\.parentId\s*\)\s*continue\s*;?/,
    'renderBoard must skip tasks with a non-null parentId so subtasks never render as sibling cards',
  );
});

test('renderCard renders a <details class="card-subtasks"> for parents with children', () => {
  assert.match(
    appJs,
    /el\(\s*"details"\s*,\s*"card-subtasks"\s*\)/,
    'renderCard must create a <details class="card-subtasks"> disclosure element',
  );
});

test('card-subtasks disclosure is collapsed by default — no `open` attribute', () => {
  // The el() helper sets attributes via `setAttribute(k, v)` for non-text
  // properties. If the props object passed to el() contains `open: true`,
  // the rendered element will carry `open="true"` and the disclosure will
  // be expanded on first paint. We grep for `open:` in the props arg of
  // the card-subtasks constructor call to make sure nobody adds it back.
  const callMatch = appJs.match(/el\(\s*"details"\s*,\s*"card-subtasks"\s*,\s*\{[\s\S]*?\}\s*\)/);
  // The factory call may use 0, 1, 2 or 3 positional args. If the
  // implementation passes a props object, capture it and ensure it does
  // not include `open`. If no props object, the disclosure is collapsed
  // by construction — which is what we want.
  if (callMatch) {
    const props = callMatch[0];
    assert.doesNotMatch(
      props,
      /\bopen\s*:\s*(true|"true")\b/,
      'card-subtasks disclosure must NOT be constructed with `open: true`; collapse by default',
    );
  } else {
    // Two-arg form (no props) is also acceptable — that's the default
    // collapsed state. Pass.
  }
  // Belt-and-braces: also assert there's no `.open` method call on the
  // details object in the same scope (which would force-open it).
  const detailsScope = appJs.match(/const details = el\(\s*"details"\s*,\s*"card-subtasks"[\s\S]*?card\.append\(details\)/);
  if (detailsScope) {
    assert.doesNotMatch(
      detailsScope[0],
      /details\.open\s*=\s*true/,
      'details.open must not be force-set to true (would expand on first paint)',
    );
  }
});

test('card-subtasks summary text reads "Subtasks (N)"', () => {
  const summaryMatch = appJs.match(/el\(\s*"summary"\s*,\s*"card-subtasks-summary"[\s\S]*?\}\s*\)/);
  assert.ok(summaryMatch, 'expected a card-subtasks-summary factory call');
  // Match either template-literal style (`Subtasks (${...})`) or plain
  // string concat. The simpler invariant: the literal word "Subtasks"
  // followed by an interpolation/concat of children.length, so the
  // rendered count stays in sync with parent.subtaskIds.length.
  const summaryText = summaryMatch![0];
  assert.match(
    summaryText,
    /"summary"\s*,\s*"card-subtasks-summary"/,
    'factory call must target card-subtasks-summary',
  );
  // The text must include the literal "Subtasks (".
  assert.match(summaryText, /Subtasks\s*\(/, 'summary text must start with "Subtasks ("');
  // And must reference children.length (the most-current child count
  // pulled from the in-memory `tasks` map).
  assert.match(
    summaryText,
    /children\.length/,
    'summary text must include children.length so it stays in sync with parent.subtaskIds.length',
  );
});

test('each subtask row exposes a checkbox bound to a done toggle', () => {
  // The checkbox is the actionable affordance — without it the disclosure
  // would just be a list of titles.
  const checkboxMatch = appJs.match(/el\(\s*"input"\s*,\s*"card-subtask-checkbox"[\s\S]*?\}\s*\)/);
  assert.ok(checkboxMatch, 'expected a card-subtask-checkbox factory call');
  assert.match(
    checkboxMatch![0],
    /type:\s*"checkbox"/,
    'the input must be of type="checkbox"',
  );
  // The toggle handler must call PATCH on /api/tasks/:id with { state }.
  // We accept either the bare "done" terminal state or a generic toggle
  // between two states — what matters is that the change event actually
  // mutates the subtask's state.
  const rowBlock = appJs.match(/checkbox\.addEventListener\(\s*"change"[\s\S]*?\}\);/);
  assert.ok(rowBlock, 'expected a change-event handler on the subtask checkbox');
  assert.match(
    rowBlock![0],
    /api\(\s*"PATCH"\s*,\s*`\/api\/tasks\/\$\{c\.id\}`/,
    'change handler must PATCH /api/tasks/<id>',
  );
  assert.match(
    rowBlock![0],
    /state:\s*next/,
    'PATCH body must include `state` so the subtask can flip between done/idle',
  );
});

test('subtask rows are NOT draggable — parent card owns the drag handle', () => {
  // The cleanest assertion: the row's props object (or factory call) sets
  // draggable="false" explicitly. This is a regression guard for the
  // acceptance criterion "Subtasks are not individually movable".
  const rowMatch = appJs.match(/el\(\s*"label"\s*,\s*"card-subtask-row[^"]*"[\s\S]*?\}\s*\)/);
  assert.ok(rowMatch, 'expected a card-subtask-row factory call');
  assert.match(
    rowMatch![0],
    /draggable:\s*"false"/,
    'subtask rows must be constructed with draggable:"false" so they do not pick up the parent card\'s drag',
  );

  // Also: there must be no `attachDnD(row)` or similar per-row drag
  // wiring. We grep for any call to attachDnD inside the row construction
  // block to make sure subtasks aren't independently hooked up to the
  // drop targets.
  const renderCardBody = appJs.match(/function renderCard[\s\S]*?return card;\s*\}/);
  assert.ok(renderCardBody, 'renderCard function must still exist');
  const subtaskBlock = renderCardBody![0].match(/card-subtasks[\s\S]*?card\.append\(details\)/);
  assert.ok(subtaskBlock, 'card-subtasks block must exist within renderCard');
  assert.doesNotMatch(
    subtaskBlock![0],
    /attachDnD\(/,
    'subtask rows must not be passed to attachDnD — parent card is the only drag target',
  );
});

test('click inside a subtask row does not bubble up to open the parent card', () => {
  // The parent's click handler opens the task view. The subtask row must
  // stopPropagation so a checkbox toggle doesn't also open the parent.
  const rowClick = appJs.match(/row\.addEventListener\(\s*"click"[\s\S]*?\}\);/);
  assert.ok(rowClick, 'expected a click handler on the subtask row');
  assert.match(
    rowClick![0],
    /ev\.stopPropagation\(\)/,
    'subtask row click handler must call stopPropagation',
  );
});

test('subtask rows are not pushed into any kanban column — only the parent is', () => {
  // We check that the column body builder never sees a subtask. The
  // for-loop that renders cards inside each column is:
  //   for (const t of colTasks) body.append(renderCard(t));
  // By construction (criterion #1), colTasks only contains tasks whose
  // parentId is null — so renderCard is never called with a subtask.
  // We verify the structural invariant here.
  const loopMatch = appJs.match(/for \(const col of COLUMNS\)/);
  assert.ok(loopMatch, 'expected the COLUMNS render loop in renderBoard');

  // The grouping loop runs immediately before this; the `if (t.parentId)
  // continue` assertion already passed. Together those two invariants
  // guarantee the column body never receives a subtask card.
  assert.match(appJs, /if\s*\(\s*t\.parentId\s*\)\s*continue\s*;?/);
});

test('CSS provides .card-subtasks, .card-subtasks-summary, .card-subtask-row, .card-subtask-row-done', () => {
  // Visual contract: the new components must have styling rules. Each
  // class is required by name and by a sane property (e.g. cursor on the
  // summary so it reads as a disclosure control).
  assert.match(workspaceCss, /\.card-subtasks\s*\{/, 'must define .card-subtasks');
  assert.match(workspaceCss, /\.card-subtasks-summary\s*\{/, 'must define .card-subtasks-summary');
  assert.match(workspaceCss, /\.card-subtasks-summary\s*\{[^}]*cursor:\s*pointer/m, 'summary must have cursor:pointer');
  assert.match(workspaceCss, /\.card-subtasks-list\s*\{/, 'must define .card-subtasks-list');
  assert.match(workspaceCss, /\.card-subtask-row\s*\{/, 'must define .card-subtask-row');
  assert.match(workspaceCss, /\.card-subtask-checkbox\s*\{/, 'must define .card-subtask-checkbox');
  assert.match(workspaceCss, /\.card-subtask-row-done\s*\{/, 'must define .card-subtask-row-done (done state styling)');

  // The chevron must rotate when the disclosure is open — same idiom as
  // the existing task-meta-details disclosure in style.css.
  assert.match(
    workspaceCss,
    /\.card-subtasks\[open\][^{]*\.card-subtasks-summary::before[\s\S]*?transform:\s*rotate/,
    'open-state must rotate the chevron on the summary',
  );

  // Suppress the native disclosure marker so the chevron is the only
  // visible affordance.
  assert.match(
    workspaceCss,
    /\.card-subtasks-summary::-webkit-details-marker\s*\{\s*display:\s*none/,
    'must suppress the default webkit disclosure marker',
  );
});

test('subtask badge on parent card header is still emitted (visual counter)', () => {
  // The brief is explicit: the existing card-subtask-badge stays on the
  // card header as a quick counter. The new disclosure is the actionable
  // UI; the badge is the at-a-glance count.
  assert.match(
    appJs,
    /el\(\s*"span"\s*,\s*"card-subtask-badge"/,
    'card-subtask-badge factory call must remain in renderCard',
  );
});

test('all five kanban columns exist (no schema drift)', () => {
  // Sanity: make sure the test fixtures and the production code agree on
  // column ids. If anyone renames a column, the regression coverage
  // above still works because we matched on patterns rather than column
  // names — but this test catches accidental drift so future readers
  // know the invariant.
  for (const id of COLUMNS_IDS) {
    assert.ok(
      new RegExp(`id:\\s*"${id}"`).test(appJs) ||
        new RegExp(`COLUMNS\\s*=[\\s\\S]*?id:\\s*"${id}"`).test(appJs),
      `column id "${id}" must exist in COLUMNS array`,
    );
  }
});
