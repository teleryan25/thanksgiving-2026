import type { Dish, DishId, Ingredient, ShopCategory, Step, TaskDef, Usage } from './model';
import { DISHES, INGREDIENTS, SHOP_GROUPS, TASKS } from './recipes';
import { addTo, dimensionOf, fmtQty, fmtTotals, toBase, type QtyTotals } from './units';

/** Render a step's text with exact quantities substituted for `{n}` placeholders. */
export function renderStep(step: Step): string {
  return step.text.replace(/\{(\d+)\}/g, (_, n: string) => {
    const use = step.uses?.[Number(n)];
    if (!use?.qty) return `{${n}?}`;
    return fmtQty(use.qty);
  });
}

export interface LocatedUsage extends Usage {
  dish: DishId;
  taskId: string;
}

export function allUsages(tasks: TaskDef[] = TASKS): LocatedUsage[] {
  const out: LocatedUsage[] = [];
  for (const t of tasks) for (const s of t.steps) for (const use of s.uses ?? []) out.push({ ...use, dish: t.dish, taskId: t.id });
  return out;
}

/** Usages that actually consume food (not prep re-mentions). Each food is counted exactly once. */
export function consumption(tasks: TaskDef[] = TASKS): LocatedUsage[] {
  return allUsages(tasks).filter((x) => !x.prep);
}

const keyOf = (u: Usage) => `${u.ing}|${u.purpose}|${u.optional ? 'opt' : ''}|${u.upTo ? 'upto' : ''}|${u.toTaste ? 'taste' : ''}`;

function sumByKey(us: Usage[]): Map<string, QtyTotals> {
  const m = new Map<string, QtyTotals>();
  for (const x of us) {
    const k = keyOf(x);
    const t = m.get(k) ?? {};
    if (x.qty) addTo(t, x.qty);
    m.set(k, t);
  }
  return m;
}

const sameTotals = (a: QtyTotals, b: QtyTotals) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k as keyof QtyTotals] ?? 0) - (b[k as keyof QtyTotals] ?? 0)) > 1e-6) return false;
  return true;
};

/** Each dish's declared ingredient lines must equal the sum of its task step consumption, per ingredient and purpose. */
export function reconcileDishes(dishes: Dish[] = DISHES, tasks: TaskDef[] = TASKS): string[] {
  const issues: string[] = [];
  const cons = consumption(tasks);
  for (const d of dishes) {
    const declared = sumByKey(d.lines.flatMap((l) => l.parts.map((p) => ({ ...p, ing: l.ing }))));
    for (const l of d.lines) for (const p of l.parts) if (p.ing !== l.ing) issues.push(`${d.id}: line ${l.ing} contains part for ${p.ing}`);
    const used = sumByKey(cons.filter((c) => c.dish === d.id));
    // Bring-along items (turkey, bread) have no consuming step by design.
    const brought = new Set(d.lines.filter((l) => INGREDIENTS.find((i) => i.id === l.ing)?.broughtBy).map((l) => l.ing));
    for (const [k, v] of declared) {
      if (brought.has(k.split('|')[0]!)) continue;
      const got = used.get(k);
      if (!got) issues.push(`${d.id}: declared ${k} is never used in a task step`);
      else if (!sameTotals(v, got)) issues.push(`${d.id}: ${k} declared ${fmtTotals(v)} but steps use ${fmtTotals(got)}`);
    }
    for (const [k, v] of used) if (!declared.has(k)) issues.push(`${d.id}: steps use ${k} (${fmtTotals(v)}) not declared on the recipe card`);
  }
  return issues;
}

/** Prep mentions (e.g. "dice 6 oz onion") must match the amount later consumed in that dish. */
export function prepConsistency(tasks: TaskDef[] = TASKS): string[] {
  const issues: string[] = [];
  const all = allUsages(tasks);
  const groups = new Map<string, { prep: QtyTotals; used: QtyTotals; hasPrep: boolean }>();
  for (const x of all) {
    if (!x.qty || x.optional) continue;
    const k = `${x.dish}|${x.ing}`;
    const g = groups.get(k) ?? { prep: {}, used: {}, hasPrep: false };
    if (x.prep) {
      addTo(g.prep, x.qty);
      g.hasPrep = true;
    } else addTo(g.used, x.qty);
    groups.set(k, g);
  }
  for (const [k, g] of groups) if (g.hasPrep && !sameTotals(g.prep, g.used)) issues.push(`${k}: prep says ${fmtTotals(g.prep)} but recipe consumes ${fmtTotals(g.used)}`);
  return issues;
}

export interface IngredientTotal {
  ing: Ingredient;
  required: QtyTotals;
  /** Of which "up to" amounts (max) — included in required. */
  upTo: QtyTotals;
  optional: { qty?: string; purpose: string; dish: DishId }[];
  toTaste: boolean;
  dishes: DishId[];
}

