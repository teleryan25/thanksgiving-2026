import type { Qty, Unit } from './units';

export type DishId =
  | 'kitchen'
  | 'mash'
  | 'stuffing'
  | 'greenbeans'
  | 'corn'
  | 'sweetpotato'
  | 'mac'
  | 'compote'
  | 'gravy'
  | 'turkey'
  | 'bread';

export type ShopCategory = 'Produce' | 'Meat' | 'Dairy & Eggs' | 'Bakery' | 'Canned & Jarred' | 'Frozen' | 'Baking & Pantry' | 'Spices & Seasonings';

export interface Ingredient {
  id: string;
  name: string;
  category: ShopCategory;
  /** Units this ingredient may be measured in. Usages in other units are a validation error. */
  units: Unit[];
  /** 'drained' means quantities are drained weight; 'raw' means as purchased. */
  form?: 'drained' | 'raw' | 'frozen' | 'packed';
  /** Shopping line this ingredient rolls up into (e.g. orange juice + zest → oranges). */
  shopAs?: string;
  shopNote?: string;
  /** Known purchased inventory, if the plan depends on a count. */
  inventory?: Qty;
  broughtBy?: string;
}

export interface Usage {
  ing: string;
  qty?: Qty;
  /** What this portion is for, e.g. "sauce", "topping", "grease". Used to reconcile divided allocations. */
  purpose: string;
  optional?: boolean;
  upTo?: boolean;
  toTaste?: boolean;
  /** Prep usages (chopping, measuring) describe the same food again; they are excluded from totals. */
  prep?: boolean;
}

export interface Step {
  /** Instruction text. `{n}` renders the exact quantity of uses[n]. */
  text: string;
  uses?: Usage[];
  hint?: string;
}

export type Attention = 'active' | 'passive' | 'periodic' | 'external';

export interface Duration {
  min: number;
  nominal: number;
  max: number;
}

export interface Checkpoint {
  id: string;
  /** Minutes after task start. */
  at: number;
  /** Minutes of hands-on cook time it needs. */
  dur: number;
  label: string;
  text: string;
}

/** A cookware requirement: a single id, or any one of several alternatives. */
export type CookwareReq = string | string[];

export interface TaskDef {
  id: string;
  dish: DishId;
  title: string;
  kind: 'prep' | 'stove' | 'oven' | 'oven-transition' | 'rest' | 'external' | 'milestone';
  attention: Attention;
  duration: Duration;
  /** Hands-on minutes at the start / end of a passive or periodic task. */
  lead?: number;
  tail?: number;
  checkpoints?: Checkpoint[];
  deps: { id: string; soft?: boolean }[];
  oven?: { tempF: number; slots: 1 | 2 };
  ovenTransitionTo?: number;
  burners?: number;
  cookware?: CookwareReq[];
  /** 'asap' tasks run as early as possible; 'jit' tasks are pushed late so hot food finishes near dinner. */
  timing: 'asap' | 'jit';
  heat?: string;
  equipment: string[];
  steps: Step[];
  cues: string[];
  troubleshooting: string[];
  /** Completion requires the cook to confirm this (e.g. oven thermometer reading). */
  confirm?: string;
  /** Food-safety temperature required at completion. */
  safety?: { tempF: number; what: string };
  /** Never plan or accept less than duration.min without explicit confirmation. */
  enforceMin?: boolean;
  /** Food is actively heated during this task (stove/oven) — subtracted from room-temp exposure. */
  heating?: boolean;
  /** Create a timer when started. Timer expiry never means done. */
  timer?: string;
  extendOptions?: number[];
  /** Last task for a dish: its end is when the dish is ready to serve. */
  final?: boolean;
  /** Hard lower bound: never finish more than this many minutes before the dinner target. */
  finishWithinOfDinner?: number;
  /** Soft priority: prefer finishing at least this many minutes before the dinner target. */
  preferDoneBeforeDinner?: number;
  /** Higher = should finish closer to dinner. */
  serveCloseness?: number;
  /** Released no earlier than turkey ETA. */
  release?: 'turkeyEta';
  /** Who does it. Tasks owned by 'helper' don't use the cook. */
  owner?: 'cook' | 'helper';
  /** No-wait link: this task must start the moment that task (also a dependency) ends. */
  follows?: string;
  /** Skipping requires explicit unsafe confirmation. */
  critical?: boolean;
}

export interface DishLine {
  ing: string;
  parts: Usage[];
}

export interface Dish {
  id: DishId;
  name: string;
  short: string;
  serveHot: boolean;
  /** Ready this many minutes before dinner without a holding warning. */
  holdOkMin: number;
  /** Room-temperature exposure: starts when the first of `from` (cooked perishables) ends, stops at end of `until` (default: serving). */
  exposure?: { from: string[]; until?: string };
  lines: DishLine[];
  equipment: string[];
  notes: string[];
  /** Material issues found in the provided recipe — flagged, not silently changed. */
  flags: string[];
  /** Technique explanations shown with the recipe. */
  explain: { title: string; body: string }[];
}

export interface Cookware {
  id: string;
  name: string;
  note?: string;
}
