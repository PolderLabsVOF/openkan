import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The chat sidebar is an IIFE — only the public OpenKanChatSidebar surface is
// exported. We re-execute the source inside a sandboxed Function with extra
// instrumentation that exposes the internal render helpers so the DOM shape
// of the activity / status rows can be asserted.
const source = readFileSync(resolve('web/chat-sidebar.js'), 'utf8');

function loadHelpers() {
  const window: any = { addEventListener() {}, OpenKanAPI: { api: async () => ({}) } };
  const document = { readyState: 'loading', addEventListener() {}, createElement: () => ({ classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] }) };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const instrumented = source.replace(
    '  window.OpenKanChatSidebar =',
    `window.testChat = {
      state,
      chipHTML,
      activitySummaryHTML,
      renderLiveActivity,
      setup() {
        state.root = {
          querySelector: () => ({
            appendChild() {}, querySelector: () => null, querySelectorAll: () => []
          })
        };
      }
    };
    window.OpenKanChatSidebar =`
  );
  new Function('window', 'document', 'localStorage', instrumented)(window, document, localStorage);
  window.testChat.setup();
  return window.testChat;
}

// Count disclosure indicators attached to a single logical status element.
// A "disclosure indicator" is anything that visually communicates
// expand/collapse: an inline <svg> chevron, a `::after`/`::before` pseudo
// selector that injects a chevron glyph, or a literal `>` / `▾` / `⌄` / `▶`
// character used as a marker. This helper counts the markers that the live
// DOM will actually render after CSS is applied.
function countDisclosureIndicators(html: string, cssText: string, selector: string): number {
  // Pull the CSS rule for the given selector out of style.css (very narrow
  // match — we only look for the .chat-activity-summary family because that
  // is where the legacy `::after { content: "⌄" }` rule lived).
  const pseudoMatch = cssText.match(new RegExp(`\\.chat-activity-summary[^{]*::(after|before)\\s*{([^}]+)}`, 'g')) || [];
  let pseudoCount = 0;
  for (const rule of pseudoMatch) {
    if (/content\s*:\s*(?:"[^"]*"|'[^']*'|none)/.test(rule)) {
      const m = rule.match(/content\s*:\s*"([^"]*)"/) || rule.match(/content\s*:\s*'([^']*)'/);
      if (m && m[1] && /[⌄▾▶◀›»←↑↓>]/.test(m[1])) pseudoCount += 1;
    }
  }
  // Count explicit chevron SVGs and literal glyphs in the rendered HTML.
  const svgChevrons = (html.match(/<svg[^>]*class="[^"]*chevron/gi) || []).length;
  const literalGlyphs = (html.match(/[⌄▾▶◀]/g) || []).length;
  // The summary itself is a <details>, so the browser always draws a default
  // disclosure marker unless the stylesheet suppresses it via
  // `::-webkit-details-marker { display: none }` AND `list-style: none`.
  const suppressesNativeMarker = /\.chat-activity-summary[^{]*::?-webkit-details-marker\s*{\s*display\s*:\s*none/.test(cssText);
  const nativeMarkerCount = suppressesNativeMarker ? 0 : 1;
  return pseudoCount + svgChevrons + literalGlyphs + nativeMarkerCount;
}

const cssText = readFileSync(resolve('web/style.css'), 'utf8');

test('activitySummaryHTML emits at most one disclosure indicator for the summary row', () => {
  const helpers = loadHelpers();
  const html = helpers.activitySummaryHTML({
    role: 'assistant',
    ts: '2026-09-05T15:00:00Z',
    durationMs: 101000,
    toolUses: [
      { id: 'tu-1', name: 'Bash', input: { command: 'echo hi' }, status: 'completed' },
      { id: 'tu-2', name: 'Bash', input: { command: 'ls' }, status: 'completed' },
      { id: 'tu-3', name: 'Bash', input: { command: 'pwd' }, status: 'completed' },
      { id: 'tu-4', name: 'Bash', input: { command: 'cat' }, status: 'completed' },
    ],
  });
  // The summary is the outer <details class="chat-activity-summary">.
  const summaryMatch = html.match(/<details class="chat-activity-summary"[\s\S]*?<\/details>/);
  assert.ok(summaryMatch, 'expected the activity summary <details> in rendered HTML');
  const summaryHtml = summaryMatch![0];
  // There must be exactly one disclosure indicator: the SVG chevron inside
  // the summary. The native marker is suppressed by the stylesheet, and the
  // legacy `::after { content: "⌄" }` pseudo must NOT contribute a glyph.
  const indicators = countDisclosureIndicators(summaryHtml, cssText, '.chat-activity-summary');
  assert.equal(indicators, 1, `expected 1 disclosure indicator, got ${indicators}: ${summaryHtml}`);
  // Specifically: the SVG chevron is present, the pseudo-element injects
  // nothing, and no literal glyph slipped in.
  assert.match(summaryHtml, /class="chat-activity-summary__chevron"/);
});

test('chipHTML emits at most one disclosure indicator per chip row', () => {
  const helpers = loadHelpers();
  const html = helpers.chipHTML({
    id: 'tu-1',
    name: 'Bash',
    input: { command: 'echo hi' },
    status: 'completed',
  });
  const svgChevrons = (html.match(/<svg[^>]*class="[^"]*chevron/gi) || []).length;
  // Exactly one SVG chevron inside the summary; the legacy summary::after
  // pseudo must not contribute because the chip stylesheet never had one.
  assert.equal(svgChevrons, 1, `expected 1 chevron SVG, got ${svgChevrons}: ${html}`);
  assert.match(html, /class="chat-activity-row__chevron"/);
  // And no literal chevron glyphs sneaking in.
  assert.doesNotMatch(html, /[⌄▾▶◀]/);
});

test('activitySummaryHTML pseudo-element does not inject a chevron glyph after the fix', () => {
  // Defensive check: even if the pseudo rule remains in the stylesheet for
  // historical reasons, its `content` must be "none" (or otherwise empty),
  // so the rendered row never carries a second disclosure indicator.
  const pseudoRule = cssText.match(/\.chat-activity-summary[^{]*::after\s*{([^}]+)}/);
  assert.ok(pseudoRule, 'expected .chat-activity-summary::after rule in stylesheet');
  const decls = pseudoRule![1];
  const contentMatch = decls.match(/content\s*:\s*"([^"]*)"/) || decls.match(/content\s*:\s*'([^']*)'/);
  if (contentMatch) {
    assert.equal(contentMatch[1], 'none', `::after content must be "none", got "${contentMatch[1]}"`);
  }
});
