import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Plan, PlanInput } from '../domain/scheduler';
import { planAsync } from './workerClient';
import { ActionError, initialState, planInputFrom, reduce, type Action, type CookState } from '../domain/state';
import { KEYS, loadState, saveState, type KV } from '../domain/storage';
import { MINUTE } from '../domain/time';

export type Mode = 'live' | 'sim';

export function safeStorage(): KV {
  try {
    const k = '__tcc_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  }
}

export function readMode(kv: KV): Mode {
  return kv.getItem(KEYS.mode) === 'sim' ? 'sim' : 'live';
}

/** Re-render every `ms` (and immediately when the page becomes visible again). */
export function useTicker(ms = 1000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), ms);
    const vis = () => document.visibilityState === 'visible' && setTick(Date.now());
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('focus', vis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('focus', vis);
    };
  }, [ms]);
  return tick;
}

export interface Store {
  mode: Mode;
  state: CookState;
  now: number;
  dispatch: (a: Action) => { ok: boolean; message?: string };
  notices: string[];
  dismissNotice: (i: number) => void;
  saveOk: boolean;
}

/** Loads/saves the namespace's state and injects the right clock (real or simulated). */
export function useCookStore(kv: KV, mode: Mode): Store {
  const realNow = useTicker(1000);
  const [{ state, notices }, setBundle] = useState(() => {
    const r = loadState(kv, mode, Date.now());
    return { state: r.state, notices: r.notices };
  });
  const [saveOk, setSaveOk] = useState(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const r = loadState(kv, mode, Date.now());
    setBundle({ state: r.state, notices: r.notices });
  }, [kv, mode]);

  // Persist on every change.
  useEffect(() => {
    if (state.namespace !== mode) return;
    setSaveOk(saveState(kv, state, Date.now()));
  }, [kv, state, mode]);

  // Pick up changes from another tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEYS[mode]) {
        const r = loadState(kv, mode, Date.now());
        setBundle((b) => ({ state: r.state, notices: b.notices }));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [kv, mode]);

  const now = mode === 'sim' ? (state.simNow ?? realNow) : realNow;

  const dispatch = useCallback(
    (a: Action) => {
      const cur = stateRef.current;
      const t = mode === 'sim' ? (cur.simNow ?? Date.now()) : Date.now();
      try {
        const r = reduce(cur, a, t);
        stateRef.current = r.state;
        setBundle((b) => ({ ...b, state: r.state }));
        return { ok: true, ...(r.message ? { message: r.message } : {}) };
      } catch (err) {
        if (err instanceof ActionError) return { ok: false, message: err.message };
        throw err;
      }
    },
    [mode],
  );

  return {
    mode,
    state: state.namespace === mode ? state : initialState(mode, Date.now()),
    now,
    dispatch,
    notices,
    dismissNotice: (i) => setBundle((b) => ({ ...b, notices: b.notices.filter((_, j) => j !== i) })),
    saveOk,
  };
}

/** Plan in a Web Worker so the UI never janks; recomputes on state change and each minute. */
export function usePlan(state: CookState, now: number): { plan: Plan | null; input: PlanInput; computing: boolean } {
  const minute = Math.floor(now / MINUTE);
  const [result, setResult] = useState<{ plan: Plan; key: PlanInput } | null>(null);
  const prevRef = useRef<Plan | null>(null);
  const input = useMemo(() => {
    const base = planInputFrom(state, now);
    // Stability hint: the previous plan's start times for tasks still scheduled.
    const prev = prevRef.current;
    if (!prev || prev.tasks === undefined) return base;
    const hint: Record<string, number> = {};
    for (const [id, x] of Object.entries(prev.tasks)) if (x.status === 'scheduled' && x.startMs != null) hint[id] = x.startMs;
    return { ...base, hint };
  }, [state, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    void planAsync(input).then((p) => {
      if (!live) return;
      prevRef.current = p;
      setResult({ plan: p, key: input });
    });
    return () => {
      live = false;
    };
  }, [input]);
  return { plan: result?.plan ?? null, input, computing: result?.key !== input };
}
