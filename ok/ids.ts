// ok/ids.ts — id and timestamp helpers used by every planning entity.
//
// IDs follow the `<prefix>-<short>` convention: `tsk-abc12def`, `pln-…`,
// `prd-…`. The short suffix is a nanoid URL-safe string (8 chars by default),
// which gives ~47 bits of entropy — plenty for per-workspace uniqueness
// without becoming unreadable in listings.

import { nanoid } from "nanoid";

export type EntityKind = "tsk" | "pln" | "prd";

/** Generate a new id of the given kind, e.g. `tsk-Vn4kRp2x`. */
export function newId(kind: EntityKind, alphabetSize = 8): string {
  return `${kind}-${nanoid(alphabetSize)}`;
}

/** Strip the `<kind>-` prefix off an id, returning the suffix or `null`. */
export function idSuffix(id: string): string | null {
  const m = /^[a-z]{3}-([A-Za-z0-9_-]+)$/.exec(id);
  return m ? m[1] : null;
}

/** True when `id` is a well-formed id of `kind`. */
export function isIdOf(id: string, kind: EntityKind): boolean {
  const m = new RegExp(`^${kind}-[A-Za-z0-9_-]+$`).exec(id);
  return m !== null;
}

/** Return current ISO timestamp (millisecond precision). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Compare two ISO timestamps lexicographically. */
export function isoCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse `--flag value` or `--flag=value` pairs out of an argv tail.
 * Returns `{ positionals, flags }`. Multiple values for the same flag
 * are concatenated into an array; the surface is small enough that a
 * hand-rolled parser is more legible than a dependency.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    let name: string;
    let inline: string | undefined;
    if (eq !== -1) {
      name = tok.slice(2, eq);
      inline = tok.slice(eq + 1);
    } else {
      name = tok.slice(2);
      inline = undefined;
    }
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }

  return { positionals, flags };
}

/** Read a string flag. Returns `undefined` when missing or boolean-shaped. */
export function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * Read a CSV-style flag, splitting on either `,` or `|`. `|` is the
 * canonical separator for prd goals / milestones per the design contract;
 * `,` matches the more common shell convention for scope/deps/acceptance.
 */
export function flagCsv(flags: ParsedArgs["flags"], name: string): string[] {
  const v = flags[name];
  if (typeof v !== "string") return [];
  return v
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a boolean flag (present at all). */
export function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] !== undefined;
}

/** Wrap an async main so callers don't need to repeat the boilerplate. */
export async function runMain(fn: () => Promise<number>): Promise<void> {
  try {
    const code = await fn();
    process.exit(code);
  } catch (e: any) {
    process.stderr.write(`ok: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
