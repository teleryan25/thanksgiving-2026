/**
 * Event-sourced cooking state. Task progress, dinner target, turkey ETA and pause are derived
 * from an append-only event log, which makes undo honest: undo removes the last plan event and
 * says plainly that nothing physical was reversed. Timers, shopping checks, recipe reference
 * checks and settings live beside the log and are NOT touched by undo (except timers that the
 * undone event itself created or cancelled).
 */
import { COOKWARE, DISHES, TASKS } from './recipes';
import type { PlanInput, PlanSettings, TaskProgress } from './scheduler';
import { DEFAULT_KITCHEN_START, DEFAULT_TARGET, DEFAULT_TURKEY_ETA, MINUTE } from './time';
import { ackTimer, cancelTimer, createTimer, extendTimer, timerStatus, type Timer } from './timers';

export const STATE_VERSION = 2;

interface EvBase {
  id: string;
  at: number;
}
export type CookEvent =
  | (EvBase & { type: 'start'; taskId: string; cookware?: string[]; timerIds?: string[] })
  | (EvBase & { type: 'complete'; taskId: string; note?: string; earlyConfirmed?: boolean; safetyConfirmed?: boolean; cancelledTimerIds?: string[] })
  | (EvBase & { type: 'skip'; taskId: string; unsafeConfirmed?: boolean; reason?: string })
  | (EvBase & { type: 'extend'; taskId: string; min: number; timerIds?: string[] })
  | (EvBase & { type: 'delay'; taskId: string; min: number })
  | (EvBase & { type: 'checkpoint'; taskId: string; checkpointId: string })
  | (EvBase & { type: 'pause' })
  | (EvBase & { type: 'resume' })
  | (EvBase & { type: 'setTarget'; ms: number })
  | (EvBase & { type: 'setTurkeyEta'; ms: number })
  | (EvBase & { type: 'setKitchenStart'; ms: number });

export interface Settings extends PlanSettings {
  sound: boolean;
  vibration: boolean;
  wakeLock: boolean;
}

export interface CookState {
  version: number;
  namespace: 'live' | 'sim';
  createdAt: number;
  seq: number;
  events: CookEvent[];
  undone: { event: CookEvent; undoneAt: number }[];
  timers: Timer[];
  shopping: Record<string, boolean>;
  recipeChecks: Record<string, boolean>;
  settings: Settings;
  /** Simulation only: virtual clock. */
  simNow?: number;
}

export function defaultSettings(): Settings {
  return {
    burners: 4,
    cookware: Object.fromEntries(COOKWARE.map((c) => [c.id, true])),
    helperCarvesTurkey: false,
    hotRoom: false,
    sound: false,
    vibration: false,
    wakeLock: false,
  };
}

export function initialState(namespace: 'live' | 'sim', now: number): CookState {
  return {
    version: STATE_VERSION,
    namespace,
    createdAt: now,
    seq: 0,
    events: [],
    undone: [],
    timers: [],
    shopping: {},
    recipeChecks: {},
    settings: defaultSettings(),
    ...(namespace === 'sim' ? { simNow: DEFAULT_KITCHEN_START } : {}),
  };
}

// ───────────────────────────── Derivation ─────────────────────────────

export interface Derived {
  progress: Record<string, TaskProgress>;
  targetMs: number;
  turkeyEtaMs: number;
  kitchenStartMs: number;
  paused: boolean;
}

