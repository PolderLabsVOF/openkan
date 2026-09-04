// tests/tsx-sandbox.test.mjs — unit tests for kanban/tsx-sandbox.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { compileTsx, buildSandboxHtml, buildPreview } from "../kanban/tsx-sandbox.ts";

describe("tsx-sandbox", () => {
  describe("compileTsx", () => {
    it("compiles a simple Button TSX", async () => {
      const source = `const App = () => <Button label="Hello" />;`;
      const result = await compileTsx(source);
      assert.ok(result.js, "should have compiled JS: " + (result.error ?? ""));
      assert.ok(!result.error, "should not have error");
    });

    it("compiles a Card with Row and Text", async () => {
      const source = `const App = () => <Card><Row><Text text="Hi" /></Row></Card>;`;
      const result = await compileTsx(source);
      assert.ok(result.js, "compile error: " + (result.error ?? ""));
      assert.ok(!result.error);
    });

    it("rejects useState (hook)", async () => {
      const source = `const [x, setX] = useState(0); const App = () => <Button label={String(x)} />;`;
      const result = await compileTsx(source);
      assert.ok(result.error, "should reject useState");
      assert.ok(result.error!.includes("useState"), "error should mention useState");
    });

    it("rejects useEffect", async () => {
      const source = `useEffect(() => {}, []); const App = () => <Button label="x" />;`;
      const result = await compileTsx(source);
      assert.ok(result.error?.includes("useEffect"));
    });

    it("rejects custom useXxx hooks", async () => {
      const source = `const x = useCustom(); const App = () => <Button label="x" />;`;
      const result = await compileTsx(source);
      assert.ok(result.error?.includes("useCustom"));
    });

    it("allows builtin functions (Button, Card, etc.)", async () => {
      const source = `const App = () => <Card><Heading text="Title" /><Text text="Body" /></Card>;`;
      const result = await compileTsx(source);
      assert.ok(!result.error, "builtins should be allowed: " + (result.error ?? ""));
    });

    it("rejects source exceeding maxBytes", async () => {
      const source = "const x = ".repeat(10000) + "0; const App = () => <Button label='x' />;";
      const result = await compileTsx(source, { maxBytes: 100 });
      assert.ok(result.error?.includes("bytes limit"));
    });
  });

  describe("buildSandboxHtml", () => {
    it("escapes </script> in JS code", () => {
      const js = "const x = '</script><img src=x>';";
      const html = buildSandboxHtml(js, "{}");
      // Find the part of the HTML that contains the user's JS code
      const jsPartIdx = html.indexOf("const x = ");
      assert.ok(jsPartIdx >= 0, "user JS should be in the output");
      const jsPart = html.substring(jsPartIdx, jsPartIdx + 50);
      assert.ok(!jsPart.includes("</script><img"), "raw </script> should be escaped in JS context");
      // The browser-safe escape is <\/script>
      assert.ok(jsPart.includes("<\\/script>") || jsPart.includes("\\\\/script>"), "escaped </script> should be present");
    });

    it("escapes </iframe> in JS code", () => {
      const js = "const x = '</iframe>';";
      const html = buildSandboxHtml(js, "{}");
      const jsPartIdx = html.indexOf("const x = ");
      const jsPart = html.substring(jsPartIdx, jsPartIdx + 30);
      assert.ok(!jsPart.includes("</iframe>"), "raw </iframe> should be escaped in JS context");
    });

    it("escapes quotes in props JSON", () => {
      const props = JSON.stringify({ label: 'say "hi"' });
      const html = buildSandboxHtml("const App = () => <Button label='hi' />;", props);
      // The escapedProps is embedded as: window.render({...escapedProps...})
      // Check that raw quotes don't break the script
      const renderCallIdx = html.indexOf("window.render");
      const renderCall = html.substring(renderCallIdx, renderCallIdx + 100);
      assert.ok(!renderCall.includes('"say "hi""'), "quotes should be escaped");
    });

    it("contains BUILTIN_LIBRARY and RUNTIME", () => {
      const html = buildSandboxHtml("const App = () => <Button label='x' />;", "{}");
      assert.ok(html.includes("ok-btn"), "should include button class");
      assert.ok(html.includes("openkan"), "should expose window.ok");
    });

    it("returns a valid srcdoc HTML document", () => {
      const html = buildSandboxHtml("const App = () => <Button label='x' />;", "{}");
      assert.ok(html.includes("<!doctype html>"));
      assert.ok(html.includes("<html>"));
      assert.ok(html.includes("</html>"));
      assert.ok(html.includes("<meta charset"));
    });
  });

  describe("buildPreview", () => {
    it("full pipeline: compile + sandbox", async () => {
      const result = await buildPreview(`const App = () => <Card><Button label="Go" /></Card>;`);
      assert.ok(!result.error, "preview error: " + (result.error ?? ""));
      assert.ok(result.sandboxHtml);
      assert.ok(result.sandboxHtml!.includes("<!doctype html>"));
    });
  });
});
