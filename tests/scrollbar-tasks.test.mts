// Regression tests for tsk-WAAfaaL7 — custom subtle scrollbar on the board
// task containers (.column-body). CSS-only — no JS, no third-party library.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("custom scrollbar on board task containers (tsk-WAAfaaL7)", () => {
  const css = read("web/style.css");

  test(".column-body is the scrollable task-list container", () => {
    // The container must actually scroll vertically, otherwise a thinner
    // scrollbar would never be visible.
    const match = css.match(/\.column-body\s*\{[^}]*\}/);
    assert.ok(match, ".column-body { ... } rule must exist");
    assert.match(match![0], /overflow-y:\s*auto/);
    assert.match(match![0], /scrollbar-width:\s*thin/);
  });

  test("Firefox scrollbar-color is set on .column-body using brand tokens", () => {
    // scrollbar-color accepts <thumb> <track>. We expect a brand token (no
    // raw hex / rgba literal) so the rule stays theme-aware.
    const match = css.match(/\.column-body\s*\{[^}]*\}/);
    assert.ok(match, ".column-body { ... } rule must exist");
    assert.match(
      match![0],
      /scrollbar-color:\s*var\(--border-strong\)\s+transparent/,
      "scrollbar-color must use --border-strong for the thumb and a transparent track",
    );
    assert.doesNotMatch(match![0], /scrollbar-color:\s*#[0-9a-f]{3,8}/i);
  });

  test("Webkit/Blink scrollbar pseudo-elements are scoped to .column-body", () => {
    // The base global rule (::-webkit-scrollbar { width: 10px; ... }) still
    // exists for other surfaces; the .column-body override must be a *scoped*
    // pseudo-element rule, not a global one — otherwise chat sidebar / docs
    // panes would inherit the smaller width.
    assert.match(css, /\.column-body::-webkit-scrollbar\s*\{/);
    assert.match(
      css,
      /\.column-body::-webkit-scrollbar\s*\{[^}]*width:\s*8px/,
      "scoped width must be 8px (subtle, thinner than the 10px global)",
    );
    assert.match(css, /\.column-body::-webkit-scrollbar-track\s*\{/);
    assert.match(css, /\.column-body::-webkit-scrollbar-thumb\s*\{/);
    assert.match(
      css,
      /\.column-body::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border-strong\)/,
      "thumb must use --border-strong brand token",
    );
    assert.match(
      css,
      /\.column-body::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*2px solid transparent/,
      "thumb needs a transparent border so background-clip:padding-box yields a pill",
    );
    assert.match(
      css,
      /\.column-body::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*padding-box/,
      "background-clip: padding-box keeps the rounded thumb from leaking past the border",
    );
    assert.match(
      css,
      /\.column-body::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--border\)/,
      "hover should step up to --border so the affordance reads as interactive",
    );
  });

  test("base global ::-webkit-scrollbar is preserved (other surfaces untouched)", () => {
    // Sanity: the broad rule that styles every scroll surface must still be
    // present. If a future refactor accidentally removes the global rule
    // while carrying only the .column-body override, other surfaces (chat
    // popovers, docs panes, etc.) would lose their themed scrollbars.
    assert.match(css, /::-webkit-scrollbar\s*\{[^}]*width:\s*10px/);
    assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border\)/);
  });

  test("chat sidebar and docs selectors are explicitly NOT retargeted", () => {
    // We must not have accidentally added .column-body to the docs scrollbar
    // group, nor restyled the chat sidebar transcript.
    assert.doesNotMatch(
      css,
      /\.docs-file-list,\s*\.docs-stage,\s*\.docs-source-panel[^\n]*\.column-body/,
    );
    assert.doesNotMatch(
      css,
      /\.chat-sidebar__transcript::-webkit-scrollbar/,
    );
  });
});
