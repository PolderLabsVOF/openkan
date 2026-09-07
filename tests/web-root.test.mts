// tests/web-root.test.mts — installed-package web root resolution.
//
// Regression: starting the server from a globally-installed @polderlabs/openkan
// returned 404 for every static asset (index.html, app.js, style.css) because
// OPENKAN_WEB pointed at the source-layout "<pkg>/web" directory. The npm
// `files` list ships `dist/` but not the source `web/` tree, so installed
// packages have no "<pkg>/web" at all — the UI lives under "<pkg>/dist/web".
//
// This test makes sure the resolver returns a directory that actually contains
// at least one of the canonical assets (index.html, app.js, style.css).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPENKAN_WEB } from "../ok/commands/serve.ts";

describe("OPENKAN_WEB resolution", () => {
  it("points at a real directory that ships the dashboard assets", () => {
    assert.ok(existsSync(OPENKAN_WEB), `OPENKAN_WEB does not exist: ${OPENKAN_WEB}`);
    assert.ok(statSync(OPENKAN_WEB).isDirectory(), `OPENKAN_WEB is not a directory: ${OPENKAN_WEB}`);
    // At least one of these must exist for the dashboard to render.
    const candidates = ["index.html", "app.js", "style.css"];
    const found = candidates.find((c) => existsSync(join(OPENKAN_WEB, c)));
    assert.ok(found, `OPENKAN_WEB is missing dashboard assets: ${OPENKAN_WEB}`);
  });
});
