import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

export const OPENKAN_AGENT_ID = 'openkan';

/** Provider-neutral prompt source; Claude's adapter maps it to a session agent. */
export function openkanAgentDefinition() {
  const { data, content } = matter(readFileSync(new URL('../agents/openkan.md', import.meta.url), 'utf8'));
  return { description: String(data.description), prompt: content.trim(), model: 'inherit' };
}
