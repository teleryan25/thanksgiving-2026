import type { DiagReport } from '../domain/diagnostics';
import { runDiagnostics } from '../domain/diagnostics';
import { DISHES, TASKS } from '../domain/recipes';
import { plan as planSync, type Plan, type PlanInput } from '../domain/scheduler';

/** One background worker for heavy computation, with a main-thread fallback. */
let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (v: { plan?: Plan; report?: DiagReport; error?: string }) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./planWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; plan?: Plan; report?: DiagReport; error?: string }>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
    worker.onerror = () => {
      worker = null;
      for (const [, cb] of waiting) cb({ error: 'worker failed' });
      waiting.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

function ask<T>(msg: Record<string, unknown>, fallback: () => T, pick: (v: { plan?: Plan; report?: DiagReport }) => T | undefined, timeoutMs: number): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.resolve(fallback());
  const id = ++seq;
  return new Promise<T>((resolve) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      resolve(fallback());
    }, timeoutMs);
    waiting.set(id, (v) => {
      window.clearTimeout(timer);
      const r = pick(v);
      resolve(r === undefined ? fallback() : r);
    });
    w.postMessage({ id, ...msg });
  });
}

export function planAsync(input: PlanInput): Promise<Plan> {
  const { tasks: _t, dishes: _d, ...rest } = input;
  return ask({ kind: 'plan', input: rest }, () => planSync({ ...input, tasks: TASKS, dishes: DISHES }), (v) => v.plan, 8000);
}

export function diagAsync(full: boolean, version: string): Promise<DiagReport> {
  return ask({ kind: 'diag', full, version }, () => runDiagnostics({ full, version }), (v) => v.report, full ? 180_000 : 30_000);
}
