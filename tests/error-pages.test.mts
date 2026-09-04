import assert from "node:assert/strict";
import test from "node:test";
import { browserErrorPage, requestErrorResponse } from "../kanban/server.ts";

test("browser 404 page is branded, non-cacheable, and escapes the requested route", async () => {
  const response = browserErrorPage(404, "/missing/<script>alert(1)</script>");
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /<title>404 — Page not found · OpenKan<\/title>/);
  assert.match(body, /Open workspace/);
  assert.match(body, /\/missing\/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /Requested route: <code>\/missing\/<script>/);
});

test("browser 500 page explains recovery without exposing server internals", async () => {
  const response = browserErrorPage(500, "/tasks");
  const body = await response.text();

  assert.equal(response.status, 500);
  assert.match(body, /Workspace error/);
  assert.match(body, /Your project files are still safe/);
  assert.match(body, /Requested route: <code>\/tasks<\/code>/);
});

test("API failures remain JSON even when a client advertises HTML support", async () => {
  const request = new Request("http://localhost/api/unknown", {
    headers: { accept: "text/html,application/json" },
  });
  const response = requestErrorResponse(request, 404, "Not found");

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("browser navigation selects the custom HTML page", async () => {
  const request = new Request("http://localhost/missing", { headers: { accept: "text/html" } });
  const response = requestErrorResponse(request, 404, "Not found");

  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await response.text(), /This workspace page does not exist/);
});
