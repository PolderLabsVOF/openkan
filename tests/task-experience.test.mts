import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync('web/app.js', 'utf8');
const html = readFileSync('web/index.html', 'utf8');
test('task creation discloses optional agent settings and explains project scope', () => {
  assert.match(html, /<details[^>]*class="task-create-options"/);
  assert.match(html, /id="task-create-project"/);
  assert.match(html, /id="task-create-error"[^>]*role="alert"/);
});
test('task creation retains input until the API succeeds and prevents double submission', () => {
  const start = app.indexOf('form.addEventListener("submit", async (e) =>', app.indexOf('function openModal'));
  const flow = app.slice(start, app.indexOf('// ---------- Tab router', start));
  assert.match(flow, /if \(creatingTask\) return/);
  assert.ok(flow.indexOf('await api("POST", "/api/tasks", body)') < flow.indexOf('form.reset()'));
  assert.doesNotMatch(flow, /alert\(/);
  assert.match(flow, /finally/);
});
test('task dialog supports focus return, drafts and keyboard submission', () => {
  assert.match(app, /taskModalReturnFocus\?\.focus/);
  assert.match(app, /saveTaskDraft/);
  assert.match(app, /form\.requestSubmit\(\)/);
});
