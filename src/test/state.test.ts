import { describe, expect, it } from 'vitest';
import { ActionError, derive, initialState, planInputFrom, reduce, type Action, type CookState } from '../domain/state';
import { KEYS, MemoryKV, loadState, saveState } from '../domain/storage';
import { plan } from '../domain/scheduler';
import { timerStatus } from '../domain/timers';
import { MINUTE, eventAt } from '../domain/time';

const T0 = eventAt(8, 0);
function apply(s: CookState, actions: [Action, number][]): CookState {
  for (const [a, t] of actions) s = reduce(s, a, t).state;
  return s;
}

describe('state & undo', () => {
  it('start creates a doneness timer plus checkpoint timers; expiry never completes the task', () => {
    let s = initialState('live', T0);
    s = apply(s, [
      [{ type: 'start', taskId: 'stuffing-cube-rolls' }, T0],
      [{ type: 'complete', taskId: 'stuffing-cube-rolls' }, T0 + 12 * MINUTE],
      [{ type: 'start', taskId: 'oven-preheat-250' }, T0],
      [{ type: 'complete', taskId: 'oven-preheat-250', safetyConfirmed: true }, T0 + 15 * MINUTE],
      [{ type: 'start', taskId: 'stuffing-dry-bread' }, T0 + 15 * MINUTE],
    ]);
    const bread = s.timers.filter((t) => t.taskId === 'stuffing-dry-bread');
    expect(bread.map((t) => (t.deadlineMs - T0) / MINUTE).sort((a, b) => a - b)).toEqual([35, 55, 75]);
    const later = T0 + 200 * MINUTE;
    expect(bread.every((t) => timerStatus(t, later) === 'expired')).toBe(true);
    const d = derive(s.events);
    expect(d.progress['stuffing-dry-bread']!.completedAt).toBeUndefined();
    expect(plan(planInputFrom(s, later)).tasks['stuffing-dry-bread']!.status).toBe('running');
  });

  it('requires explicit confirmation for safety temps, early completion and unsafe skips', () => {
    let s = initialState('live', T0);
    s = apply(s, [[{ type: 'start', taskId: 'stuffing-cook-sausage' }, T0]]);
    expect(() => reduce(s, { type: 'complete', taskId: 'stuffing-cook-sausage' }, T0 + 10 * MINUTE)).toThrow(/160°F/);
    expect(() => reduce(s, { type: 'complete', taskId: 'stuffing-cook-sausage', safetyConfirmed: true }, T0 + 3 * MINUTE)).toThrow(/minimum/);
    const ok = reduce(s, { type: 'complete', taskId: 'stuffing-cook-sausage', safetyConfirmed: true, earlyConfirmed: true }, T0 + 3 * MINUTE);
    expect(derive(ok.state.events).progress['stuffing-cook-sausage']!.completedAt).toBe(T0 + 3 * MINUTE);
    expect(() => reduce(initialState('live', T0), { type: 'skip', taskId: 'stuffing-bake' }, T0)).toThrow(ActionError);
    const skipped = reduce(initialState('live', T0), { type: 'skip', taskId: 'stuffing-bake', unsafeConfirmed: true }, T0);
    expect(skipped.message).toContain('Rest and garnish stuffing');
  });

  it('refuses to start a task before its hard prerequisites (no silent unlocking)', () => {
    expect(() => reduce(initialState('live', T0), { type: 'start', taskId: 'stuffing-dry-bread' }, T0)).toThrow(/first/);
    const s = reduce(initialState('live', T0), { type: 'skip', taskId: 'oven-preheat-250', unsafeConfirmed: true }, T0).state;
    expect(() => reduce(s, { type: 'start', taskId: 'stuffing-dry-bread' }, T0)).toThrow(/first/);
  });

  it('undo removes the last plan event, cancels only timers that event created, and says nothing physical was reversed', () => {
    let s = initialState('live', T0);
    s = apply(s, [
      [{ type: 'timer/add', label: 'Custom', minutes: 10 }, T0],
      [{ type: 'start', taskId: 'compote-prep-orange' }, T0],
      [{ type: 'complete', taskId: 'compote-prep-orange' }, T0 + 5 * MINUTE],
      [{ type: 'start', taskId: 'compote-simmer' }, T0 + 5 * MINUTE],
    ]);
    const simmerTimers = s.timers.filter((t) => t.taskId === 'compote-simmer');
    expect(simmerTimers.length).toBe(3);
    const r = reduce(s, { type: 'undo' }, T0 + 6 * MINUTE);
    expect(r.message).toMatch(/nothing physical was reversed/);
    expect(derive(r.state.events).progress['compote-simmer']).toBeUndefined();
    for (const t of r.state.timers.filter((x) => x.taskId === 'compote-simmer')) expect(timerStatus(t, T0 + 6 * MINUTE)).toBe('cancelled');
    expect(timerStatus(r.state.timers.find((t) => t.label === 'Custom')!, T0 + 6 * MINUTE)).toBe('running');
    expect(r.state.undone.length).toBe(1);
  });

  it('undo of a completion restores the timers that completion cancelled', () => {
    let s = initialState('live', T0);
    s = apply(s, [[{ type: 'start', taskId: 'oven-preheat-250' }, T0]]);
    s = reduce(s, { type: 'complete', taskId: 'oven-preheat-250', safetyConfirmed: true }, T0 + 5 * MINUTE).state;
    expect(timerStatus(s.timers[0]!, T0 + 6 * MINUTE)).toBe('cancelled');
    s = reduce(s, { type: 'undo' }, T0 + 6 * MINUTE).state;
    expect(timerStatus(s.timers[0]!, T0 + 6 * MINUTE)).toBe('running');
  });

  it('pause does not touch timers; tasks keep running', () => {
    let s = initialState('live', T0);
    s = apply(s, [[{ type: 'start', taskId: 'oven-preheat-250' }, T0]]);
    const before = JSON.stringify(s.timers);
    s = reduce(s, { type: 'pause' }, T0 + MINUTE).state;
    expect(JSON.stringify(s.timers)).toBe(before);
    expect(derive(s.events).paused).toBe(true);
    s = reduce(s, { type: 'resume' }, T0 + 2 * MINUTE).state;
    expect(derive(s.events).paused).toBe(false);
  });

  it('extend moves the task’s doneness timer, not checkpoint timers', () => {
    let s = initialState('live', T0);
    s = apply(s, [
      [{ type: 'start', taskId: 'compote-prep-orange' }, T0],
      [{ type: 'complete', taskId: 'compote-prep-orange' }, T0 + 5 * MINUTE],
      [{ type: 'start', taskId: 'compote-simmer' }, T0 + 5 * MINUTE],
      [{ type: 'extend', taskId: 'compote-simmer', min: 5 }, T0 + 21 * MINUTE],
    ]);
    const main = s.timers.find((t) => t.taskId === 'compote-simmer' && !t.checkpointId)!;
    expect(main.deadlineMs).toBe(T0 + 26 * MINUTE);
    const cp = s.timers.find((t) => t.checkpointId === 'stir')!;
    expect(cp.deadlineMs).toBe(T0 + 12 * MINUTE);
  });
});

