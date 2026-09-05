// tests/web-task-panel-tighten.test.mts — regression test for tsk-KNQwScRg:
// tighten the opened-task panel by collapsing the secondary metadata
// (column, category, priority, effort, runner, source, created/updated
// timestamps) behind a native <details> "Show details" toggle. The
// primary context — stale warning, assignees, last activity, tags — stays
// always visible. The priority pill in the metadata strip is intentionally
// dropped because it duplicates the priority pill in the header status
// column. Nothing is deleted — every field remains reachable via the
// toggle, the always-visible row, or both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const taskView = readFileSync('web/task-view.js', 'utf8');
const style = readFileSync('web/style.css', 'utf8');

test('renderMetadata uses a native <details> "Show details" toggle', () => {
  // The toggle must be present and obvious — the user explicitly called
  // out that hidden controls must be obvious.
  assert.match(
    taskView,
    /el\("details",\s*"task-meta-details"\)/,
    'renderMetadata must wrap secondary metadata in a .task-meta-details element',
  );
  assert.match(
    taskView,
    /el\("summary",\s*"task-meta-details-toggle",\s*\{\s*text:\s*"Show details"/,
    'renderMetadata must render a summary labelled "Show details"',
  );
});

test('priority in the metadata strip is moved into the collapsed details', () => {
  // Before tsk-KNQwScRg the priority lived in the always-visible dl —
  // duplicating the priority pill in the header status column. The
  // tightened layout moves it into the detailDl via pushDetail().
  // Stripping it from the always-visible path is the whole point of the
  // pass, so we lock that behavior in.
  // The always-visible dl must NOT contain a Priority <dt>.
  // Look at the body of the function between `function renderMetadata`
  // and the construction of `detailDl`.
  const fnMatch = taskView.match(/function renderMetadata[\s\S]*?const detailDl = el\("dl"/);
  assert.ok(fnMatch, 'expected renderMetadata function body before detailDl construction');
  const primaryDlBody = fnMatch![0];
  assert.doesNotMatch(
    primaryDlBody,
    /el\("dt",\s*null,\s*\{\s*text:\s*"Priority"\s*\}\)/,
    'Priority <dt> must NOT appear in the always-visible dl (it duplicates the header pill)',
  );

  // And the detailDl block must still surface priority via pushDetail().
  assert.match(
    taskView,
    /pushDetail\(\s*"Priority"/,
    'Priority must still be reachable via pushDetail in the collapsed details block',
  );
});

test('assignees, tags, last activity stay in the always-visible area', () => {
  // The user named assignees + tags + recent activity as "front and
  // center" content, so they must remain above the fold.
  const fnMatch = taskView.match(/function renderMetadata[\s\S]*?const detailDl = el\("dl"/);
  assert.ok(fnMatch, 'expected renderMetadata function body before detailDl construction');
  const primaryDlBody = fnMatch![0];

  assert.match(primaryDlBody, /text:\s*"Assignees"/, 'Assignees row must stay always-visible');
  assert.match(
    primaryDlBody,
    /el\("dd",\s*"meta-last-activity"/,
    'Last activity must stay always-visible (it is the recent-activity anchor)',
  );
  // Tags row is rendered after the dl, in a separate .meta-tag-row div.
  assert.match(
    taskView,
    /el\("div",\s*"meta-tag-row"\)/,
    'Tags row must still render in the metadata strip',
  );
});

test('column, category, effort, runner, source, created, updated go into the details block', () => {
  // Every field the user flagged as "a lot going on" must end up behind
  // the toggle. We check by name (each is added via pushDetail or via
  // .append on detailDl).
  for (const label of ['Column', 'Category', 'Effort', 'Runner', 'Source', 'Created', 'Updated']) {
    assert.match(
      taskView,
      new RegExp(`pushDetail\\(\\s*"${label}"`),
      `${label} must be added via pushDetail (i.e. inside the collapsed details block)`,
    );
  }
});

test('stale warning stays always-visible (it is a critical action signal)', () => {
  const fnMatch = taskView.match(/function renderMetadata[\s\S]*?const detailDl = el\("dl"/);
  assert.ok(fnMatch, 'expected renderMetadata function body before detailDl construction');
  const primaryDlBody = fnMatch![0];
  assert.match(primaryDlBody, /meta-stale/, 'Stale warning must live in the always-visible dl');
});

test('CSS gives the toggle an obvious caret and a focus ring', () => {
  // Custom caret so the toggle reads as a disclosure control even with
  // ::-webkit-details-marker suppressed.
  assert.match(
    style,
    /\.task-meta-details-toggle\s*{[^}]*cursor:\s*pointer/,
    'toggle must have cursor:pointer',
  );
  assert.match(
    style,
    /\.task-meta-details-toggle::before\s*{[^}]*content:\s*"[^"]*"/,
    'toggle must render a custom ::before marker (e.g. ▸)',
  );
  assert.match(
    style,
    /\.task-meta-details-toggle:focus-visible/,
    'toggle must have a focus-visible ring for keyboard users',
  );
  // The caret rotates when the details block is open.
  assert.match(
    style,
    /\.task-meta-details\[open\][^{]*::before/,
    'open-state must rotate the caret',
  );
});

test('CSS strips the default disclosure marker so we render our own', () => {
  assert.match(
    style,
    /\.task-meta-details-toggle::-webkit-details-marker/,
    'must override the default webkit disclosure marker',
  );
});

test('CSS hides the detail dl behind the toggle via padding/border', () => {
  // The collapsed dl should be visually nested under the toggle (left
  // border + padding) so it reads as a sub-section, not a fresh block.
  assert.match(
    style,
    /\.meta-dl-details\s*{[^}]*border-left/,
    '.meta-dl-details must have a left border to nest visually under the toggle',
  );
});