export function derive(events: CookEvent[]): Derived {
  const progress: Record<string, TaskProgress> = {};
  const p = (id: string) => (progress[id] ??= {});
  let targetMs = DEFAULT_TARGET;
  let turkeyEtaMs = DEFAULT_TURKEY_ETA;
  let kitchenStartMs = DEFAULT_KITCHEN_START;
  let paused = false;
  for (const e of events) {
    switch (e.type) {
      case 'start':
        p(e.taskId).startedAt = e.at;
        if (e.cookware) p(e.taskId).cookwareUsed = e.cookware;
        break;
      case 'complete': {
        const x = p(e.taskId);
        x.startedAt ??= e.at;
        x.completedAt = e.at;
        break;
      }
      case 'skip':
        p(e.taskId).skippedAt = e.at;
        break;
      case 'extend':
        (p(e.taskId).extensions ??= []).push({ at: e.at, min: e.min });
        break;
      case 'delay':
        p(e.taskId).notBefore = e.at + e.min * MINUTE;
        break;
      case 'checkpoint':
        (p(e.taskId).checkpointsDone ??= {})[e.checkpointId] = e.at;
        break;
      case 'pause':
        paused = true;
        break;
      case 'resume':
        paused = false;
        break;
      case 'setTarget':
        targetMs = e.ms;
        break;
      case 'setTurkeyEta':
        turkeyEtaMs = e.ms;
        break;
      case 'setKitchenStart':
        kitchenStartMs = e.ms;
        break;
    }
  }
  return { progress, targetMs, turkeyEtaMs, kitchenStartMs, paused };
}

export function planInputFrom(state: CookState, nowMs: number): PlanInput {
  const d = derive(state.events);
  return {
    tasks: TASKS,
    dishes: DISHES,
    progress: d.progress,
    nowMs,
    kitchenStartMs: d.kitchenStartMs,
    targetMs: d.targetMs,
    turkeyEtaMs: d.turkeyEtaMs,
    paused: d.paused,
    settings: {
      burners: state.settings.burners,
      cookware: state.settings.cookware,
      helperCarvesTurkey: state.settings.helperCarvesTurkey,
      hotRoom: state.settings.hotRoom,
    },
  };
}

// ───────────────────────────── Actions ─────────────────────────────

export type Action =
  | { type: 'start'; taskId: string; cookware?: string[] }
  | { type: 'complete'; taskId: string; earlyConfirmed?: boolean; safetyConfirmed?: boolean; note?: string }
  | { type: 'skip'; taskId: string; unsafeConfirmed?: boolean; reason?: string }
  | { type: 'extend'; taskId: string; min: number }
  | { type: 'delay'; taskId: string; min: number }
  | { type: 'checkpoint'; taskId: string; checkpointId: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setTarget'; ms: number }
  | { type: 'setTurkeyEta'; ms: number }
  | { type: 'setKitchenStart'; ms: number }
  | { type: 'undo' }
  | { type: 'timer/add'; label: string; minutes: number }
  | { type: 'timer/extend'; timerId: string; min: number }
  | { type: 'timer/cancel'; timerId: string }
  | { type: 'timer/ack'; timerId: string }
  | { type: 'shopping/toggle'; key: string }
  | { type: 'shopping/clear' }
  | { type: 'recipe/toggle'; key: string }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'reset'; scope: 'progress' | 'all' }
  | { type: 'sim/set'; ms: number };

export class ActionError extends Error {}

export interface Result {
  state: CookState;
  message?: string;
}

const taskDef = (id: string) => {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new ActionError(`Unknown task ${id}`);
  return t;
};

/**
 * Pure reducer. `now` is injected (live or simulated clock). Unsafe operations require an
 * explicit confirmation flag; without it they throw ActionError and change nothing.
 */