describe('persistence', () => {
  const full = () =>
    apply(initialState('live', T0), [
      [{ type: 'start', taskId: 'oven-preheat-250' }, T0],
      [{ type: 'shopping/toggle', key: 'butter' }, T0],
      [{ type: 'recipe/toggle', key: 'mash:0' }, T0],
      [{ type: 'settings', patch: { burners: 3, helperCarvesTurkey: true } }, T0],
      [{ type: 'setTarget', ms: eventAt(13, 30) }, T0],
      [{ type: 'setTurkeyEta', ms: eventAt(12, 45) }, T0],
      [{ type: 'timer/add', label: 'Wine', minutes: 30 }, T0],
    ]);

  it('round-trips progress, shopping, settings, target, turkey and timers', () => {
    const kv = new MemoryKV();
    const s = full();
    expect(saveState(kv, s, T0)).toBe(true);
    const r = loadState(kv, 'live', T0 + 90 * MINUTE);
    expect(r.source).toBe('stored');
    expect(r.notices).toEqual([]);
    expect(r.state).toEqual(s);
    const d = derive(r.state.events);
    expect(d.targetMs).toBe(eventAt(13, 30));
    expect(d.turkeyEtaMs).toBe(eventAt(12, 45));
    expect(d.progress['oven-preheat-250']!.startedAt).toBe(T0);
    // Expired after "reload" — not restarted.
    const wine = r.state.timers.find((t) => t.label === 'Wine')!;
    expect(timerStatus(wine, T0 + 90 * MINUTE)).toBe('expired');
  });

  it('recovers from corrupt JSON with a backup copy', () => {
    const kv = new MemoryKV();
    kv.setItem(KEYS.live, '{"version":2,"state":{"events":[');
    const r = loadState(kv, 'live', T0);
    expect(r.source).toBe('recovered');
    expect(r.notices[0]).toMatch(/corrupted/);
    expect(kv.keys().some((k) => k.startsWith('tcc:corrupt:'))).toBe(true);
    expect(r.state.events).toEqual([]);
  });

  it('keeps valid progress when only some entries are damaged', () => {
    const kv = new MemoryKV();
    const s = full();
    const doc = JSON.parse(JSON.stringify({ version: 2, state: s }));
    doc.state.events.push({ type: 'start', id: 'x', at: 'nope', taskId: 'stuffing-bake' });
    doc.state.events.push({ type: 'start', id: 'y', at: 1, taskId: 'not-a-task' });
    doc.state.timers.push({ id: 'bad' });
    doc.state.settings.burners = 99;
    doc.state.shopping.eggs = 'yes';
    kv.setItem(KEYS.live, JSON.stringify(doc));
    const r = loadState(kv, 'live', T0);
    expect(r.source).toBe('recovered');
    expect(r.state.events).toEqual(s.events);
    expect(r.state.timers.length).toBe(s.timers.length);
    expect(r.state.settings.burners).toBe(4);
    expect(r.state.shopping).toEqual({ butter: true });
    expect(r.notices.join(' ')).toMatch(/damaged/);
  });

  it('rejects unknown future versions without destroying them', () => {
    const kv = new MemoryKV();
    kv.setItem(KEYS.live, JSON.stringify({ version: 99, state: {} }));
    const r = loadState(kv, 'live', T0);
    expect(r.notices[0]).toMatch(/unknown version/);
    expect(kv.keys().some((k) => k.startsWith('tcc:corrupt:'))).toBe(true);
  });

  it('migrates pre-release v1 data to the event log', () => {
    const kv = new MemoryKV();
    kv.setItem(
      KEYS.legacyV1,
      JSON.stringify({
        version: 1,
        target: '13:20',
        progress: { 'oven-preheat-250': { startedAt: T0, completedAt: T0 + 15 * MINUTE }, 'compote-prep-orange': { startedAt: T0 + MINUTE }, bogus: { startedAt: T0 } },
        shopping: { butter: true },
        timers: [],
      }),
    );
    const r = loadState(kv, 'live', T0 + 20 * MINUTE);
    expect(r.source).toBe('migrated');
    const d = derive(r.state.events);
    expect(d.progress['oven-preheat-250']!.completedAt).toBe(T0 + 15 * MINUTE);
    expect(d.progress['compote-prep-orange']!.startedAt).toBe(T0 + MINUTE);
    expect(d.targetMs).toBe(eventAt(13, 20));
    expect(r.state.shopping.butter).toBe(true);
    expect(r.notices.join(' ')).toMatch(/bogus/);
    expect(kv.getItem(KEYS.legacyV1)).toBeNull();
    expect(kv.getItem(KEYS.live)).not.toBeNull();
  });

  it('reset progress keeps shopping and settings; reset all clears everything', () => {
    const s = full();
    const p = reduce(s, { type: 'reset', scope: 'progress' }, T0).state;
    expect(p.events).toEqual([]);
    expect(p.timers).toEqual([]);
    expect(p.shopping).toEqual(s.shopping);
    expect(p.settings.burners).toBe(3);
    const a = reduce(s, { type: 'reset', scope: 'all' }, T0).state;
    expect(a.shopping).toEqual({});
    expect(a.settings.burners).toBe(4);
  });

  it('simulation state is isolated from live state', () => {
    const kv = new MemoryKV();
    const live = full();
    saveState(kv, live, T0);
    let sim = loadState(kv, 'sim', T0).state;
    expect(sim.namespace).toBe('sim');
    expect(sim.events).toEqual([]);
    sim = apply(sim, [
      [{ type: 'start', taskId: 'stuffing-cube-rolls' }, T0],
      [{ type: 'sim/set', ms: T0 + 60 * MINUTE }, T0],
    ]);
    saveState(kv, sim, T0);
    expect(loadState(kv, 'live', T0).state).toEqual(live);
    expect(loadState(kv, 'sim', T0).state.simNow).toBe(T0 + 60 * MINUTE);
    expect(() => reduce(live, { type: 'sim/set', ms: 0 }, T0)).toThrow(/live clock/);
  });
});
