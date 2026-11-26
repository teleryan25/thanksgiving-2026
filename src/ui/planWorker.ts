/// <reference lib="webworker" />
import { plan, type PlanInput } from '../domain/scheduler';
import { DISHES, TASKS } from '../domain/recipes';
import { runDiagnostics } from '../domain/diagnostics';

type Msg = { id: number; kind?: 'plan'; input: Omit<PlanInput, 'tasks' | 'dishes'> } | { id: number; kind: 'diag'; full: boolean; version: string };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.kind === 'diag') {
      (self as unknown as Worker).postMessage({ id: m.id, report: runDiagnostics({ full: m.full, version: m.version }) });
      return;
    }
    const p = plan({ ...m.input, tasks: TASKS, dishes: DISHES });
    (self as unknown as Worker).postMessage({ id: m.id, plan: p });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, error: String(err) });
  }
};
