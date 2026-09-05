import { paths, listTasks, listPlans, listPrds, readPrd } from '../storage.ts';
import { parseArgs, flagString, flagBool } from '../ids.ts';

export async function runProgress(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const p = paths(process.cwd());
  const prdId = flagString(flags, 'prd');
  if (prdId && !await readPrd(p, prdId)) throw new Error(`no such PRD: ${prdId}`);
  const [allTasks, allPlans, allPrds] = await Promise.all([listTasks(p), listPlans(p), listPrds(p)]);
  const prds = allPrds.filter(item => !prdId || item.id === prdId);
  const plans = allPlans.filter(item => !prdId || item.prd === prdId || prds.some(prd => prd.plans.includes(item.id)));
  const tasks = allTasks.filter(item => !prdId || item.prd === prdId || plans.some(plan => plan.id === item.plan || plan.tasks.includes(item.id)));
  const summary = (items: Array<{ status: string }>, states: string[], done: string, excluded: string[]) => {
    const counts: Record<string, number> = Object.fromEntries(states.map(state => [state, 0]));
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    const total = items.length;
    const actionable = total - excluded.reduce((sum, state) => sum + (counts[state] || 0), 0);
    return { ...counts, total, percentComplete: actionable ? Math.round((counts[done] || 0) / actionable * 100) : 0 };
  };
  const report = {
    project: process.cwd(), prd: prdId || null,
    tasks: summary(tasks, ['pending', 'in_progress', 'review', 'done', 'cancelled'], 'done', ['cancelled']),
    plans: summary(plans, ['draft', 'active', 'blocked', 'complete', 'abandoned'], 'complete', ['abandoned']),
    goals: summary(prds.flatMap(prd => prd.goals), ['open', 'in_progress', 'met', 'dropped'], 'met', ['dropped']),
    prds: summary(prds, ['draft', 'active', 'shipped', 'abandoned'], 'shipped', ['abandoned']),
    nextTasks: tasks.filter(task => task.status === 'pending' && (task.deps || []).every(id => allTasks.some(dependency => dependency.id === id && dependency.status === 'done'))).map(task => ({ id: task.id, title: task.title, owner: task.owner || null })),
  };
  process.stdout.write(flagBool(flags, 'json') ? `${JSON.stringify(report, null, 2)}\n` : `Project: ${report.project}\n${Object.entries(report).filter(([name]) => ['tasks','plans','goals','prds'].includes(name)).map(([name, value]) => `${name}: ${(value as { total: number }).total} total, ${(value as { percentComplete: number }).percentComplete}% complete`).join('\n')}\nReady tasks: ${report.nextTasks.map(task => task.id).join(', ') || 'none'}\n`);
  return 0;
}