export function ingredientTotals(tasks: TaskDef[] = TASKS): Map<string, IngredientTotal> {
  const m = new Map<string, IngredientTotal>();
  for (const ing of INGREDIENTS) m.set(ing.id, { ing, required: {}, upTo: {}, optional: [], toTaste: false, dishes: [] });
  for (const x of consumption(tasks)) {
    const t = m.get(x.ing);
    if (!t) continue;
    if (!t.dishes.includes(x.dish)) t.dishes.push(x.dish);
    if (x.toTaste) t.toTaste = true;
    if (!x.qty) continue;
    if (x.optional) t.optional.push({ qty: fmtQty(x.qty), purpose: x.purpose, dish: x.dish });
    else {
      addTo(t.required, x.qty);
      if (x.upTo) addTo(t.upTo, x.qty);
    }
  }
  // Brought items: attribute dishes from lines.
  for (const d of DISHES) for (const l of d.lines) {
    const t = m.get(l.ing);
    if (t && t.ing.broughtBy && !t.dishes.includes(d.id)) {
      t.dishes.push(d.id);
      for (const p of l.parts) if (p.qty) addTo(t.required, p.qty);
    }
  }
  return m;
}

/** Totals the build spec requires (base units: tsp, oz, counts). */
export const EXPECTED_AUDIT = {
  butterTsp: 29.5 * 3 + 4, // 30 tbsp + 2.5 tsp
  flourTsp: 6 * 3 + 2,
  stockMaxTsp: 2.75 * 48,
  eggs: 4,
  garlic: { head: 1, clove: 3 },
  parsleyTsp: 3 * 3,
  greenBeansOz: 16,
  cornOz: 16,
  crispyOnionsTsp: 1.5 * 48,
} as const;

export interface AuditCheck {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export function auditAgainstExpected(tasks: TaskDef[] = TASKS): AuditCheck[] {
  const t = ingredientTotals(tasks);
  const vol = (id: string) => t.get(id)?.required.volume ?? 0;
  const checks: AuditCheck[] = [];
  const add = (name: string, expected: number, actual: number, fmt: (n: number) => string) =>
    checks.push({ name, expected: fmt(expected), actual: fmt(actual), pass: Math.abs(expected - actual) < 1e-6 });
  const v = (n: number) => fmtTotals({ volume: n });
  add('Butter (incl. 4 tsp greasing)', EXPECTED_AUDIT.butterTsp, vol('butter'), v);
  add('Flour', EXPECTED_AUDIT.flourTsp, vol('flour'), v);
  add('Chicken stock (max, excl. optional gravy)', EXPECTED_AUDIT.stockMaxTsp, vol('chicken-stock'), v);
  add('Eggs', EXPECTED_AUDIT.eggs, t.get('eggs')?.required['count:each'] ?? 0, String);
  add('Garlic heads', EXPECTED_AUDIT.garlic.head, t.get('garlic')?.required['count:head'] ?? 0, String);
  add('Garlic cloves', EXPECTED_AUDIT.garlic.clove, t.get('garlic')?.required['count:clove'] ?? 0, String);
  add('Parsley', EXPECTED_AUDIT.parsleyTsp, vol('parsley'), v);
  add('Green beans (drained oz)', EXPECTED_AUDIT.greenBeansOz, t.get('green-beans')?.required.weight ?? 0, String);
  add('Corn (drained oz)', EXPECTED_AUDIT.cornOz, t.get('corn')?.required.weight ?? 0, String);
  add('Crispy onions', EXPECTED_AUDIT.crispyOnionsTsp, vol('crispy-onions'), v);
  const eggInv = INGREDIENTS.find((i) => i.id === 'eggs')?.inventory;
  const eggNeed = t.get('eggs')?.required['count:each'] ?? 0;
  checks.push({ name: 'Eggs within inventory', expected: `≤ ${eggInv ? toBase(eggInv) : 0}`, actual: String(eggNeed), pass: !!eggInv && eggNeed <= toBase(eggInv) });
  // Optional gravy stock is listed separately, never added to the required total.
  const gravyOpt = t.get('chicken-stock')?.optional.some((o) => o.dish === 'gravy') ?? false;
  checks.push({ name: 'Gravy stock kept optional', expected: 'optional', actual: gravyOpt ? 'optional' : 'missing', pass: gravyOpt });
  return checks;
}

/** Unit/form checks: every usage unit allowed for its ingredient; drained items never mixed with raw. */
export function unitIssues(tasks: TaskDef[] = TASKS, dishes: Dish[] = DISHES): string[] {
  const issues: string[] = [];
  const check = (x: Usage, where: string) => {
    const ing = INGREDIENTS.find((i) => i.id === x.ing);
    if (!ing) return issues.push(`${where}: unknown ingredient ${x.ing}`);
    if (x.qty && !ing.units.includes(x.qty.unit)) issues.push(`${where}: ${x.ing} measured in ${x.qty.unit}, allowed ${ing.units.join('/')}`);
    if (x.qty) {
      const dims = new Set(ing.units.map(dimensionOf));
      if (!dims.has(dimensionOf(x.qty.unit))) issues.push(`${where}: ${x.ing} incompatible unit`);
    }
    return undefined;
  };
  for (const t of tasks) for (const s of t.steps) for (const x of s.uses ?? []) check(x, t.id);
  for (const d of dishes) for (const l of d.lines) for (const p of l.parts) check(p, `${d.id} card`);
  return issues;
}

/** Placeholder ↔ usage cross-check: every quantified usage appears in its step text; no dangling placeholders. */
export function placeholderIssues(tasks: TaskDef[] = TASKS): string[] {
  const issues: string[] = [];
  for (const t of tasks)
    t.steps.forEach((s, i) => {
      const refs = new Set([...s.text.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])));
      for (const r of refs) if (!s.uses?.[r]?.qty) issues.push(`${t.id} step ${i + 1}: {${r}} has no quantified usage`);
      (s.uses ?? []).forEach((x, j) => {
        if (x.qty && !refs.has(j)) issues.push(`${t.id} step ${i + 1}: ${x.ing} quantity not shown in text`);
      });
      if ((s.hint ?? '').match(/\{\d+\}/)) issues.push(`${t.id} step ${i + 1}: placeholder in hint`);
    });
  return issues;
}

