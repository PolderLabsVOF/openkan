import { listPrds, readPrd, writePrd, rebuildIndex, paths } from '../storage.ts';
import { parseArgs, flagString, flagBool } from '../ids.ts';
import { touch, type PrdGoal } from '../schemas.ts';

const statuses: PrdGoal['status'][] = ['open', 'in_progress', 'met', 'dropped'];

export async function runGoal(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { positionals, flags } = parseArgs(rest);
  const p = paths(process.cwd());
  const output = (value: unknown) => process.stdout.write(`${typeof value === 'string' && !flagBool(flags, 'json') ? value : JSON.stringify(value, null, 2)}\n`);
  if (sub === 'list') {
    const prdId = flagString(flags, 'prd') || positionals[0];
    const status = flagString(flags, 'status');
    if (status && !statuses.includes(status as PrdGoal['status'])) throw new Error(`status must be ${statuses.join('|')}`);
    const prds = prdId ? [await readPrd(p, prdId)] : await listPrds(p);
    if (prds.some(prd => !prd)) throw new Error(`no such PRD: ${prdId}`);
    const goals = prds.flatMap(prd => prd!.goals.map(goal => ({ ...goal, prd: prd!.id }))).filter(goal => !status || goal.status === status);
    if (flagBool(flags, 'json')) output(goals);
    else output(goals.map(goal => `${goal.prd}/${goal.id}  ${goal.status}  ${goal.text}`).join('\n') || '(no goals)');
    return 0;
  }
  if (!['add', 'show', 'update'].includes(sub)) throw new Error('Usage: openkan goal list [--prd ID] [--json] | add <prd-id> <text> | show <prd-id> <goal-id> | update <prd-id> <goal-id> --status open|in_progress|met|dropped [--text TEXT]');
  const [prdId, goalId, ...extra] = positionals;
  if (!prdId || !goalId || (sub !== 'add' && extra.length)) throw new Error(`Usage: openkan goal ${sub} <prd-id> <${sub === 'add' ? 'text' : 'goal-id'}>`);
  const prd = await readPrd(p, prdId);
  if (!prd) throw new Error(`no such PRD: ${prdId}`);
  let goal: PrdGoal;
  if (sub === 'add') {
    const number = Math.max(0, ...prd.goals.map(g => Number(g.id.match(/^g(\d+)$/)?.[1] || 0))) + 1;
    goal = { id: `g${number}`, text: [goalId, ...extra].join(' '), status: 'open' };
    prd.goals.push(goal);
  } else {
    const found = prd.goals.find(g => g.id === goalId);
    if (!found) throw new Error(`no such goal: ${prdId}/${goalId}`);
    goal = found;
    if (sub === 'update') {
      const status = flagString(flags, 'status');
      const text = flagString(flags, 'text');
      if (!status && text === undefined) throw new Error('goal update requires --status or --text');
      if (status && !statuses.includes(status as PrdGoal['status'])) throw new Error(`status must be ${statuses.join('|')}`);
      if (text !== undefined && !text.trim()) throw new Error('goal text must not be empty');
      if (status) goal.status = status as PrdGoal['status'];
      if (text !== undefined) goal.text = text;
    }
  }
  if (sub !== 'show') { await writePrd(p, touch(prd)); await rebuildIndex(p); }
  output(goal);
  return 0;
}