export function reduce(state: CookState, action: Action, now: number): Result {
  let seq = state.seq;
  const nextId = (prefix: string) => `${prefix}-${state.namespace}-${++seq}`;
  const d = derive(state.events);
  const push = (e: CookEvent, extra: Partial<CookState> = {}, message?: string): Result => ({
    state: { ...state, ...extra, seq, events: [...state.events, e] },
    ...(message ? { message } : {}),
  });

  switch (action.type) {
    case 'start': {
      const t = taskDef(action.taskId);
      const pr = d.progress[t.id];
      if (pr?.startedAt != null || pr?.completedAt != null || pr?.skippedAt != null) throw new ActionError(`${t.title} was already started, finished or skipped.`);
      for (const dep of t.deps) {
        const dp = d.progress[dep.id];
        const ok = dp?.completedAt != null || (dp?.skippedAt != null && dep.soft);
        if (!ok && !dep.soft) throw new ActionError(`Finish "${taskDef(dep.id).title}" first.`);
      }
      const timers: Timer[] = [];
      if (t.timer && t.duration.min > 0) timers.push(createTimer({ id: nextId('tmr'), label: `${t.timer}`, startMs: now, minutes: t.duration.min + (pr?.extensions ?? []).reduce((a, x) => a + x.min, 0), taskId: t.id }));
      for (const c of t.checkpoints ?? []) timers.push(createTimer({ id: nextId('tmr'), label: c.label, startMs: now, minutes: c.at, taskId: t.id, checkpointId: c.id }));
      const ev: CookEvent = { type: 'start', id: nextId('ev'), at: now, taskId: t.id, ...(action.cookware ? { cookware: action.cookware } : {}), timerIds: timers.map((x) => x.id) };
      return push(ev, { timers: [...state.timers, ...timers] });
    }
    case 'complete': {
      const t = taskDef(action.taskId);
      const pr = d.progress[t.id];
      if (pr?.completedAt != null || pr?.skippedAt != null) throw new ActionError(`${t.title} is already ${pr.completedAt != null ? 'done' : 'skipped'}.`);
      if (t.attention !== 'external' && pr?.startedAt == null) throw new ActionError(`Start "${t.title}" before marking it done.`);
      if ((t.safety || t.confirm) && !action.safetyConfirmed) throw new ActionError(t.safety ? `Confirm ${t.safety.what} reached ${t.safety.tempF}°F.` : `Confirm: ${t.confirm}.`);
      if (pr?.startedAt != null && t.enforceMin) {
        const ext = (pr.extensions ?? []).reduce((a, x) => a + x.min, 0);
        const minEnd = pr.startedAt + (t.duration.min + ext) * MINUTE;
        if (now < minEnd && !action.earlyConfirmed) throw new ActionError(`${t.title} has a ${t.duration.min}-minute minimum. Confirm the doneness cues to finish early.`);
      }
      const cancelled: string[] = [];
      const timers = state.timers.map((x) => {
        if (x.taskId === t.id && timerStatus(x, now) === 'running') {
          cancelled.push(x.id);
          return cancelTimer(x, now, 'task completed');
        }
        return x;
      });
      const ev: CookEvent = {
        type: 'complete',
        id: nextId('ev'),
        at: now,
        taskId: t.id,
        ...(action.note ? { note: action.note } : {}),
        ...(action.earlyConfirmed ? { earlyConfirmed: true } : {}),
        ...(action.safetyConfirmed ? { safetyConfirmed: true } : {}),
        cancelledTimerIds: cancelled,
      };
      return push(ev, { timers });
    }
    case 'skip': {
      const t = taskDef(action.taskId);
      const pr = d.progress[t.id];
      if (pr?.completedAt != null || pr?.skippedAt != null) throw new ActionError(`${t.title} is already finished or skipped.`);
      if ((t.critical || t.safety) && !action.unsafeConfirmed) throw new ActionError(`Skipping "${t.title}" is a food-safety or critical step. Explicit confirmation required.`);
      const dependents = TASKS.filter((x) => x.deps.some((dd) => dd.id === t.id && !dd.soft)).map((x) => x.title);
      const ev: CookEvent = { type: 'skip', id: nextId('ev'), at: now, taskId: t.id, ...(action.unsafeConfirmed ? { unsafeConfirmed: true } : {}), ...(action.reason ? { reason: action.reason } : {}) };
      return push(ev, {}, dependents.length ? `Skipped. Still blocked until you decide: ${dependents.join(', ')}.` : 'Skipped.');
    }
    case 'extend': {
      const t = taskDef(action.taskId);
      if (!(action.min > 0)) throw new ActionError('Extension must be positive.');
      const pr = d.progress[t.id];
      if (pr?.completedAt != null || pr?.skippedAt != null) throw new ActionError(`${t.title} is finished.`);
      const extended: string[] = [];
      const timers = state.timers.map((x) => {
        if (x.taskId === t.id && !x.checkpointId && x.cancelledAt == null) {
          extended.push(x.id);
          return extendTimer(x, action.min, now);
        }
        return x;
      });
      return push({ type: 'extend', id: nextId('ev'), at: now, taskId: t.id, min: action.min, timerIds: extended }, { timers });
    }
    case 'delay': {
      const t = taskDef(action.taskId);
      if (!(action.min > 0)) throw new ActionError('Delay must be positive.');
      if (d.progress[t.id]?.startedAt != null) throw new ActionError(`${t.title} already started.`);
      return push({ type: 'delay', id: nextId('ev'), at: now, taskId: t.id, min: action.min });
    }
    case 'checkpoint': {
      const t = taskDef(action.taskId);
      if (!t.checkpoints?.some((c) => c.id === action.checkpointId)) throw new ActionError('Unknown checkpoint.');
      if (d.progress[t.id]?.startedAt == null) throw new ActionError(`Start "${t.title}" first.`);
      const timers = state.timers.map((x) => (x.taskId === t.id && x.checkpointId === action.checkpointId ? (timerStatus(x, now) === 'running' ? cancelTimer(x, now, 'checkpoint done') : ackTimer(x, now)) : x));
      return push({ type: 'checkpoint', id: nextId('ev'), at: now, taskId: t.id, checkpointId: action.checkpointId }, { timers });
    }
    case 'pause':
      if (d.paused) return { state };
      return push({ type: 'pause', id: nextId('ev'), at: now }, {}, 'Guidance paused. Timers keep running.');
    case 'resume':
      if (!d.paused) return { state };
      return push({ type: 'resume', id: nextId('ev'), at: now });
    case 'setTarget':
      return push({ type: 'setTarget', id: nextId('ev'), at: now, ms: action.ms });
    case 'setTurkeyEta':
      return push({ type: 'setTurkeyEta', id: nextId('ev'), at: now, ms: action.ms });
    case 'setKitchenStart':
      return push({ type: 'setKitchenStart', id: nextId('ev'), at: now, ms: action.ms });
    case 'undo': {
      const last = state.events[state.events.length - 1];
      if (!last) throw new ActionError('Nothing to undo.');
      let timers = state.timers;
      if (last.type === 'start' && last.timerIds?.length) timers = timers.map((x) => (last.timerIds!.includes(x.id) ? cancelTimer(x, now, 'undo') : x));
      if (last.type === 'complete' && last.cancelledTimerIds?.length)
        timers = timers.map((x) => {
          if (!last.cancelledTimerIds!.includes(x.id)) return x;
          const { cancelledAt: _c, cancelReason: _r, ...rest } = x;
          return rest;
        });
      const label = describeEvent(last);
      return {
        state: { ...state, seq, events: state.events.slice(0, -1), undone: [...state.undone, { event: last, undoneAt: now }].slice(-50), timers },
        message: `Undid: ${label}. This only changes the plan — nothing physical was reversed.`,
      };
    }
    case 'timer/add': {
      if (!(action.minutes > 0)) throw new ActionError('Timer must be positive.');
      const t = createTimer({ id: nextId('tmr'), label: action.label || 'Timer', startMs: now, minutes: action.minutes });
      return { state: { ...state, seq, timers: [...state.timers, t] } };
    }
    case 'timer/extend':
      if (!(action.min > 0)) throw new ActionError('Extension must be positive.');
      return { state: { ...state, timers: state.timers.map((x) => (x.id === action.timerId ? extendTimer(x, action.min, now) : x)) } };
    case 'timer/cancel':
      return { state: { ...state, timers: state.timers.map((x) => (x.id === action.timerId ? cancelTimer(x, now) : x)) } };
    case 'timer/ack':
      return { state: { ...state, timers: state.timers.map((x) => (x.id === action.timerId ? ackTimer(x, now) : x)) } };
    case 'shopping/toggle':
      return { state: { ...state, shopping: { ...state.shopping, [action.key]: !state.shopping[action.key] } } };
    case 'shopping/clear':
      return { state: { ...state, shopping: {} } };
    case 'recipe/toggle':
      return { state: { ...state, recipeChecks: { ...state.recipeChecks, [action.key]: !state.recipeChecks[action.key] } } };
    case 'settings': {
      const patch = action.patch;
      if (patch.burners != null && !(Number.isInteger(patch.burners) && patch.burners >= 1 && patch.burners <= 8)) throw new ActionError('Burners must be 1–8.');
      return { state: { ...state, settings: { ...state.settings, ...patch, cookware: { ...state.settings.cookware, ...(patch.cookware ?? {}) } } } };
    }
    case 'reset': {
      const fresh = initialState(state.namespace, now);
      if (action.scope === 'progress')
        return { state: { ...fresh, shopping: state.shopping, recipeChecks: state.recipeChecks, settings: state.settings, seq }, message: 'Cooking progress and timers reset. Shopping checks and settings kept.' };
      return { state: { ...fresh, seq }, message: 'Everything reset.' };
    }
    case 'sim/set':
      if (state.namespace !== 'sim') throw new ActionError('The live clock cannot be changed.');
      return { state: { ...state, simNow: action.ms } };
  }
}

