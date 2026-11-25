import { describe, expect, it } from 'vitest';
import { plan, verifyPlan, type Plan, type PlanInput, type TaskProgress } from '../domain/scheduler';
import { baselineInput, defaultSettings } from '../domain/fixtures';
import { TASKS } from '../domain/recipes';
import { MINUTE, eventAt } from '../domain/time';

const run = (over: Partial<PlanInput> = {}) => {
  const input = baselineInput(over);
  const p = plan(input);
  return { input, p, v: verifyPlan(input, p) };
};
const at = (p: Plan, id: string) => p.tasks[id]!;
const min = (ms: number) => ms / MINUTE;

describe('scheduler — baseline full meal', () => {
  const { p, v } = run();
  it('schedules every task with no resource/dependency/checkpoint violations', () => {
    expect(v).toEqual([]);
    for (const t of TASKS) expect(at(p, t.id).status, t.id).toBe('scheduled');
  });
  it('projects dinner within the acceptable window and honestly', () => {
    expect(p.dinnerMs).not.toBeNull();
    expect(p.dinnerMs!).toBeLessThanOrEqual(eventAt(13, 15));
    expect(['on-target', 'acceptable']).toContain(p.status);
    const finals = TASKS.filter((t) => t.final).map((t) => at(p, t.id).endMs!);
    expect(p.dinnerMs).toBe(Math.max(...finals));
  });
  it('keeps every dish under the 2-hour room-temperature limit', () => {
    for (const e of p.exposures) expect(e.projectedMin, e.dish).toBeLessThan(120);
    expect(p.warnings.filter((w) => w.code === 'exposure' && w.level === 'danger')).toEqual([]);
  });
  it('uses one oven with two slots at one temperature, in 250 → 400 → 350 order', () => {
    const temps = p.oven.map((o) => o.tempF);
    expect(temps[0]).toBe(250);
    const order = [...new Set(temps)];
    expect(order).toEqual([250, 400, 350]);
    for (const a of p.oven)
      for (const b of p.oven)
        if (a !== b && a.startMs < b.endMs && b.startMs < a.endMs) {
          expect(a.tempF).toBe(b.tempF);
          expect(a.rack === 'both' || b.rack === 'both').toBe(false);
          expect(a.rack).not.toBe(b.rack);
        }
  });
  it('preheats first and starts bread only after preheat is done', () => {
    expect(at(p, 'oven-preheat-250').startMs).toBe(eventAt(8, 0));
    expect(at(p, 'stuffing-dry-bread').startMs!).toBeGreaterThanOrEqual(at(p, 'oven-preheat-250').endMs!);
    expect(at(p, 'mash-garlic-roast').startMs!).toBeGreaterThanOrEqual(at(p, 'oven-to-400').endMs!);
    for (const id of ['stuffing-bake', 'sp-bake', 'gb-bake', 'mac-bake']) expect(at(p, id).startMs!).toBeGreaterThanOrEqual(at(p, 'oven-to-350').endMs!);
  });
  it('reserves the cook for bread stirring, foil removal and onion topping checkpoints', () => {
    const cps = [
      ['stuffing-dry-bread', 'stir20', 20],
      ['stuffing-dry-bread', 'stir40', 40],
      ['stuffing-bake', 'foil', 40],
      ['gb-bake', 'onions', 22],
    ] as const;
    for (const [id, cp, off] of cps) {
      const t = at(p, id);
      const c = t.checkpoints.find((x) => x.id === cp)!;
      expect(c.atMs - t.startMs!).toBe(off * MINUTE);
      expect(t.cook.some(([a]) => a === c.atMs)).toBe(true);
    }
  });
  it('validates the full stovetop workload: burners and cookware never double-booked', () => {
    expect(p.burners.length).toBeGreaterThan(8);
    expect(Math.max(...p.burners.map((b) => b.lane))).toBeLessThan(4);
  });
  it('makes compote early and mash, gravy close to dinner; rests follow their bakes', () => {
    expect(at(p, 'compote-finish').endMs!).toBeLessThan(eventAt(10, 30));
    expect(p.dinnerMs! - at(p, 'mash-mash').endMs!).toBeLessThanOrEqual(30 * MINUTE);
    expect(p.dinnerMs! - at(p, 'gravy-heat').endMs!).toBeLessThanOrEqual(30 * MINUTE);
    expect(at(p, 'stuffing-rest').startMs).toBe(at(p, 'stuffing-bake').endMs);
    expect(at(p, 'mac-rest').startMs).toBe(at(p, 'mac-bake').endMs);
    expect(at(p, 'stuffing-bake').startMs).toBe(at(p, 'stuffing-assemble').endMs);
  });
  it('never plans a task shorter than its minimum', () => {
    for (const t of TASKS) expect(min(at(p, t.id).endMs! - at(p, t.id).startMs!), t.id).toBeGreaterThanOrEqual(t.duration.min);
  });
  it('flags hot dishes that will sit (holding warnings), without claiming hot-holding', () => {
    const holds = p.warnings.filter((w) => w.code === 'hold');
    expect(holds.length).toBeGreaterThan(0);
    for (const h of holds) expect(h.text).toContain('140°F');
  });
  it('is deterministic', () => {
    const a = plan(baselineInput());
    const b = plan(baselineInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('recommends the first task at the start', () => {
    expect(p.recommended).not.toBeNull();
    expect(at(p, p.recommended!).startMs).toBe(eventAt(8, 0));
  });
});

describe('scheduler — start time variations', () => {
  it('early start (20 min) keeps hot dishes near dinner rather than finishing early', () => {
    const base = run();
    const early = run({ nowMs: eventAt(7, 40), kitchenStartMs: eventAt(7, 40) });
    expect(early.v).toEqual([]);
    expect(early.p.dinnerMs!).toBeLessThanOrEqual(eventAt(13, 15));
    expect(early.p.dinnerMs!).toBeGreaterThanOrEqual(eventAt(13, 0));
    expect(at(early.p, 'mash-mash').endMs!).toBeGreaterThanOrEqual(at(base.p, 'mash-mash').endMs! - 30 * MINUTE);
    expect(at(early.p, 'oven-preheat-250').startMs).toBe(eventAt(7, 40));
  });
  for (const late of [30, 60]) {
    it(`late start (${late} min) stays valid and projects honestly`, () => {
      const r = run({ nowMs: eventAt(8, late), kitchenStartMs: eventAt(8, late) });
      expect(r.v).toEqual([]);
      expect(at(r.p, 'oven-preheat-250').startMs!).toBeGreaterThanOrEqual(eventAt(8, late));
      expect(r.p.dinnerMs!).toBeGreaterThanOrEqual(eventAt(13, 0));
      if (r.p.dinnerMs! > eventAt(13, 15)) expect(r.p.status).toBe('late');
      for (const t of TASKS) expect(at(r.p, t.id).status).toBe('scheduled');
    });
  }
});

/** Build a mid-meal state: tasks done per baseline plan up to `untilMs`, some running. */
function progressUntil(untilMs: number): Record<string, TaskProgress> {
  const base = plan(baselineInput());
  const progress: Record<string, TaskProgress> = {};
  for (const t of TASKS) {
    const x = base.tasks[t.id]!;
    if (x.endMs! <= untilMs) progress[t.id] = { startedAt: x.startMs!, completedAt: x.endMs!, checkpointsDone: Object.fromEntries(x.checkpoints.map((c) => [c.id, c.atMs])) };
    else if (x.startMs! <= untilMs) progress[t.id] = { startedAt: x.startMs!, checkpointsDone: Object.fromEntries(x.checkpoints.filter((c) => c.atMs <= untilMs).map((c) => [c.id, c.atMs])) };
  }
  return progress;
}

describe('scheduler — extensions keep cooking whole and the plan valid', () => {
  const cases: [string, number][] = [
    ['stuffing-dry-bread', 10],
    ['mash-garlic-roast', 10],
    ['stuffing-bake', 10],
    ['sp-bake', 5],
    ['gb-bake', 5],
  ];
  for (const [id, ext] of cases) {
    it(`extends ${id} by ${ext} min`, () => {
      const base = plan(baselineInput());
      const t = base.tasks[id]!;
      const now = t.startMs! + (TASKS.find((x) => x.id === id)!.duration.nominal - 1) * MINUTE;
      const progress = progressUntil(now);
      expect(progress[id]?.startedAt).toBeDefined();
      progress[id] = { ...progress[id]!, extensions: [{ at: now, min: ext }] };
      const r = run({ nowMs: now, progress });
      expect(r.v).toEqual([]);
      const pt = at(r.p, id);
      expect(pt.status).toBe('running');
      expect(pt.endMs!).toBeGreaterThanOrEqual(now + ext * MINUTE);
      expect(pt.minEndMs!).toBeGreaterThanOrEqual(now + ext * MINUTE);
      // Dependents wait for the extended task.
      for (const s of TASKS.filter((x) => x.deps.some((d) => d.id === id))) expect(at(r.p, s.id).startMs!).toBeGreaterThanOrEqual(pt.endMs!);
    });
  }
});

describe('scheduler — events', () => {
  it('preserves completed and running tasks exactly', () => {
    const now = eventAt(9, 50);
    const progress = progressUntil(now);
    const r = run({ nowMs: now, progress });
    expect(r.v).toEqual([]);
    for (const [id, pr] of Object.entries(progress)) {
      const x = at(r.p, id);
      expect(x.startMs).toBe(pr.startedAt);
      if (pr.completedAt) {
        expect(x.status).toBe('done');
        expect(x.endMs).toBe(pr.completedAt);
      } else {
        expect(x.status).toBe('running');
        expect(x.endMs!).toBeGreaterThan(now);
      }
    }
  });
  it('a running task past its planned end is projected to need confirmation, never auto-completed', () => {
    const progress: Record<string, TaskProgress> = { 'oven-preheat-250': { startedAt: eventAt(8, 0) } };
    const r = run({ nowMs: eventAt(8, 40), progress });
    const x = at(r.p, 'oven-preheat-250');
    expect(x.status).toBe('running');
    expect(x.overdue).toBe(true);
    expect(x.endMs).toBe(eventAt(8, 41));
    expect(at(r.p, 'stuffing-dry-bread').startMs!).toBeGreaterThanOrEqual(eventAt(8, 41));
    expect(at(r.p, 'stuffing-dry-bread').blockers.join()).toContain('Preheat');
  });
  it('turkey late: carving waits for the new ETA and dinner moves honestly', () => {
    const r = run({ turkeyEtaMs: eventAt(13, 30) });
    expect(r.v).toEqual([]);
    expect(at(r.p, 'turkey-check').startMs!).toBeGreaterThanOrEqual(eventAt(13, 30));
    expect(r.p.dinnerMs!).toBeGreaterThanOrEqual(eventAt(13, 30) + 2 * MINUTE + 10 * MINUTE + 5 * MINUTE);
    expect(r.p.status).toBe('late');
  });
  it('target later shifts hot food later; earlier and impossible targets are reported, not faked', () => {
    const base = run();
    const later = run({ targetMs: eventAt(14, 0) });
    expect(later.v).toEqual([]);
    expect(later.p.dinnerMs).toBe(eventAt(14, 0));
    expect(at(later.p, 'stuffing-bake').startMs!).toBeGreaterThan(at(base.p, 'stuffing-bake').startMs!);
    const earlier = run({ targetMs: eventAt(12, 0) });
    expect(earlier.v).toEqual([]);
    expect(earlier.p.dinnerMs!).toBeGreaterThan(eventAt(12, 0));
    expect(['late', 'acceptable']).toContain(earlier.p.status);
    const impossible = run({ targetMs: eventAt(9, 0) });
    expect(impossible.v).toEqual([]);
    expect(impossible.p.status).toBe('late');
    expect(impossible.p.lateMin).toBeGreaterThan(120);
    expect(impossible.p.warnings.some((w) => w.code === 'late' && w.level === 'danger')).toBe(true);
  });
  it('skipping a hard prerequisite blocks dependents — never silently unlocks them', () => {
    const r = run({ progress: { 'stuffing-cook-sausage': { skippedAt: eventAt(8, 0) } } });
    for (const id of ['stuffing-cook-veg', 'stuffing-season', 'stuffing-assemble', 'stuffing-bake', 'stuffing-rest']) {
      expect(at(r.p, id).status, id).toBe('blocked');
      expect(at(r.p, id).startableNow).toBe(false);
    }
    expect(r.p.status).toBe('blocked');
    expect(r.p.warnings.some((w) => w.code === 'blocked')).toBe(true);
    // Green beans only soft-depend on stuffing-season (shared skillet): still schedulable.
    expect(at(r.p, 'gb-saute').status).toBe('scheduled');
    expect(r.v).toEqual([]);
  });
  it('skipping a whole dish leaves the rest of dinner schedulable', () => {
    const progress: Record<string, TaskProgress> = {};
    for (const t of TASKS.filter((x) => x.dish === 'corn')) progress[t.id] = { skippedAt: eventAt(8, 0) };
    const r = run({ progress });
    expect(r.v).toEqual([]);
    expect(r.p.status).not.toBe('blocked');
  });
  it('soft dependencies unlock when skipped (gravy after compote shares the saucepan)', () => {
    const progress: Record<string, TaskProgress> = {};
    for (const id of ['compote-prep-orange', 'compote-simmer', 'compote-finish']) progress[id] = { skippedAt: eventAt(8, 0) };
    const r = run({ progress });
    expect(at(r.p, 'gravy-heat').status).toBe('scheduled');
    expect(r.v).toEqual([]);
  });
  it('fewer burners or a missing second saucepan still yields a valid plan', () => {
    const s = defaultSettings();
    s.burners = 2;
    s.cookware.saucepan2 = false;
    const r = run({ settings: s });
    expect(r.v).toEqual([]);
    expect(at(r.p, 'mac-sauce').cookware).toEqual(['deepSkillet']);
    expect(Math.max(...r.p.burners.map((b) => b.lane))).toBeLessThan(2);
  });
  it('reports a cook conflict when two hands-on tasks are running', () => {
    const r = run({ nowMs: eventAt(8, 5), progress: { 'stuffing-cube-rolls': { startedAt: eventAt(8, 1) }, 'mash-peel': { startedAt: eventAt(8, 2) } } });
    expect(r.p.warnings.some((w) => w.code === 'cook-conflict')).toBe(true);
  });
  it('pause holds guidance (no recommendation) but keeps running tasks', () => {
    const r = run({ paused: true, nowMs: eventAt(8, 5), progress: { 'oven-preheat-250': { startedAt: eventAt(8, 0) } } });
    expect(r.p.recommended).toBeNull();
    expect(at(r.p, 'oven-preheat-250').status).toBe('running');
  });
  it('delay pushes a task no earlier than the delay', () => {
    const r = run({ progress: { 'compote-prep-orange': { notBefore: eventAt(9, 30) } } });
    expect(at(r.p, 'compote-prep-orange').startMs!).toBeGreaterThanOrEqual(eventAt(9, 30));
    expect(r.v).toEqual([]);
  });
});
