/** Quantities and unit conversion. Volumes normalize to tsp, weights to oz, counts stay separate per unit. */

export type VolumeUnit = 'tsp' | 'tbsp' | 'cup';
export type WeightUnit = 'oz' | 'lb';
export type CountUnit = 'each' | 'head' | 'clove' | 'pinch';
export type Unit = VolumeUnit | WeightUnit | CountUnit;
export type Dimension = 'volume' | 'weight' | 'count:each' | 'count:head' | 'count:clove' | 'count:pinch';

export interface Qty {
  amount: number;
  unit: Unit;
}

const TO_BASE: Record<Unit, number> = {
  tsp: 1,
  tbsp: 3,
  cup: 48,
  oz: 1,
  lb: 16,
  each: 1,
  head: 1,
  clove: 1,
  pinch: 1,
};

export function dimensionOf(u: Unit): Dimension {
  switch (u) {
    case 'tsp':
    case 'tbsp':
    case 'cup':
      return 'volume';
    case 'oz':
    case 'lb':
      return 'weight';
    default:
      return `count:${u}`;
  }
}

export function toBase(q: Qty): number {
  return q.amount * TO_BASE[q.unit];
}

export function compatible(a: Unit, b: Unit): boolean {
  return dimensionOf(a) === dimensionOf(b);
}

/** Sum of quantities grouped by dimension, in base units (tsp / oz / count). */
export type QtyTotals = Partial<Record<Dimension, number>>;

export function addTo(totals: QtyTotals, q: Qty): QtyTotals {
  const d = dimensionOf(q.unit);
  totals[d] = round6((totals[d] ?? 0) + toBase(q));
  return totals;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const FRACTIONS: [number, string][] = [
  [0, ''],
  [1 / 8, '1/8'],
  [1 / 4, '1/4'],
  [1 / 3, '1/3'],
  [3 / 8, '3/8'],
  [1 / 2, '1/2'],
  [5 / 8, '5/8'],
  [2 / 3, '2/3'],
  [3 / 4, '3/4'],
  [7 / 8, '7/8'],
];

export function fmtNumber(n: number): string {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  let best: [number, string] = FRACTIONS[0]!;
  for (const f of FRACTIONS) if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
  if (Math.abs(best[0] - frac) > 0.02) return String(Math.round(n * 100) / 100);
  if (best[1] === '') return String(whole);
  return whole === 0 ? best[1] : `${whole} ${best[1]}`;
}

const UNIT_LABEL: Record<Unit, [string, string]> = {
  tsp: ['tsp', 'tsp'],
  tbsp: ['tbsp', 'tbsp'],
  cup: ['cup', 'cups'],
  oz: ['oz', 'oz'],
  lb: ['lb', 'lb'],
  each: ['', ''],
  head: ['head', 'heads'],
  clove: ['clove', 'cloves'],
  pinch: ['pinch', 'pinches'],
};

export function fmtQty(q: Qty): string {
  const n = fmtNumber(q.amount);
  const [one, many] = UNIT_LABEL[q.unit];
  const label = q.amount > 1 ? many : one;
  return label ? `${n} ${label}` : n;
}

/** Human-readable volume total from tsp, e.g. 92.5 → "30 tbsp + 2 1/2 tsp". */
export function fmtVolumeTsp(tsp: number): string {
  if (tsp >= 12 && (Math.abs(tsp % 12) < 1e-9 || Math.abs(tsp % 16) < 1e-9)) return fmtQty({ amount: tsp / 48, unit: 'cup' });
  const tbsp = Math.floor(tsp / 3 + 1e-9);
  const rem = round6(tsp - tbsp * 3);
  if (tbsp === 0) return fmtQty({ amount: rem, unit: 'tsp' });
  if (rem === 0) return fmtQty({ amount: tbsp, unit: 'tbsp' });
  return `${fmtQty({ amount: tbsp, unit: 'tbsp' })} + ${fmtQty({ amount: rem, unit: 'tsp' })}`;
}

export function fmtTotals(t: QtyTotals): string {
  const out: string[] = [];
  for (const [dim, v] of Object.entries(t) as [Dimension, number][]) {
    if (dim === 'volume') out.push(fmtVolumeTsp(v));
    else if (dim === 'weight') out.push(v >= 32 && v % 16 === 0 ? fmtQty({ amount: v / 16, unit: 'lb' }) : fmtQty({ amount: v, unit: 'oz' }));
    else out.push(fmtQty({ amount: v, unit: dim.slice(6) as Unit }));
  }
  return out.join(' + ');
}