// ───────────────────────────── Shopping ─────────────────────────────
export interface ShoppingItem {
  key: string;
  name: string;
  category: ShopCategory;
  amount: string;
  optional: string[];
  toTaste: boolean;
  dishes: DishId[];
  note?: string;
}

export const CATEGORY_ORDER: ShopCategory[] = ['Produce', 'Meat', 'Dairy & Eggs', 'Bakery', 'Canned & Jarred', 'Frozen', 'Baking & Pantry', 'Spices & Seasonings'];

export function shoppingList(tasks: TaskDef[] = TASKS): { groups: { category: ShopCategory; items: ShoppingItem[] }[]; brought: ShoppingItem[] } {
  const totals = ingredientTotals(tasks);
  const items = new Map<string, ShoppingItem>();
  const brought: ShoppingItem[] = [];
  for (const t of totals.values()) {
    const amount = fmtTotals(t.required);
    const base: ShoppingItem = {
      key: t.ing.id,
      name: t.ing.name,
      category: t.ing.category,
      amount: [t.ing.form === 'drained' ? `${amount} drained` : amount, Object.keys(t.upTo).length ? `(includes up to ${fmtTotals(t.upTo)})` : ''].filter(Boolean).join(' '),
      optional: t.optional.map((o) => `${o.qty} optional — ${o.purpose} (${o.dish})`),
      toTaste: t.toTaste,
      dishes: t.dishes,
      note: t.ing.shopNote,
    };
    if (t.ing.broughtBy) {
      brought.push({ ...base, note: `Brought by ${t.ing.broughtBy}` });
      continue;
    }
    if (t.dishes.length === 0) continue;
    if (t.ing.shopAs) {
      const g = SHOP_GROUPS[t.ing.shopAs]!;
      const ex = items.get(t.ing.shopAs) ?? { key: t.ing.shopAs, name: g.name, category: g.category, amount: '', optional: [], toTaste: false, dishes: [], note: g.note };
      ex.amount = [ex.amount, `${amount} ${t.ing.name.toLowerCase()}`].filter(Boolean).join(' + ');
      for (const d of t.dishes) if (!ex.dishes.includes(d)) ex.dishes.push(d);
      items.set(t.ing.shopAs, ex);
      continue;
    }
    if (t.ing.id === 'eggs' && t.ing.inventory) base.note = `Have ${fmtQty(t.ing.inventory)}; recipe uses all 4 (2 stuffing + 2 beaten for sweet potato, 1/2 egg left over)`;
    if (t.ing.id === 'butter') base.note = `≈ ${((t.required.volume ?? 0) / 24).toFixed(2)} sticks — buy 4 sticks`;
    items.set(base.key, base);
  }
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: [...items.values()].filter((i) => i.category === category).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length > 0);
  return { groups, brought };
}

/** Ingredient lines for a dish's recipe card, with quantities rendered. */
export function recipeCardLines(d: Dish): { name: string; parts: string[] }[] {
  return d.lines.map((l) => {
    const ing = INGREDIENTS.find((i) => i.id === l.ing);
    return {
      name: ing?.name ?? l.ing,
      parts: l.parts.map((p) => {
        const amt = p.qty ? fmtQty(p.qty) : '';
        const pre = p.upTo ? 'up to ' : '';
        const tags = [p.optional ? 'optional' : '', p.toTaste ? 'to taste' : ''].filter(Boolean).join(', ');
        return [`${pre}${amt}`.trim(), p.toTaste ? '' : `(${p.purpose})`, tags ? `[${tags}]` : ''].filter(Boolean).join(' ');
      }),
    };
  });
}
