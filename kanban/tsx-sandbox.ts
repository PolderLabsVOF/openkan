// OpenKan — TSX compile + sandbox iframe HTML builder.

import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompileResult {
  js?: string;
  error?: string;
}

export interface PreviewResult {
  js?: string;
  sandboxHtml?: string;
  error?: string;
}

// ─── Hook detection (compile-time safety) ────────────────────────────────────

const HOOK_PATTERN = /\buse[A-Z][a-zA-Z0-9_]*/;
const BUILTIN_FUNCTIONS = new Set([
  "Button", "Card", "Row", "Column", "Text", "Heading", "Image", "ColorSwatch", "Code",
  "h", "render", "respond",
]);

function checkHooks(source: string): string | null {
  // Find all useXXX identifiers that aren't in BUILTIN_FUNCTIONS
  const matches = source.matchAll(/\buse[A-Z][a-zA-Z0-9_]*/g);
  for (const m of matches) {
    const name = m[0];
    if (!BUILTIN_FUNCTIONS.has(name)) {
      return `Hooks (${name}) are not supported in sandbox TSX. Use plain functions instead.`;
    }
  }
  return null;
}

// ─── Compile TSX ─────────────────────────────────────────────────────────────

const MAX_BYTES_DEFAULT = 32768;

export async function compileTsx(
  source: string,
  opts?: { maxBytes?: number },
): Promise<CompileResult> {
  const maxBytes = opts?.maxBytes ?? MAX_BYTES_DEFAULT;
  if (Buffer.byteLength(source, "utf-8") > maxBytes) {
    return { error: `TSX source exceeds ${maxBytes} bytes limit.` };
  }

  const hookError = checkHooks(source);
  if (hookError) return { error: hookError };

  try {
    // Lazy import sucrase
    const { default: sucrase } = await import("sucrase") as any;
    const result = sucrase.transform(source, {
      transforms: ["typescript", "jsx"],
      production: false,
      // Map JSX to the runtime's h() function so we don't need React.
      jsxPragma: "h",
      jsxFragmentPragma: "Fragment",
    });
    let js = result.code;
    // Defensive: if any React.createElement leaked through, replace it.
    js = js.replace(/React\.createElement\b/g, "h")
            .replace(/React\.Fragment\b/g, "Fragment");
    if (Buffer.byteLength(js, "utf-8") > maxBytes * 2) {
      return { error: `Compiled JS exceeds ${maxBytes * 2} bytes after transpilation.` };
    }
    return { js };
  } catch (e: any) {
    return { error: `Compile error: ${e?.message ?? String(e)}` };
  }
}

// ─── BUILTIN_LIBRARY ─────────────────────────────────────────────────────────

const BUILTIN_LIBRARY = `
const Button = (props) => h('button', { onClick: props.onClick, class: 'ok-btn', type: 'button' }, props.label ?? props.children);
const Card = (props) => h('div', { class: 'ok-card' }, props.children);
const Row = (props) => h('div', { class: 'ok-row', style: 'display:flex;gap:8px;align-items:center' }, props.children);
const Column = (props) => h('div', { class: 'ok-col', style: 'display:flex;flex-direction:column;gap:8px' }, props.children);
const Text = (props) => h('span', { class: 'ok-text' }, props.children ?? props.text);
const Heading = (props) => h('h3', { class: 'ok-heading' }, props.children ?? props.text);
const Image = (props) => h('img', { class: 'ok-img', src: props.src, alt: props.alt ?? '' });
const ColorSwatch = (props) => h('div', { class: 'ok-swatch', style: 'width:32px;height:32px;border-radius:4px;background:' + (props.color || '#ccc') });
const Code = (props) => h('pre', { class: 'ok-code' }, h('code', {}, props.children ?? props.text));
`;

// ─── Runtime (tiny React-like, no hooks) ─────────────────────────────────────

const RUNTIME = `
// Minimal h() and render() runtime — no hooks, no reconciliation.
// h(type, props, ...children) => vnode
// render(vnode, root) => void
function Fragment(props) { return props.children; }
function h(type, props, ...children) {
  return { type, props: props || {}, children: children.flat().filter(c => c != null && c !== false && c !== '') };
}
function render(vnode, root) {
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    root.textContent = String(vnode);
    return;
  }
  if (!vnode || !vnode.type) { root.textContent = ''; return; }
  const el = document.createElement(vnode.type);
  const { props, children } = vnode;
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'style' && typeof v === 'string') {
      v.split(';').forEach(s => { const [pk, pv] = s.split(':'); if (pk && pv) el.style[pk.trim()] = pv.trim(); });
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k !== 'class') {
      el.setAttribute(k, String(v));
    }
  }
  if (props && props.class) el.className = props.class;
  const childRoot = document.createDocumentFragment();
  for (const child of children || []) {
    render(child, childRoot);
    el.appendChild(childRoot);
  }
  root.appendChild(el);
}
function respond(value) {
  parent.postMessage({ type: 'openkan:respond', version: 1, value }, '*');
}
`;

// ─── Sandbox HTML builder ─────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/<\/iframe>/gi, "<\\/iframe>")
    .replace(/`/g, "\\`")
    .replace(/\\/g, "\\\\");
}

export function buildSandboxHtml(js: string, propsJson: string): string {
  const escapedJs = esc(js);
  const escapedProps = esc(propsJson);

  // Wrap user code: the user's component is assigned to window
  const wrappedJs = `\
const App = (function() {
${escapedJs}
})();
window.render = function(props) {
  const root = document.getElementById('root');
  root.innerHTML = '';
  const v = App(typeof props === 'string' ? JSON.parse(props) : props);
  render(v, root);
};
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'openkan:props' && e.data.version === 1) {
    try {
      window.render(e.data.props);
    } catch(err) {
      document.body.textContent = 'Render error: ' + err.message;
    }
  }
});
`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>preview</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;padding:16px;background:#fafafa}
.ok-btn{background:#2563eb;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:14px}
.ok-btn:hover{background:#1d4ed8}
.ok-card{border:1px solid #e5e7eb;border-radius:8px;padding:16px;background:#fff}
.ok-row{display:flex;gap:8px;align-items:center}
.ok-col{display:flex;flex-direction:column;gap:8px}
.ok-text{font-size:14px;color:#374151}
.ok-heading{font-size:18px;font-weight:600;color:#111}
.ok-img{max-width:100%;border-radius:4px}
.ok-swatch{border-radius:4px}
.ok-code{background:#1f2937;color:#f9fafb;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px}
</style>
<script>${BUILTIN_LIBRARY}</script>
<script>${RUNTIME}</script>
<script>
window.openkan = { Button, Card, Row, Column, Text, Heading, Image, ColorSwatch, Code, respond, h, render };
try {
  ${wrappedJs}
} catch(e) {
  document.body.textContent = 'Preview error: ' + e.message;
}
</script>
</head>
<body>
<div id="root"></div>
<script>
// Initial props from server
try { window.render && window.render(${escapedProps || '{}'}); } catch(e) {}
</script>
</body>
</html>`;
}

// ─── Full preview pipeline ─────────────────────────────────────────────────────

export async function buildPreview(
  source: string,
  props?: Record<string, unknown>,
): Promise<PreviewResult> {
  const compileResult = await compileTsx(source);
  if (compileResult.error) return { error: compileResult.error };
  const js = compileResult.js!;
  const propsJson = JSON.stringify(props ?? {});
  try {
    const sandboxHtml = buildSandboxHtml(js, propsJson);
    return { js, sandboxHtml };
  } catch (e: any) {
    return { error: `Sandbox error: ${e?.message ?? String(e)}` };
  }
}
