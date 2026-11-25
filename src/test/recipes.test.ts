import { describe, expect, it } from 'vitest';
import { DISHES, INGREDIENTS, TASKS } from '../domain/recipes';
import {
  auditAgainstExpected,
  consumption,
  ingredientTotals,
  placeholderIssues,
  prepConsistency,
  reconcileDishes,
  renderStep,
  shoppingList,
  unitIssues,
} from '../domain/audit';
import { findCycle, validateGraph, validateTasks } from '../domain/validate';
import type { TaskDef } from '../domain/model';

const EIGHT = ['mash', 'stuffing', 'greenbeans', 'corn', 'sweetpotato', 'mac', 'compote', 'gravy'] as const;

describe('recipe schema', () => {
  it('validates the canonical task graph with no errors', () => {
    expect(validateTasks()).toEqual([]);
  });
  it('has all eight dishes, each with instructions, cues and a final task', () => {
    for (const id of EIGHT) {
      const d = DISHES.find((x) => x.id === id);
      expect(d, id).toBeDefined();
      const tasks = TASKS.filter((t) => t.dish === id);
      expect(tasks.length, id).toBeGreaterThan(0);
      expect(tasks.filter((t) => t.final).length, id).toBe(1);
      for (const t of tasks) {
        expect(t.steps.length, t.id).toBeGreaterThan(0);
        expect(t.equipment, t.id).toBeDefined();
        expect(t.duration.min, t.id).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('every quantified usage is shown in its step text and no placeholder dangles', () => {
    expect(placeholderIssues()).toEqual([]);
  });
  it('renders exact quantities into instructions', () => {
    const t = TASKS.find((x) => x.id === 'mash-brown-butter')!;
    expect(renderStep(t.steps[0]!)).toContain('14 tbsp unsalted butter');
    const s = TASKS.find((x) => x.id === 'sp-streusel')!;
    expect(renderStep(s.steps[0]!)).toContain('1/3 cup packed brown sugar with 2 tbsp + 2 tsp flour');
    const st = TASKS.find((x) => x.id === 'stuffing-assemble')!;
    expect(renderStep(st.steps[1]!)).toContain('up to 1/2 cup more stock');
  });
  it('uses only allowed and compatible units, drained items stay drained', () => {
    expect(unitIssues()).toEqual([]);
    for (const id of ['green-beans', 'corn']) expect(INGREDIENTS.find((i) => i.id === id)!.form).toBe('drained');
  });
});

describe('quantity reconciliation', () => {
  it('each dish card equals the sum of its task consumption (divided allocations)', () => {
    expect(reconcileDishes()).toEqual([]);
  });
  it('prep mentions match consumed amounts (no duplicate accounting)', () => {
    expect(prepConsistency()).toEqual([]);
    // Prep mentions are excluded from totals: onion appears twice in steps but totals 6 oz.
    expect(ingredientTotals().get('onion')!.required.weight).toBe(6);
  });
  it('matches every audit figure from the build spec', () => {
    const checks = auditAgainstExpected();
    for (const c of checks) expect(c.pass, `${c.name}: expected ${c.expected} got ${c.actual}`).toBe(true);
  });
  it('butter is 29.5 tbsp + 4 tsp grease = 30 tbsp + 2 1/2 tsp', () => {
    const b = ingredientTotals().get('butter')!;
    expect(b.required.volume).toBe(92.5);
    const grease = consumption().filter((u) => u.ing === 'butter' && u.purpose === 'grease dish');
    expect(grease.length).toBe(4);
  });
  it('optional quantities stay out of required totals', () => {
    const stock = ingredientTotals().get('chicken-stock')!;
    expect(stock.required.volume).toBe(2.75 * 48);
    expect(stock.optional.length).toBe(1);
    const sugar = ingredientTotals().get('sugar')!;
    expect(sugar.required.volume).toBe(12); // 1/4 cup; compote sugar optional
  });
  it('a reconciliation error is detected when a step quantity drifts', () => {
    const mutated: TaskDef[] = JSON.parse(JSON.stringify(TASKS));
    const t = mutated.find((x) => x.id === 'corn-cook')!;
    t.steps[1]!.uses![0]!.qty!.amount = 3;
    expect(reconcileDishes(DISHES, mutated).some((e) => e.includes('corn'))).toBe(true);
  });
});

describe('shopping list', () => {
  const list = shoppingList();
  const all = list.groups.flatMap((g) => g.items);
  it('groups by category with dish references', () => {
    expect(list.groups.length).toBeGreaterThan(4);
    const butter = all.find((i) => i.key === 'butter')!;
    expect(butter.amount).toBe('30 tbsp + 2 1/2 tsp');
    expect(butter.dishes.sort()).toEqual(['corn', 'greenbeans', 'mac', 'mash', 'stuffing', 'sweetpotato']);
  });
  it('merges orange juice and zest into one line, excludes Devin items', () => {
    expect(all.filter((i) => i.key === 'oranges').length).toBe(1);
    expect(all.some((i) => i.key === 'turkey')).toBe(false);
    expect(list.brought.map((b) => b.key).sort()).toEqual(['parm-bread', 'turkey']);
  });
  it('shows drained weights and up-to amounts honestly', () => {
    expect(all.find((i) => i.key === 'green-beans')!.amount).toBe('16 oz drained');
    expect(all.find((i) => i.key === 'chicken-stock')!.amount).toContain('up to 1/2 cup');
  });
});

describe('dependency validation', () => {
  it('detects missing dependencies', () => {
    const bad: TaskDef[] = JSON.parse(JSON.stringify(TASKS));
    bad[5]!.deps.push({ id: 'nope' });
    expect(validateGraph(bad).some((e) => e.includes('missing dependency nope'))).toBe(true);
  });
  it('detects cycles', () => {
    const bad: TaskDef[] = JSON.parse(JSON.stringify(TASKS));
    bad.find((t) => t.id === 'stuffing-cube-rolls')!.deps.push({ id: 'stuffing-bake' });
    expect(validateGraph(bad).some((e) => e.startsWith('dependency cycle'))).toBe(true);
    expect(findCycle(['a', 'b'], (x) => (x === 'a' ? ['b'] : ['a']))).toEqual(['a', 'b', 'a']);
  });
  it('requires oven phase ordering', () => {
    const bad: TaskDef[] = JSON.parse(JSON.stringify(TASKS));
    bad.find((t) => t.id === 'oven-to-350')!.deps = [];
    const errs = validateTasks(bad);
    expect(errs.some((e) => e.includes('oven-to-350'))).toBe(true);
  });
});

describe('food safety data', () => {
  it('requires sausage 160, sweet potato 160, stuffing 165, turkey 165', () => {
    const s = (id: string) => TASKS.find((t) => t.id === id)!.safety!.tempF;
    expect(s('stuffing-cook-sausage')).toBe(160);
    expect(s('sp-bake')).toBe(160);
    expect(s('stuffing-bake')).toBe(165);
    expect(s('turkey-check')).toBe(165);
  });
  it('tastes stuffing for salt before raw eggs are added', () => {
    const order = TASKS.map((t) => t.id);
    expect(order.indexOf('stuffing-season')).toBeLessThan(order.indexOf('stuffing-egg-mix'));
    const egg = TASKS.find((t) => t.id === 'stuffing-egg-mix')!;
    expect(egg.deps.map((d) => d.id)).toContain('stuffing-season');
  });
});
