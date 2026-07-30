// OpenKan — server-side MDX → HTML renderer with block markers and custom components.

import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";

// ─── Types ───────────────────────────────────────────────────────────────────

export type BlockType = "heading" | "paragraph" | "list" | "code" | "quote" | "table" | "component" | "other";

export interface Block {
  id: string; // blk-xxxxxxxx content-hash
  line: number; // 1-indexed line of first line of block
  preview: string; // first 80 chars of normalized text
  type: BlockType;
}

export interface RenderResult {
  html: string;
  blocks: Block[];
  warnings: string[];
}

// ─── Block ID ─────────────────────────────────────────────────────────────────

/**
 * Produce a stable block ID from block text and its position among top-level siblings.
 * Same content at the same sibling position → same ID even if lines are added above.
 */
export function blockIdFor(blockText: string, siblingIndex: number): string {
  const normalised = normalizeLine(blockText).slice(0, 80);
  const input = `${siblingIndex}|${normalised}`;
  const sha = createHash("sha1").update(input).digest("hex").slice(0, 12);
  return `blk-${sha}`;
}

// ─── Normalization helpers ────────────────────────────────────────────────────

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimLines(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/gm, "");
}

// ─── Custom component detection ───────────────────────────────────────────────

type ComponentName = "Ask" | "Choice" | "Input" | "Confirm" | "Preview";

const CUSTOM_COMPONENTS: ComponentName[] = ["Ask", "Choice", "Input", "Confirm", "Preview"];

function isCustomComponent(name: string): name is ComponentName {
  return CUSTOM_COMPONENTS.includes(name as ComponentName);
}

// ─── Block detection (line-by-line) ─────────────────────────────────────────

interface BlockBuilder {
  type: BlockType;
  lines: string[];
  startLine: number;
}

function detectBlockType(firstLine: string): BlockType {
  const t = firstLine.trim();
  if (/^#{1,6}\s/.test(t)) return "heading";
  if (t === "---") return "other"; // frontmatter separator — treated as other
  if (/^(```|~~~)/.test(t)) return "code";
  if (/^>\s/.test(t)) return "quote";
  if (/^\|/.test(t)) return "table";
  if (/^[-*+]\s/.test(t)) return "list";
  if (/^<[A-Z][a-zA-Z]*(\s|>|\/>)/.test(t)) return "component";
  return "paragraph";
}

function isBlankLine(line: string): boolean {
  return /^ *$/.test(line);
}

/**
 * Parse source MDX into top-level blocks.
 * Each block has: type, lines (raw), startLine (1-indexed).
 */
function parseBlocks(source: string): BlockBuilder[] {
  const lines = source.split("\n");
  const blocks: BlockBuilder[] = [];
  let i = 0;
  let siblingIndex = 0;

  while (i < lines.length) {
    // Skip blank lines before a block
    while (i < lines.length && isBlankLine(lines[i])) i++;
    if (i >= lines.length) break;

    const startLine = i + 1; // 1-indexed
    const firstLine = lines[i];

    // Check for code fence open/close
    if (/^(```|~~~)/.test(firstLine.trim())) {
      const fence = firstLine.trim().match(/^(```|~~~)/)![1];
      const fenceRE = new RegExp(`^${fence === "```" ? "\\`\\`\\`" : "~~~"}\s*$`);
      const blockLines = [firstLine];
      i++;
      while (i < lines.length && !fenceRE.test(lines[i].trim())) {
        blockLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) blockLines.push(lines[i]); // closing fence
      i++;
      blocks.push({ type: "code", lines: blockLines, startLine });
      siblingIndex++;
      continue;
    }

    // Detect component on a single line: <Name ... />
    if (/^<[A-Z][a-zA-Z]*\s/.test(firstLine.trim()) || /^<[A-Z][a-zA-Z]*\/>$/.test(firstLine.trim())) {
      const singleLine = firstLine.trim();
      // Check if it's self-closing or has a closing tag on same line
      const selfClose = /^\s*<([A-Z][a-zA-Z]*)[^>]*\/>\s*$/.test(singleLine);
      const sameLineClose = /<\/[A-Z][a-zA-Z]*>\s*$/.test(singleLine);
      if (selfClose || sameLineClose) {
        blocks.push({ type: "component", lines: [firstLine], startLine });
        i++;
        siblingIndex++;
        continue;
      }
      // Multi-line component: find closing tag
      const openMatch = singleLine.match(/^<([A-Z][a-zA-Z]*)/);
      if (openMatch) {
        const tagName = openMatch[1];
        const closeRE = new RegExp(`</${tagName}\\s*>\\s*$`);
        const blockLines = [firstLine];
        i++;
        while (i < lines.length && !closeRE.test(lines[i].trim())) {
          blockLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) blockLines.push(lines[i]);
        i++;
        blocks.push({ type: "component", lines: blockLines, startLine });
        siblingIndex++;
        continue;
      }
    }

    // For other types, accumulate lines that belong to the block
    const bType = detectBlockType(firstLine);
    const blockLines = [firstLine];
    i++;

    if (bType === "heading" || bType === "code" || bType === "component") {
      // Already handled above; heading shouldn't reach here
    } else {
      // Accumulate continuation lines for paragraph/list/quote/table
      while (i < lines.length) {
        const peek = lines[i];
        const peekTrimmed = peek.trim();
        if (isBlankLine(peek)) {
          // Blank line ends paragraph/quote/table
          if (bType === "paragraph" || bType === "quote" || bType === "table") break;
          i++;
          continue;
        }
        if (/^#{1,6}\s/.test(peekTrimmed)) break; // next heading
        if (/^(```|~~~)/.test(peekTrimmed)) break; // next fence
        if (/^<\/?[A-Z]/.test(peekTrimmed)) break; // next component tag
        if (bType === "list" && !/^[-*+]\s/.test(peekTrimmed) && !/^\d+\.\s/.test(peekTrimmed)) {
          // Indented continuation is ok; non-indented non-list ends the block
          if (!/^\s/.test(peek) && !/^\d+\.\s/.test(peekTrimmed)) break;
        }
        blockLines.push(peek);
        i++;
      }
    }

    blocks.push({ type: bType, lines: blockLines, startLine });
    siblingIndex++;
  }

  return blocks;
}

