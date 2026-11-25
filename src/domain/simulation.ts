/**
 * Full-meal simulation using the PRODUCTION reducer, planner and timers with an injected clock.
 * A simulated cook follows the plan: starts the recommended task, records checkpoints when due,
 * extends tasks that need more time, and confirms completion when the (sampled) real duration has
 * passed. The executed history is then independently verified.
 */
import { DISHES, TASKS } from './recipes';
import { mulberry32, plan, verifyPlan, type Plan } from './scheduler';
import { initialState, planInputFrom, reduce, type Action, type CookState } from './state';
import { DEFAULT_KITCHEN_START, MINUTE, fmtTime } from './time';

export interface SimOptions {
  seed?: number;
  /** 'nominal' uses each task's nominal time; 'random' samples uniformly within [min, max]. */
  durations: 'nominal' | 'random' | 'max';
  startMs?: number;
  turkeyDelayMin?: number;
  targetMs?: number;
  /** Stop after this many plan computations (safety). */
  maxSteps?: number;
}

export interface SimResult {
  completed: number;
  total: number;
  dinnerMs: number | null;
  firstProjectionMs: number | null;
  planViolations: string[];
  historyViolations: string[];
  honestyViolations: string[];
  checkpointInterruptions: number;
  maxExposureMin: number;
  steps: number;
  log: { taskId: string; start: number; end: number }[];
  oven: { taskId: string; start: number; end: number; tempF: number }[];
  finalPlan: Plan;
}

