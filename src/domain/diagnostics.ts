/**
 * Runtime self-tests: execute PRODUCTION logic on isolated in-memory fixtures. Never touches
 * live or simulation storage. Environment checks (storage/cache/audio/wake lock) live in the UI.
 */
import { auditAgainstExpected, shoppingList } from './audit';
import { baselineInput } from './fixtures';
import { DATA_VERSION, TASKS } from './recipes';
import { plan, verifyPlan } from './scheduler';
import { runSimulation } from './simulation';
import { ActionError, derive, initialState, reduce } from './state';
import { KEYS, MemoryKV, loadState, saveState } from './storage';
import { MINUTE, eventAt, fmtTime } from './time';
import { createTimer, timerStatus } from './timers';
import { validateAll } from './validate';

export interface DiagResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  details?: string;
  ms: number;
}

export interface DiagReport {
  ranAt: string;
  version: string;
  passed: number;
  failed: number;
  results: DiagResult[];
}

function check(name: string, fn: () => { pass: boolean; expected: string; actual: string; details?: string }): DiagResult {
  const t0 = performance.now();
  try {
    return { name, ...fn(), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { name, pass: false, expected: 'no exception', actual: String(e), ms: Math.round(performance.now() - t0) };
  }
}

export function runDiagnostics(opts: { full?: boolean; version?: string } = {}): DiagReport {
  const T0 = eventAt(8, 0);
  const results: DiagResult[] = [
    check('Recipe data validates', () => {
      const e = validateAll().errors;
      return { pass: e.length === 0, expected: '0 errors', actual: `${e.length} errors`, ...(e.length ? { details: e.slice(0, 5).join('; ') } : {}) };
    }),
    check('Ingredient audit matches spec', () => {
      const a = auditAgainstExpected();
      const bad = a.filter((x) => !x.pass);
      return { pass: bad.length === 0, expected: `${a.length}/${a.length}`, actual: `${a.length - bad.length}/${a.length}`, ...(bad.length ? { details: bad.map((b) => `${b.name}: ${b.actual}`).join('; ') } : {}) };
    }),
    check('Shopping list butter total', () => {
      const b = shoppingList().groups.flatMap((g) => g.items).find((i) => i.key === 'butter');
      return { pass: b?.amount === '30 tbsp + 2 1/2 tsp', expected: '30 tbsp + 2 1/2 tsp', actual: b?.amount ?? 'missing' };
    }),
    check('Baseline plan has no violations', () => {
      const input = baselineInput();
      const p = plan(input);
      const v = verifyPlan(input, p);
      return { pass: v.length === 0, expected: '0 violations', actual: `${v.length} violations`, ...(v.length ? { details: v.slice(0, 5).join('; ') } : {}) };
    }),
    check('Baseline dinner within acceptable window', () => {
      const p = plan(baselineInput());
      return { pass: p.dinnerMs != null && p.dinnerMs <= eventAt(13, 15), expected: '≤ 1:15 PM', actual: p.dinnerMs ? fmtTime(p.dinnerMs) : 'none' };
    }),
    check('Baseline keeps food under 2-hour limit', () => {
      const p = plan(baselineInput());
      const worst = Math.max(...p.exposures.map((e) => e.projectedMin));
      return { pass: worst < 120, expected: '< 120 min', actual: `${worst} min` };
    }),
    check('Scheduler is deterministic', () => {
      const a = JSON.stringify(plan(baselineInput()));
      const b = JSON.stringify(plan(baselineInput()));
      return { pass: a === b, expected: 'identical', actual: a === b ? 'identical' : 'different' };
    }),
    check('Late start (+60 min) stays valid', () => {
      const input = baselineInput({ nowMs: eventAt(9, 0), kitchenStartMs: eventAt(9, 0) });
      const v = verifyPlan(input, plan(input));
      return { pass: v.length === 0, expected: '0 violations', actual: `${v.length}` };
    }),
    check('Skipped prerequisite blocks dependents', () => {
      const p = plan(baselineInput({ progress: { 'stuffing-cook-sausage': { skippedAt: T0 } } }));
      const st = p.tasks['stuffing-bake']!.status;
      return { pass: st === 'blocked', expected: 'blocked', actual: st };
    }),
    check('Four independent timers', () => {
      const ts = [5, 10, 15, 20].map((m, i) => createTimer({ id: `d${i}`, label: 'x', startMs: T0, minutes: m }));
      const st = ts.map((t) => timerStatus(t, T0 + 12 * MINUTE)).join(',');
      return { pass: st === 'expired,expired,running,running', expected: 'expired,expired,running,running', actual: st };
    }),
    check('Unsafe skip needs confirmation', () => {
      try {
        reduce(initialState('sim', T0), { type: 'skip', taskId: 'stuffing-bake' }, T0);
        return { pass: false, expected: 'refused', actual: 'allowed' };
      } catch (e) {
        return { pass: e instanceof ActionError, expected: 'refused', actual: 'refused' };
      }
    }),
    check('Undo restores plan state', () => {
      let s = initialState('sim', T0);
      s = reduce(s, { type: 'start', taskId: 'stuffing-cube-rolls' }, T0).state;
      s = reduce(s, { type: 'undo' }, T0).state;
      const ok = derive(s.events).progress['stuffing-cube-rolls'] == null;
      return { pass: ok, expected: 'not started', actual: ok ? 'not started' : 'still started' };
    }),
    check('Storage round-trip and corruption recovery (isolated)', () => {
      const kv = new MemoryKV();
      const s = reduce(initialState('live', T0), { type: 'shopping/toggle', key: 'butter' }, T0).state;
      saveState(kv, s, T0);
      const ok1 = loadState(kv, 'live', T0).state.shopping.butter === true;
      kv.setItem(KEYS.live, '{broken');
      const r = loadState(kv, 'live', T0);
      const ok2 = r.source === 'recovered';
      return { pass: ok1 && ok2, expected: 'round-trip + recovered', actual: `${ok1 ? 'round-trip' : 'LOST'} + ${r.source}` };
    }),
  ];
  if (opts.full) {
    results.push(
      check('Full nominal simulation', () => {
        const r = runSimulation({ durations: 'nominal' });
        const issues = [...r.planViolations, ...r.historyViolations, ...r.honestyViolations];
        return {
          pass: issues.length === 0 && r.completed === r.total,
          expected: `${r.total}/${r.total}, 0 issues`,
          actual: `${r.completed}/${r.total}, ${issues.length} issues, dinner ${r.dinnerMs ? fmtTime(r.dinnerMs) : '—'}`,
          ...(issues.length ? { details: issues.slice(0, 5).join('; ') } : {}),
        };
      }),
    );
  }
  void TASKS;
  return {
    ranAt: new Date().toISOString(),
    version: opts.version ?? DATA_VERSION,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
  };
}