// ─── Block-to-HTML ─────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function blockPreview(blockLines: string[]): string {
  return normalizeWhitespace(trimLines(blockLines.join(" "))).slice(0, 80);
}

// Extract attributes from a self-closing or block component tag
function extractAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match key="value" or key='value' patterns
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)=["']([^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function renderCustomComponent(
  tagName: ComponentName,
  blockLines: string[],
  blockId: string,
  line: number,
  opts?: { mdxComponents?: Record<string, (props: Record<string, string>, children: string) => string> },
): string {
  // For Preview, we emit a placeholder that the frontend replaces with an iframe
  if (tagName === "Preview") {
    // Get all content between <Preview ... /> or <Preview ...>...</Preview>
    const full = blockLines.join("\n");
    const tsxMatch = full.match(/tsx=["']([^"']*)["']/) || full.match(/tsx=["']([^"']*)["']/);
    const propsMatch = full.match(/props=["']([^"']*)["']/) || full.match(/props=["']([^"']*)["']/);
    const tsx = tsxMatch ? tsxMatch[1] : "";
    const props = propsMatch ? propsMatch[1] : "{}";
    const escapedTsx = tsx.replace(/<\/script>/gi, "<\\/script>").replace(/<\/iframe>/gi, "<\\/iframe>");
    const escapedProps = props.replace(/"/g, "&quot;");
    return `<section data-mdx-component="Preview" data-mdx-tsx="${escapedTsx}" data-mdx-props="${escapedProps}" data-block-id="${blockId}" data-line="${line}"></section>`;
  }

  // For Ask/Choice/Input/Confirm — render as interactive widgets
  const full = blockLines.join("\n");
  const questionMatch = full.match(/question=["']([^"']*)["']/) || /<Ask>([^<]*)<\/Ask>/s.test(full) ? full.match(/<Ask>([^<]*)<\/Ask>/s)?.[1] : null;
  const question = questionMatch ? questionMatch[1] : "";
  const placeholder = extractAttrs(full).placeholder ?? "";
  const opts_match = full.match(/options=\{(\[[^\]]*\])/);
  const optionsJson = opts_match ? opts_match[1] : "[]";

  return `<section data-mdx-component="${tagName}" data-block-id="${blockId}" data-line="${line}" data-question="${escapeHtml(question)}" data-placeholder="${escapeHtml(placeholder)}" data-options="${escapeHtml(optionsJson)}"></section>`;
}

function blockToHtml(block: BlockBuilder, siblingIndex: number, opts?: { mdxComponents?: Record<string, (props: Record<string, string>, children: string) => string> }): string {
  const blockId = blockIdFor(block.lines.join("\n"), siblingIndex);
  const preview = blockPreview(block.lines);
  const rawLines = block.lines.join("\n");

  if (block.type === "component") {
    const firstLine = block.lines[0].trim();
    const tagMatch = firstLine.match(/^<([A-Z][a-zA-Z]*)/);
    if (tagMatch) {
      const tagName = tagMatch[1];
      if (isCustomComponent(tagName)) {
        const inner = renderCustomComponent(tagName, block.lines, blockId, block.startLine, opts);
        return `<section class="mdx-block" data-block-id="${blockId}" data-line="${block.startLine}" data-block-type="${block.type}">${inner}</section>`;
      }
    }
    // Unknown component — pass through safely
    const inner = escapeHtml(rawLines);
    return `<section class="mdx-block" data-block-id="${blockId}" data-line="${block.startLine}" data-block-type="${block.type}">${inner}</section>`;
  }

  // Build inner HTML from the block content
  let inner = "";
  const trimmed = trimLines(rawLines);

  switch (block.type) {
    case "heading": {
      const m = trimmed.match(/^(#{1,6})\s(.*)/);
      const level = m ? m[1].length : 2;
      inner = `<h${level}>${escapeHtml(m ? m[2] : trimmed.replace(/^#+\s/, ""))}</h${level}>`;
      break;
    }
    case "code": {
      const codeLines = block.lines.slice(1, -1).join("\n");
      const langMatch = block.lines[0].trim().match(/^```(\w*)/);
      const lang = langMatch && langMatch[1] ? langMatch[1] : "";
      inner = `<pre><code class="language-${lang}">${escapeHtml(codeLines)}</code></pre>`;
      break;
    }
    case "list": {
      const items = block.lines.map((l) => {
        const text = l.replace(/^\s*[-*+]\s/, "").replace(/^\s*\d+\.\s/, "");
        return `<li>${escapeHtml(text.trim())}</li>`;
      }).join("");
      inner = trimmed.startsWith("1.") ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      break;
    }
    case "quote": {
      const text = block.lines.map((l) => l.replace(/^>\s?/, "")).join(" ");
      inner = `<blockquote>${escapeHtml(text.trim())}</blockquote>`;
      break;
    }
    case "table": {
      // Simple pipe table: first row = header, second row = separator, rest = body
      const rows = block.lines.map((l) => l.trim()).filter((l) => l.startsWith("|"));
      if (rows.length < 2) {
        inner = `<p>${escapeHtml(trimmed)}</p>`;
      } else {
        const cells = rows[0].split("|").map((c) => c.trim()).filter((c) => c !== "");
        const header = `<thead><tr>${cells.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
        const bodyRows = rows.slice(2).map((row) => {
          const cells = row.split("|").map((c) => c.trim()).filter((c) => c !== "");
          return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
        }).join("");
        inner = `<table>${header}<tbody>${bodyRows}</tbody></table>`;
      }
      break;
    }
    case "paragraph":
    default: {
      inner = `<p>${escapeHtml(normalizeWhitespace(trimmed))}</p>`;
      break;
    }
  }

  return `<section class="mdx-block" data-block-id="${blockId}" data-line="${block.startLine}" data-block-type="${block.type}">${inner}</section>`;
}

// ─── Frontmatter stripping ─────────────────────────────────────────────────────

/**
 * Strip YAML frontmatter from an MDX string.
 * Handles the common ---...--- delimiter format used in task MDX files.
 * Returns the body text (without frontmatter) trimmed of leading whitespace.
 */
export function stripMdxFrontmatter(mdx: string): string {
  if (!mdx || typeof mdx !== "string") return mdx ?? "";
  // Frontmatter: starts with `---\n` or `---\r\n`, ends with `\n---\n` or `\r?\n---\r?\n`
  const m = mdx.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return mdx;
  return mdx.slice(m[0].length).trimStart();
}

// ─── Main render function ──────────────────────────────────────────────────────

const SANITIZE_ALLOWED_TAGS = new Set([
  "h1","h2","h3","h4","h5","h6","p","ul","ol","li",
  "code","pre","blockquote","a","strong","em","hr","br",
  "table","thead","tbody","tr","th","td",
  "section", "iframe", "button", "input", "select", "option", "label",
]);

const SANITIZE_ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  code: ["class"],
  td: ["align"],
  th: ["align"],
  img: ["src", "alt", "width", "height"],
  section: ["class", "data-block-id", "data-line", "data-block-type", "data-mdx-component", "data-mdx-tsx", "data-mdx-props", "data-question", "data-placeholder", "data-options"],
  iframe: ["sandbox", "referrerpolicy", "srcdoc", "title"],
  button: ["type", "onclick", "class"],
  input: ["type", "placeholder", "value", "oninput", "class"],
  select: ["class"],
  option: ["value", "selected"],
  label: ["class", "for"],
};

const SANITIZE_ALLOWED_SCHEMES = ["http:", "https:", "mailto:", "data:image/"];

function urlFilter(url: string): boolean {
  try {
    const u = new URL(url);
    if (SANITIZE_ALLOWED_SCHEMES.some((s) => u.protocol === s)) return true;
    if (u.protocol === "javascript:") return false;
    return false;
  } catch {
    return !url.startsWith("javascript:") && !url.startsWith("data:");
  }
}

export async function renderMdx(
  source: string,
  opts?: {
    mdxComponents?: Record<string, (props: Record<string, string>, children: string) => string>;
  },
): Promise<RenderResult> {
  const blocks = parseBlocks(stripMdxFrontmatter(source));
  const warnings: string[] = [];

  const htmlParts: string[] = [];
  const blockResults: Block[] = [];

  blocks.forEach((b, i) => {
    const blockId = blockIdFor(b.lines.join("\n"), i);
    blockResults.push({
      id: blockId,
      line: b.startLine,
      preview: blockPreview(b.lines),
      type: b.type,
    });
    htmlParts.push(blockToHtml(b, i, opts));
  });

  let html = htmlParts.join("\n");

  // Sanitize final HTML
  const clean = sanitizeHtml(html, {
    allowedTags: Array.from(SANITIZE_ALLOWED_TAGS),
    allowedAttributes: SANITIZE_ALLOWED_ATTRS,
    allowedSchemes: SANITIZE_ALLOWED_SCHEMES,
  });

  return {
    html: clean,
    blocks: blockResults,
    warnings,
  };
}