export function runSimulation(opts: SimOptions): SimResult {
  const rand = mulberry32(opts.seed ?? 1);
  const start = opts.startMs ?? DEFAULT_KITCHEN_START;
  let t = start;
  let state: CookState = initialState('sim', t);
  const act = (a: Action) => {
    state = reduce(state, a, t).state;
  };
  if (start !== DEFAULT_KITCHEN_START) act({ type: 'setKitchenStart', ms: start });
  if (opts.targetMs) act({ type: 'setTarget', ms: opts.targetMs });
  const actualDur = new Map<string, number>();
  const sample = (id: string) => {
    const d = TASKS.find((x) => x.id === id)!.duration;
    if (opts.durations === 'nominal') return d.nominal;
    if (opts.durations === 'max') return d.max;
    return Math.round(d.min + rand() * (d.max - d.min));
  };
  // Pre-sample deterministically in task order so the seed fully determines the run.
  for (const tk of TASKS) actualDur.set(tk.id, sample(tk.id));
  const turkeyArrives = planInputFrom(state, t).turkeyEtaMs + (opts.turkeyDelayMin ?? 0) * MINUTE;

  const planViolations: string[] = [];
  const honesty: string[] = [];
  let firstProjection: number | null = null;
  let steps = 0;
  let interruptions = 0;
  let maxExposure = 0;
  const maxSteps = opts.maxSteps ?? 2000;
  let p: Plan = plan(planInputFrom(state, t));

  const done = () => TASKS.every((tk) => p.tasks[tk.id]!.status === 'done' || p.tasks[tk.id]!.status === 'skipped' || p.tasks[tk.id]!.status === 'blocked');

  while (steps < maxSteps) {
    const input = planInputFrom(state, t);
    p = plan(input);
    steps++;
    if (firstProjection == null) firstProjection = p.dinnerMs;
    for (const v of verifyPlan(input, p)) planViolations.push(`${fmtTime(t)} ${v}`);
    // Honesty: never project a task (or dinner) earlier than its minimum allows.
    for (const tk of TASKS) {
      const x = p.tasks[tk.id]!;
      if (x.status === 'running' && x.endMs! < (x.minEndMs ?? 0)) honesty.push(`${tk.id} projected before its minimum`);
      if ((x.status === 'running' || x.status === 'scheduled') && x.endMs! <= t && tk.duration.nominal > 0) honesty.push(`${fmtTime(t)} ${tk.id} projected to end in the past`);
    }
    if (p.dinnerMs != null && !done() && p.dinnerMs <= t) honesty.push(`${fmtTime(t)} dinner projected in the past`);
    if (done()) break;

    let acted = false;
    // 1) Completions whose real time has elapsed.
    for (const tk of TASKS) {
      const x = p.tasks[tk.id]!;
      if (x.status !== 'running') continue;
      const s = x.startMs!;
      const realEnd = s + actualDur.get(tk.id)! * MINUTE;
      for (const c of x.checkpoints) if (!c.done && c.atMs <= t) {
        if (TASKS.some((o) => o.attention === 'active' && o.id !== tk.id && p.tasks[o.id]!.status === 'running')) interruptions++;
        act({ type: 'checkpoint', taskId: tk.id, checkpointId: c.id });
        acted = true;
      }
      if (t >= realEnd) {
        act({ type: 'complete', taskId: tk.id, safetyConfirmed: true });
        acted = true;
      } else if (x.overdue || x.endMs! <= t + MINUTE) {
        // The cook checks, sees it's not done, and extends by the honest remaining time.
        const remain = Math.ceil((realEnd - t) / MINUTE);
        if (remain > 0 && x.endMs! < realEnd) {
          act({ type: 'extend', taskId: tk.id, min: remain });
          acted = true;
        }
      }
    }
    if (p.tasks['turkey-arrive']!.status === 'scheduled' && t >= turkeyArrives) {
      act({ type: 'complete', taskId: 'turkey-arrive' });
      acted = true;
    }
    if (acted) continue;
    // 2) Start the recommended task if its time has come.
    if (p.recommended && p.recommended !== 'turkey-arrive') {
      act({ type: 'start', taskId: p.recommended, cookware: p.tasks[p.recommended]!.cookware });
      continue;
    }
    // 3) Advance the clock to the next interesting moment.
    const cands: number[] = [];
    for (const tk of TASKS) {
      const x = p.tasks[tk.id]!;
      if (x.status === 'running') {
        cands.push(x.startMs! + actualDur.get(tk.id)! * MINUTE);
        for (const c of x.checkpoints) if (!c.done) cands.push(c.atMs);
        cands.push(x.endMs!);
      }
      if (x.status === 'scheduled' && x.startMs != null) cands.push(x.startMs);
    }
    if (p.tasks['turkey-arrive']!.status === 'scheduled') cands.push(turkeyArrives);
    const next = Math.min(...cands.filter((c) => c > t));
    t = Number.isFinite(next) ? Math.max(t + MINUTE, Math.ceil(next / MINUTE) * MINUTE) : t + MINUTE;
  }

  // ── Verify the executed history ──
  const hist: string[] = [];
  const log: SimResult['log'] = [];
  const evs = state.events;
  const startAt = new Map<string, number>();
  const endAt = new Map<string, number>();
  for (const e of evs) {
    if (e.type === 'start') startAt.set(e.taskId, e.at);
    if (e.type === 'complete') {
      endAt.set(e.taskId, e.at);
      if (!startAt.has(e.taskId)) startAt.set(e.taskId, e.at);
    }
  }
  let completed = 0;
  for (const tk of TASKS) {
    const s = startAt.get(tk.id);
    const e = endAt.get(tk.id);
    if (s == null || e == null) {
      hist.push(`${tk.id} never completed`);
      continue;
    }
    completed++;
    log.push({ taskId: tk.id, start: s, end: e });
    if ((e - s) / MINUTE < tk.duration.min) hist.push(`${tk.id} cooked ${(e - s) / MINUTE} min < minimum ${tk.duration.min}`);
    for (const d of tk.deps) {
      const de = endAt.get(d.id);
      if (de == null || de > s) hist.push(`${tk.id} started before ${d.id} finished`);
    }
    for (const c of tk.checkpoints ?? []) {
      const ce = evs.find((x) => x.type === 'checkpoint' && x.taskId === tk.id && x.checkpointId === c.id);
      if (!ce) hist.push(`${tk.id} checkpoint ${c.id} never recorded`);
      else if (ce.at - (s + c.at * MINUTE) > 2 * MINUTE) hist.push(`${tk.id} checkpoint ${c.id} late by ${(ce.at - (s + c.at * MINUTE)) / MINUTE} min`);
    }
    if (tk.follows) {
      const pe = endAt.get(tk.follows);
      if (pe != null && s - pe > 2 * MINUTE) hist.push(`${tk.id} started ${(s - pe) / MINUTE} min after ${tk.follows} (no-wait)`);
    }
  }
  // Resource usage minute by minute from actual history.
  const settings = state.settings;
  const tmin = Math.min(...log.map((l) => l.start));
  const tmax = Math.max(...log.map((l) => l.end));
  for (let m = tmin; m < tmax; m += MINUTE) {
    let burners = 0;
    let oven = 0;
    let active = 0;
    const temps = new Set<number>();
    const ware = new Set<string>();
    for (const l of log) {
      if (m < l.start || m >= l.end) continue;
      const tk = TASKS.find((x) => x.id === l.taskId)!;
      burners += tk.burners ?? 0;
      if (tk.oven) {
        oven += tk.oven.slots;
        temps.add(tk.oven.tempF);
      }
      const used = evs.find((e) => e.type === 'start' && e.taskId === tk.id && 'cookware' in e)?.cookware ?? [];
      for (const c of used) {
        if (ware.has(c)) hist.push(`${fmtTime(m)} ${c} used twice`);
        ware.add(c);
      }
      if (tk.attention === 'active' && !(tk.id === 'turkey-carve' && settings.helperCarvesTurkey)) active++;
    }
    if (burners > settings.burners) hist.push(`${fmtTime(m)} ${burners} burners in use`);
    if (oven > 2) hist.push(`${fmtTime(m)} oven over capacity`);
    if (temps.size > 1) hist.push(`${fmtTime(m)} oven at two temperatures`);
    if (active > 1) hist.push(`${fmtTime(m)} two hands-on tasks at once`);
  }
  const finals = TASKS.filter((tk) => tk.final).map((tk) => endAt.get(tk.id) ?? 0);
  const dinner = finals.length ? Math.max(...finals) : null;
  const finalPlan = plan(planInputFrom(state, t));
  if (finalPlan.dinnerMs !== dinner) honesty.push(`final projection ${finalPlan.dinnerMs && fmtTime(finalPlan.dinnerMs)} ≠ actual ${dinner && fmtTime(dinner)}`);
  void DISHES;
  for (const e of finalPlan.exposures) maxExposure = Math.max(maxExposure, e.projectedMin);
  return {
    completed,
    total: TASKS.length,
    dinnerMs: dinner,
    firstProjectionMs: firstProjection,
    planViolations: [...new Set(planViolations)],
    historyViolations: [...new Set(hist)],
    honestyViolations: [...new Set(honesty)],
    checkpointInterruptions: interruptions,
    maxExposureMin: maxExposure,
    steps,
    log,
    oven: log.filter((l) => TASKS.find((x) => x.id === l.taskId)!.oven).map((l) => ({ ...l, tempF: TASKS.find((x) => x.id === l.taskId)!.oven!.tempF })),
    finalPlan,
  };
}