export function describeEvent(e: CookEvent): string {
  const title = 'taskId' in e ? (TASKS.find((t) => t.id === e.taskId)?.title ?? e.taskId) : '';
  switch (e.type) {
    case 'start':
      return `Started "${title}"`;
    case 'complete':
      return `Finished "${title}"`;
    case 'skip':
      return `Skipped "${title}"`;
    case 'extend':
      return `Extended "${title}" by ${e.min} min`;
    case 'delay':
      return `Delayed "${title}" by ${e.min} min`;
    case 'checkpoint':
      return `Checkpoint on "${title}"`;
    case 'pause':
      return 'Paused guidance';
    case 'resume':
      return 'Resumed guidance';
    case 'setTarget':
      return 'Changed dinner target';
    case 'setTurkeyEta':
      return 'Changed turkey ETA';
    case 'setKitchenStart':
      return 'Changed kitchen start';
  }
}

// ───────────────────────────── Validation ─────────────────────────────

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const TASK_IDS = new Set(TASKS.map((t) => t.id));

export function isEvent(x: unknown): x is CookEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  if (!isStr(e.id) || !isNum(e.at) || !isStr(e.type)) return false;
  const task = () => isStr(e.taskId) && TASK_IDS.has(e.taskId);
  switch (e.type) {
    case 'start':
    case 'complete':
    case 'skip':
      return task();
    case 'extend':
    case 'delay':
      return task() && isNum(e.min) && e.min > 0;
    case 'checkpoint':
      return task() && isStr(e.checkpointId);
    case 'pause':
    case 'resume':
      return true;
    case 'setTarget':
    case 'setTurkeyEta':
    case 'setKitchenStart':
      return isNum(e.ms);
    default:
      return false;
  }
}

export function sanitizeSettings(x: unknown): Settings {
  const d = defaultSettings();
  if (!x || typeof x !== 'object') return d;
  const s = x as Record<string, unknown>;
  const bool = (k: keyof Settings) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : (d[k] as boolean));
  const cw: Record<string, boolean> = { ...d.cookware };
  if (s.cookware && typeof s.cookware === 'object') for (const [k, v] of Object.entries(s.cookware)) if (k in cw && typeof v === 'boolean') cw[k] = v;
  return {
    burners: Number.isInteger(s.burners) && (s.burners as number) >= 1 && (s.burners as number) <= 8 ? (s.burners as number) : d.burners,
    cookware: cw,
    helperCarvesTurkey: bool('helperCarvesTurkey'),
    hotRoom: bool('hotRoom'),
    sound: bool('sound'),
    vibration: bool('vibration'),
    wakeLock: bool('wakeLock'),
  };
}

export function sanitizeFlags(x: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (typeof v === 'boolean') out[k] = v;
  return out;
}
