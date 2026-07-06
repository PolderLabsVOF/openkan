// OpenKan — tagging, categorization, priority, and effort inference.

export type Priority = "low" | "normal" | "high" | "urgent";
export type Effort = "xs" | "s" | "m" | "l" | "xl";
export type Category =
  | "frontend" | "backend" | "infra" | "docs"
  | "test" | "design" | "data" | "security" | "task";

export interface DerivedMetadata {
  tags: string[];            // deduped, sorted, lowercased
  category: Category;
  priority: Priority;
  effort: Effort | null;     // null if undetectable
  explicitTags: string[];    // just the #tag tokens the user wrote
}

// ─── Tag keyword map (in priority order — first match wins) ──────────────────

const TAG_KEYWORDS: Array<{ keywords: string[]; tag: string }> = [
  { keywords: ["fix", "bug", "broken", "regression", "crash", "outage"], tag: "bug" },
  { keywords: ["feature", "add support", "implement"],                tag: "feature" },
  { keywords: ["refactor", "cleanup", "clean up"],                     tag: "refactor" },
  { keywords: ["doc", "docs", "documentation", "readme"],              tag: "docs" },
  { keywords: ["test", "spec", "e2e", "coverage"],                    tag: "test" },
  { keywords: ["perf", "performance", "slow", "optimi"],              tag: "perf" },
  { keywords: ["security", "vuln", "cve", "xss"],                    tag: "security" },
  { keywords: ["a11y", "accessibility"],                             tag: "a11y" },
  { keywords: ["ux", "design"],                                        tag: "ux" },
  { keywords: ["i18n", "l10n", "locale"],                            tag: "i18n" },
  { keywords: ["migration", "migrate"],                                tag: "migration" },
  { keywords: ["deprecat"],                                            tag: "deprecation" },
];

// ─── Category rules (first match wins) ───────────────────────────────────────

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: Category }> = [
  { pattern: /\.tsx|\.jsx|\.css|\.scss|component|page\/|ui\/|button|modal|style(?!s)|css[\/-]/i, category: "frontend" },
  { pattern: /\.py|\.go|\.ts\b(?!x)|\/api|endpoint|route|handler|server|db|query|sql\b/i, category: "backend" },
  { pattern: /k8s|kubernetes|docker|terraform|tf\b|helm|deploy|ci|cd|pipeline/i, category: "infra" },
  { pattern: /readme|changelog|\bdocs\/|documentation|comment|jsdoc/i, category: "docs" },
  { pattern: /playwright|vitest|jest|mocha|cypress|e2e|unit test/i, category: "test" },
  { pattern: /figma|sketch|wireframe|mockup|style guide/i, category: "design" },
  { pattern: /sql\b|postgres|mysql|migration|schema|index|query\b/i, category: "data" },
  { pattern: /xss|csp|cve|auth|oauth|jwt|vuln|rbac/i, category: "security" },
];

// ─── Priority rules (first match wins) ───────────────────────────────────────

const PRIORITY_PATTERNS: Array<{ pattern: RegExp; priority: Priority }> = [
  { pattern: /P0|urgent|asap|critical|blocker|outage/i,    priority: "urgent" },
  { pattern: /P1|high priority|high\b(?! priority)|important/i, priority: "high" },
  { pattern: /P2|low priority/i,                           priority: "low" },
  { pattern: /P3|backlog/i,                                priority: "normal" },
];

// ─── Effort rules (first match wins; null if no signal) ─────────────────────

const EFFORT_PATTERNS: Array<{ pattern: RegExp; effort: Effort }> = [
  { pattern: /\b(?:xs|trivial|1[\s_-]?line|one[\s_-]?liner|typo)\b/i,  effort: "xs" },
  { pattern: /\b(?:small|quick|minutes?)\b/i,                                 effort: "s" },
  { pattern: /\b(?:medium|afternoon|half[\s_-]?day)\b/i,                   effort: "m" },
  // xl pattern first (tries multi-week before week in the l rule below)
  { pattern: /\b(?:xl|epic|multi[\s_-]?week|quarter)\b/i,                  effort: "xl" },
  // "week" must NOT be preceded by a letter/digit/hyphen (prevents matching inside "multi-week")
  { pattern: /\b(?:large|big|(?<![a-zA-Z0-9-])week)\b/i,                   effort: "l" },
];

// ─── Explicit tag extraction ─────────────────────────────────────────────────

const HASHTAG_PATTERN = /#([a-zA-Z][a-zA-Z0-9_-]*)/g;

/** Extract #word tokens from a string. Returns lowercased tag names without the #. */
function extractExplicitTags(text: string): string[] {
  const tags: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(HASHTAG_PATTERN.source, "g");
  while ((match = re.exec(text)) !== null) {
    tags.push(match[1].toLowerCase());
  }
  return tags;
}

// ─── Core inference ───────────────────────────────────────────────────────────

function matchFirst<T>(text: string, rules: Array<{ pattern: RegExp; value: T }>): T | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.value;
  }
  return null;
}

function deriveTags(title: string, description: string): string[] {
  const combined = `${title} ${description}`.toLowerCase();
  const found: string[] = [];
  for (const { keywords, tag } of TAG_KEYWORDS) {
    if (keywords.some(kw => combined.includes(kw))) {
      found.push(tag);
    }
  }
  return found;
}

function deriveCategory(title: string, description: string): Category {
  const combined = `${title} ${description}`;
  const matched = matchFirst(combined, CATEGORY_PATTERNS.map(r => ({ pattern: r.pattern, value: r.category })));
  return matched ?? "task";
}

function derivePriority(title: string, description: string): Priority {
  const combined = `${title} ${description}`;
  const matched = matchFirst(combined, PRIORITY_PATTERNS.map(r => ({ pattern: r.pattern, value: r.priority })));
  return matched ?? "normal";
}

function deriveEffort(title: string, description: string): Effort | null {
  const combined = `${title} ${description}`;
  const matched = matchFirst(combined, EFFORT_PATTERNS.map(r => ({ pattern: r.pattern, value: r.effort })));
  return matched ?? null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Infer tags, category, priority, and effort from a task's title and description.
 * Tags are deduplicated and sorted: keyword-derived tags first (in table order),
 * then explicit #tag tokens (alphabetical). The category is always included as a tag.
 */
export function extractMetadata(input: { title?: string; description?: string }): DerivedMetadata {
  const title = input.title ?? "";
  const description = input.description ?? "";
  const explicitTags = extractExplicitTags(`${title} ${description}`);
  const keywordTags = deriveTags(title, description);

  // Merge: keyword tags first (preserving table order), then explicit tags alphabetical
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const tag of keywordTags) {
    if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
  }
  for (const tag of [...explicitTags].sort()) {
    if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
  }

  const category = deriveCategory(title, description);
  // Always include category as a tag
  if (!seen.has(category)) { tags.push(category); }

  const priority = derivePriority(title, description);
  const effort = deriveEffort(title, description);

  return { tags, category, priority, effort, explicitTags };
}
