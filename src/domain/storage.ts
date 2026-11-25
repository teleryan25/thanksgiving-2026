/**
 * Versioned, validated local persistence. Live and simulation state use separate keys.
 * Each section is validated independently so one corrupt section never wipes progress elsewhere.
 * Unparseable data is backed up under a `tcc:corrupt:*` key before starting fresh.
 */
import { TASKS } from './recipes';
import { eventAt } from './time';
import { isTimer } from './timers';
import { STATE_VERSION, initialState, isEvent, sanitizeFlags, sanitizeSettings, type CookEvent, type CookState } from './state';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class MemoryKV implements KV {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  keys() {
    return [...this.map.keys()];
  }
}

export const KEYS = {
  live: 'tcc:state:live',
  sim: 'tcc:state:sim',
  /** Pre-release v1 key (different shape) — migrated on first load. */
  legacyV1: 'tcc:v1',
  mode: 'tcc:mode',
} as const;

export interface LoadResult {
  state: CookState;
  notices: string[];
  source: 'fresh' | 'stored' | 'migrated' | 'recovered';
}

function backup(kv: KV, raw: string, now: number): string {
  const key = `tcc:corrupt:${now}`;
  try {
    kv.setItem(key, raw);
  } catch {
    /* storage full — nothing more we can do */
  }
  return key;
}

/** v1 (pre-release) shape: per-task progress map and target as "HH:MM". */
interface V1 {
  version: 1;
  progress?: Record<string, { startedAt?: number; completedAt?: number; skipped?: boolean }>;
  target?: string;
  shopping?: Record<string, boolean>;
  timers?: unknown[];
}

export function migrateV1(v1: V1, now: number): { state: CookState; notices: string[] } {
  const notices: string[] = ['Migrated saved data from version 1.'];
  const st = initialState('live', now);
  const events: CookEvent[] = [];
  let n = 0;
  const id = () => `ev-live-m${++n}`;
  for (const [taskId, p] of Object.entries(v1.progress ?? {})) {
    if (!TASKS.some((t) => t.id === taskId)) {
      notices.push(`Dropped unknown task "${taskId}" from old data.`);
      continue;
    }
    if (p.skipped) events.push({ type: 'skip', id: id(), at: p.completedAt ?? p.startedAt ?? now, taskId, unsafeConfirmed: true, reason: 'migrated' });
    else {
      if (p.startedAt != null) events.push({ type: 'start', id: id(), at: p.startedAt, taskId });
      if (p.completedAt != null) events.push({ type: 'complete', id: id(), at: p.completedAt, taskId, safetyConfirmed: true, earlyConfirmed: true });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const m = /^(\d{1,2}):(\d{2})$/.exec(v1.target ?? '');
  if (m) events.push({ type: 'setTarget', id: id(), at: now, ms: eventAt(Number(m[1]), Number(m[2])) });
  return {
    state: { ...st, seq: n, events, shopping: sanitizeFlags(v1.shopping), timers: (v1.timers ?? []).filter(isTimer) },
    notices,
  };
}

/** Validate a parsed v2 document section by section. */
export function sanitizeState(doc: Record<string, unknown>, namespace: 'live' | 'sim', now: number): { state: CookState; notices: string[] } {
  const notices: string[] = [];
  const base = initialState(namespace, now);
  const rawEvents = Array.isArray(doc.events) ? doc.events : [];
  if (!Array.isArray(doc.events) && doc.events !== undefined) notices.push('Saved cooking log was unreadable and was reset.');
  const events = rawEvents.filter(isEvent);
  if (events.length < rawEvents.length) notices.push(`Ignored ${rawEvents.length - events.length} damaged log entr${rawEvents.length - events.length === 1 ? 'y' : 'ies'}; the rest of your progress was kept.`);
  const rawTimers = Array.isArray(doc.timers) ? doc.timers : [];
  const timers = rawTimers.filter(isTimer);
  if (timers.length < rawTimers.length) notices.push(`Ignored ${rawTimers.length - timers.length} damaged timer(s).`);
  const undone = Array.isArray(doc.undone) ? (doc.undone as unknown[]).filter((u): u is CookState['undone'][number] => !!u && typeof u === 'object' && isEvent((u as { event: unknown }).event)) : [];
  const state: CookState = {
    ...base,
    createdAt: typeof doc.createdAt === 'number' ? doc.createdAt : now,
    seq: Number.isInteger(doc.seq) ? (doc.seq as number) : events.length + timers.length + 100,
    events,
    undone,
    timers,
    shopping: sanitizeFlags(doc.shopping),
    recipeChecks: sanitizeFlags(doc.recipeChecks),
    settings: sanitizeSettings(doc.settings),
  };
  if (namespace === 'sim') state.simNow = typeof doc.simNow === 'number' ? doc.simNow : base.simNow!;
  // Ensure ids stay unique after recovery.
  const maxSeq = Math.max(0, ...[...events.map((e) => e.id), ...timers.map((t) => t.id)].map((s) => Number(/(\d+)$/.exec(s)?.[1] ?? 0)));
  if (state.seq < maxSeq) state.seq = maxSeq;
  return { state, notices };
}

export function loadState(kv: KV, namespace: 'live' | 'sim', now: number): LoadResult {
  const key = KEYS[namespace];
  const raw = kv.getItem(key);
  if (raw == null) {
    if (namespace === 'live') {
      const legacy = kv.getItem(KEYS.legacyV1);
      if (legacy != null) {
        try {
          const v1 = JSON.parse(legacy) as V1;
          if (v1?.version === 1) {
            const { state, notices } = migrateV1(v1, now);
            saveState(kv, state, now);
            kv.removeItem(KEYS.legacyV1);
            return { state, notices, source: 'migrated' };
          }
        } catch {
          const b = backup(kv, legacy, now);
          kv.removeItem(KEYS.legacyV1);
          return { state: initialState(namespace, now), notices: [`Old saved data was unreadable; a copy was kept as ${b}.`], source: 'recovered' };
        }
      }
    }
    return { state: initialState(namespace, now), notices: [], source: 'fresh' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const b = backup(kv, raw, now);
    return { state: initialState(namespace, now), notices: [`Saved data was corrupted and could not be read. A copy was kept as ${b}. Starting fresh.`], source: 'recovered' };
  }
  if (!parsed || typeof parsed !== 'object') {
    const b = backup(kv, raw, now);
    return { state: initialState(namespace, now), notices: [`Saved data had an unexpected shape. A copy was kept as ${b}.`], source: 'recovered' };
  }
  const env = parsed as { version?: unknown; state?: unknown };
  if (env.version === 1) {
    const { state, notices } = migrateV1(env as unknown as V1, now);
    return { state, notices, source: 'migrated' };
  }
  if (env.version !== STATE_VERSION || !env.state || typeof env.state !== 'object') {
    const b = backup(kv, raw, now);
    return { state: initialState(namespace, now), notices: [`Saved data is from an unknown version (${String(env.version)}). A copy was kept as ${b}.`], source: 'recovered' };
  }
  const { state, notices } = sanitizeState(env.state as Record<string, unknown>, namespace, now);
  return { state, notices, source: notices.length ? 'recovered' : 'stored' };
}

export function saveState(kv: KV, state: CookState, now: number): boolean {
  try {
    kv.setItem(KEYS[state.namespace], JSON.stringify({ version: STATE_VERSION, savedAt: now, state }));
    return true;
  } catch {
    return false;
  }
}

export function clearState(kv: KV, namespace: 'live' | 'sim'): void {
  kv.removeItem(KEYS[namespace]);
}
