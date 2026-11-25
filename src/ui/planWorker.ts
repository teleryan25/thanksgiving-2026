/// <reference lib="webworker" />
import { plan, type PlanInput } from '../domain/scheduler';
import { DISHES, TASKS } from '../domain/recipes';

type Msg = { id: number; input: Omit<PlanInput, 'tasks' | 'dishes'> };

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id, input } = e.data;
  try {
    const p = plan({ ...input, tasks: TASKS, dishes: DISHES });
    (self as unknown as Worker).postMessage({ id, plan: p });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
