// tests/web-create-no-open.test.mts — regression test for tsk-Ier_PqTd:
// creating a task from the board must NOT auto-open the new task.
// The submit handler reads `openAfterCreate` from the form and only opens
// the new task when the checkbox is checked. The default state of that
// checkbox therefore controls board-level UX: it must be unchecked by
// default so users stay on the tasks/board page after creating a task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('web/index.html', 'utf8');
const app = readFileSync('web/app.js', 'utf8');

test('openAfterCreate checkbox defaults to unchecked so board-level creation stays on the board', () => {
  // Match the new-task modal's "Open task after creating" checkbox.
  const m = html.match(/<input[^>]*name="openAfterCreate"[^>]*>/);
  assert.ok(m, 'expected openAfterCreate input in new-task modal');
  const inputTag = m![0];
  assert.doesNotMatch(
    inputTag,
    /\bchecked\b/,
    `openAfterCreate checkbox must NOT default to checked — got: ${inputTag}`,
  );
});

test('submit handler still gates the auto-open on the openAfterCreate flag', () => {
  // The create-task POST must remain conditional on the checkbox so the
  // opt-in path keeps working.
  assert.match(
    app,
    /const openAfterCreate = fd\.get\("openAfterCreate"\) === "on"/,
    'submit handler must read openAfterCreate from the form',
  );
  assert.match(
    app,
    /if \(openAfterCreate\) window\.OpenKanTaskView\?\.open\?\.\(res\.id\)/,
    'submit handler must only call OpenKanTaskView.open when the flag is on',
  );
});

test('draft restoration preserves an explicit openAfterCreate opt-in', () => {
  // The user may still check the box; the draft-restoration logic must keep
  // honoring that explicit choice across re-opens.
  assert.match(
    app,
    /form\.elements\.openAfterCreate\.checked = draft\.openAfterCreate === "on"/,
    'modal open must restore openAfterCreate from a saved draft',
  );
});
