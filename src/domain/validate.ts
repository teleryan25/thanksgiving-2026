import type { Dish, TaskDef } from './model';
import { COOKWARE, DISHES, OVEN_PHASES, TASKS } from './recipes';
import { placeholderIssues, prepConsistency, reconcileDishes, unitIssues } from './audit';

/** Returns a cycle (list of ids) if one exists, else null. */
export function findCycle(ids: string[], edges: (id: string) => string[]): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const n of edges(id)) {
      const s = state.get(n) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (s === 0) {
        const c = visit(n);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

export function ancestors(tasks: TaskDef[], id: string): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Set<string>();
  const walk = (x: string) => {
    for (const d of byId.get(x)?.deps ?? []) if (!out.has(d.id)) {
      out.add(d.id);
      walk(d.id);
    }
  };
  walk(id);
  return out;
}

export function validateGraph(tasks: TaskDef[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) for (const d of t.deps) if (!ids.has(d.id)) errors.push(`${t.id}: missing dependency ${d.id}`);
  if (errors.length) return errors;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cycle = findCycle([...ids], (id) => byId.get(id)!.deps.map((d) => d.id));
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' → ')}`);
  return errors;
}

export function validateTasks(tasks: TaskDef[] = TASKS, dishes: Dish[] = DISHES): string[] {
  const errors = validateGraph(tasks);
  if (errors.length) return errors;
  const cookIds = new Set(COOKWARE.map((c) => c.id));
  for (const t of tasks) {
    const d = t.duration;
    if (!(d.min <= d.nominal && d.nominal <= d.max)) errors.push(`${t.id}: duration must satisfy min ≤ nominal ≤ max`);
    if ((t.lead ?? 0) + (t.tail ?? 0) > d.min && t.attention !== 'active') errors.push(`${t.id}: lead+tail exceed min duration`);
    for (const c of t.checkpoints ?? []) if (c.at + c.dur > d.min) errors.push(`${t.id}: checkpoint ${c.id} falls after minimum duration`);
    if (t.checkpoints?.length && t.attention !== 'periodic') errors.push(`${t.id}: checkpoints require periodic attention`);
    for (const c of t.cookware ?? []) for (const id of Array.isArray(c) ? c : [c]) if (!cookIds.has(id)) errors.push(`${t.id}: unknown cookware ${id}`);
    if (t.cookware?.length && t.kind === 'stove' && !t.burners) errors.push(`${t.id}: stove task without burner`);
    if (t.steps.length === 0) errors.push(`${t.id}: no instructions`);
    if (!dishes.some((x) => x.id === t.dish) && t.dish !== 'kitchen') errors.push(`${t.id}: unknown dish ${t.dish}`);
    if (t.kind === 'oven' && !t.oven) errors.push(`${t.id}: oven task without oven requirement`);
    if (t.follows && !t.deps.some((d) => d.id === t.follows && !d.soft)) errors.push(`${t.id}: follows ${t.follows} but does not depend on it`);
    if (t.follows && tasks.filter((x) => x.follows === t.follows).length > 1) errors.push(`${t.follows}: more than one no-wait follower`);
  }
  // Oven: each oven task depends (transitively) on the transition to its temperature,
  // and each transition depends on every task of the previous phase finishing.
  const transitions = new Map<number, TaskDef>();
  for (const t of tasks) if (t.ovenTransitionTo != null) transitions.set(t.ovenTransitionTo, t);
  for (const temp of OVEN_PHASES) if (!transitions.has(temp)) errors.push(`missing oven transition to ${temp}°F`);
  for (const t of tasks) {
    if (!t.oven || t.ovenTransitionTo != null) continue;
    const tr = transitions.get(t.oven.tempF);
    if (!tr) errors.push(`${t.id}: no oven phase at ${t.oven.tempF}°F`);
    else if (!ancestors(tasks, t.id).has(tr.id)) errors.push(`${t.id}: must depend on ${tr.id}`);
  }
  for (let i = 1; i < OVEN_PHASES.length; i++) {
    const tr = transitions.get(OVEN_PHASES[i]!);
    const prevTr = transitions.get(OVEN_PHASES[i - 1]!);
    if (!tr || !prevTr) continue;
    const anc = ancestors(tasks, tr.id);
    if (!anc.has(prevTr.id)) errors.push(`${tr.id}: must follow ${prevTr.id}`);
    for (const t of tasks) if (t.oven?.tempF === OVEN_PHASES[i - 1] && t.ovenTransitionTo == null && !anc.has(t.id)) errors.push(`${tr.id}: must wait for ${t.id} (oven phase ${OVEN_PHASES[i - 1]}°F)`);
  }
  // Dishes: exactly one final task each.
  for (const dish of dishes) {
    const finals = tasks.filter((t) => t.dish === dish.id && t.final);
    if (finals.length !== 1) errors.push(`${dish.id}: expected exactly 1 final task, found ${finals.length}`);
    if (dish.exposure) {
      for (const f of dish.exposure.from) if (!tasks.some((t) => t.id === f)) errors.push(`${dish.id}: exposure.from ${f} missing`);
      if (dish.exposure.until && !tasks.some((t) => t.id === dish.exposure!.until)) errors.push(`${dish.id}: exposure.until missing`);
    }
  }
  // Required food-safety checks.
  const need: [string, number][] = [
    ['stuffing-cook-sausage', 160],
    ['sp-bake', 160],
    ['stuffing-bake', 165],
    ['turkey-check', 165],
  ];
  for (const [id, temp] of need) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.safety?.tempF !== temp) errors.push(`${id}: must require ${temp}°F safety confirmation`);
  }
  return errors;
}

export function validateAll(): { errors: string[] } {
  return {
    errors: [...validateTasks(), ...reconcileDishes(), ...prepConsistency(), ...unitIssues(), ...placeholderIssues()],
  };
}
