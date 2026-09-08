// tests/fixture-smell-detector.mts — detect fixture-shaped tasks that leaked into .ok/

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

interface FixturePattern {
  titleRegex: RegExp;
  ownerCheck?: (owner: string | undefined) => boolean;
  descriptionCheck?: (description: string | undefined) => boolean;
  scopesCheck?: (scopes: string[] | undefined) => boolean;
  pattern: string;
}

/**
 * Fixture patterns that indicate a leaked test fixture.
 * These patterns match tasks that were created by tests/integration but
 * leaked into the user's .ok/ workspace.
 */
const FIXTURE_PATTERNS: FixturePattern[] = [
  {
    titleRegex: /move a card/i,
    ownerCheck: (owner) => owner === null || owner === undefined,
    pattern: "move a card (no owner)",
  },
  {
    titleRegex: /server-visible task/i,
    ownerCheck: (owner) => owner === null || owner === undefined,
    pattern: "server-visible task (no owner)",
  },
  {
    titleRegex: /integration in_progress/i,
    ownerCheck: (owner) => owner === null || owner === undefined,
    pattern: "integration in_progress (no owner)",
  },
  {
    titleRegex: /integration reconcile smoke/i,
    ownerCheck: (owner) => owner === null || owner === undefined,
    descriptionCheck: (desc) => desc?.startsWith("auto-generated: "),
    pattern: "integration reconcile smoke (no owner or auto-generated)",
  },
  {
    titleRegex: /smoke reconcile/i,
    ownerCheck: (owner) => owner === null || owner === undefined,
    scopesCheck: (scopes) => scopes?.includes("smoke"),
    pattern: "smoke reconcile (no owner or smoke scope)",
  },
  {
    titleRegex: /dedupe this POST/i,
    ownerCheck: (owner) => owner === null || owner === undefined,
    pattern: "dedupe this POST (no owner)",
  },
];

export interface SmellDetection {
  id: string;
  reason: string;
  title: string;
  owner: string | undefined;
  description: string | undefined;
}

/**
 * Parse frontmatter from a task.mdx file.
 * Returns the parsed frontmatter or null if parsing fails.
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter: Record<string, unknown> = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Handle YAML-like values
    if (typeof value === "string") {
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Parse array
        const arrContent = value.slice(1, -1);
        value = arrContent ? arrContent.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")) : [];
      } else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      }
    }

    frontmatter[key] = value;
  }

  return frontmatter;
}

/**
 * Detect fixture-shaped tasks in a tasks directory.
 * @param tasksDir - Path to .ok/tasks/ directory
 * @returns Array of detected fixture smells
 */
export function detectFixtureSmells(tasksDir: string): SmellDetection[] {
  const smells: SmellDetection[] = [];

  if (!existsSync(tasksDir)) {
    return smells;
  }

  const taskDirs = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const taskId of taskDirs) {
    const taskDir = join(tasksDir, taskId);
    const taskMdxPath = join(taskDir, "task.mdx");
    const taskJsonPath = join(tasksDir, `${taskId}.json`);

    // Source of truth for lifecycle is the planning-system JSON (ok.task.v1).
    // The MDX mirror is regenerated on server boot, so its frontmatter can be
    // stale — read the JSON first and skip tasks that have already been
    // cancelled or archived. Fall back to MDX frontmatter for legacy metadata
    // when JSON is absent (older layout).
    let jsonStatus: string | undefined;
    let jsonArchived: boolean | undefined;
    try {
      if (existsSync(taskJsonPath) && statSync(taskJsonPath).isFile()) {
        const json = JSON.parse(readFileSync(taskJsonPath, "utf-8")) as {
          status?: string;
          archived?: boolean;
        };
        jsonStatus = json.status;
        jsonArchived = json.archived;
      }
    } catch {
      /* malformed JSON — fall through to MDX */
    }
    if (jsonStatus === "cancelled" || jsonStatus === "done" || jsonArchived === true) {
      continue;
    }

    if (!existsSync(taskMdxPath)) continue;

    try {
      const content = readFileSync(taskMdxPath, "utf-8");
      const fm = parseFrontmatter(content);

      if (!fm) continue;

      const title = fm.title as string | undefined;
      const owner = fm.owner as string | undefined;
      const description = fm.description as string | undefined;
      const scopes = fm.scopes as string[] | undefined;

      if (!title) continue;

      // Skip tasks that have already been cleaned up — cancelled or archived
      // tasks are not active smells. The MDX mirror can lag the JSON
      // source of truth (the server writes the mirror only when it boots or
      // when a task transitions state), so we also check the MDX frontmatter
      // as a secondary filter.
      const mdxStatus = (fm.status as string | undefined) ?? "";
      const mdxArchived = (fm.archived as boolean | undefined) ?? false;
      if (mdxStatus === "cancelled" || mdxStatus === "done" || mdxArchived) {
        continue;
      }

      // Check each pattern
      for (const pattern of FIXTURE_PATTERNS) {
        if (!pattern.titleRegex.test(title)) continue;

        // Check owner condition
        let ownerMatches = false;
        if (pattern.ownerCheck) {
          ownerMatches = pattern.ownerCheck(owner);
        } else {
          ownerMatches = true; // No owner check means any owner is fine
        }

        // Check description condition
        let descMatches = false;
        if (pattern.descriptionCheck) {
          descMatches = pattern.descriptionCheck(description);
        } else {
          descMatches = true; // No desc check means any description is fine
        }

        // Check scopes condition
        let scopesMatches = false;
        if (pattern.scopesCheck) {
          scopesMatches = pattern.scopesCheck(scopes);
        } else {
          scopesMatches = true; // No scopes check means any scopes are fine
        }

        // If any check passes, it's a fixture smell
        if (ownerMatches || descMatches || scopesMatches) {
          smells.push({
            id: taskId,
            reason: pattern.pattern,
            title,
            owner,
            description,
          });
          break; // Only report one pattern per task
        }
      }
    } catch {
      // Skip malformed files
      continue;
    }
  }

  return smells;
}
