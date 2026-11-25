/**
 * Deterministic resource- and dependency-aware scheduler.
 *
 * Resources: one cook (hands-on minutes, capacity 1), N burners, cookware items (capacity 1, with
 * any-of alternatives), one oven with 2 rack slots at a single temperature. Oven temperature phases
 * are explicit transition tasks in the dependency graph, so two temperatures can never overlap.
 * Attention: active tasks reserve the cook for their whole duration; passive/periodic tasks reserve
 * only lead, tail and checkpoint minutes.
 *
 * Tasks linked by `follows` (no-wait) are scheduled as one unit — e.g. a casserole's 5-minute rest
 * starts the moment it leaves the oven, a sauce simmers right after it is built.
 *
 * Algorithm (re-run on every minute tick and every event):
 *   1. Done, skipped and running tasks are fixed; running tasks reserve their remaining time.
 *   2. Forward serial list scheduling, priority = latest start from a resource-free backward pass.
 *      Hot-food ("jit") units are released no earlier than (latest start − W).
 *   3. Backward justification: jit units shift as late as successors/resources allow, never past
 *      max(target, achievable dinner); asap units are then pulled early; jit shifted again.
 *   4. Steps 2–3 run for several W values, two processing orders and a per-dish coordinate-descent
 *      sweep. The best score wins: unschedulable tasks ≫ dinner time ≫ exposure near the food-safety
 *      limit ≫ total room-temperature exposure ≫ hold time.
 * Durations are never planned below their minimum. A running task past its planned end is projected
 * to end at "now + 1 min" until the cook confirms completion — a timer never completes a task.
 */
import type { Dish, TaskDef } from './model';
import { ACCEPTABLE_LATE_MIN, MINUTE, fmtTime } from './time';

export interface TaskProgress {
  startedAt?: number;
  completedAt?: number;
  skippedAt?: number;
  /** Before start, extensions add to duration. While running, end = max(end, at) + min. */
  extensions?: { at: number; min: number }[];
  notBefore?: number;
  checkpointsDone?: Record<string, number>;
  /** Cookware chosen when started (for any-of requirements). */
  cookwareUsed?: string[];
}

export interface PlanSettings {
  burners: number;
  /** cookware id → available */
  cookware: Record<string, boolean>;
  helperCarvesTurkey: boolean;
  /** Room above 90°F: 1-hour food safety limit instead of 2. */
  hotRoom: boolean;
}

export interface PlanInput {
  tasks: TaskDef[];
  dishes: Dish[];
  progress: Record<string, TaskProgress>;
  nowMs: number;
  kitchenStartMs: number;
  targetMs: number;
  turkeyEtaMs: number;
  paused: boolean;
  settings: PlanSettings;
}

export type PlanStatus = 'done' | 'running' | 'scheduled' | 'blocked' | 'skipped' | 'unschedulable';

export interface PlannedTask {
  id: string;
  status: PlanStatus;
  startMs: number | null;
  endMs: number | null;
  /** Earliest acceptable end (minimum duration, never shortened). */
  minEndMs: number | null;
  cook: [number, number][];
  cookware: string[];
  rack?: 0 | 1 | 'both';
  checkpoints: { id: string; label: string; text: string; atMs: number; done: boolean; due: boolean }[];
  /** Why it can't start right now (empty = startable now). */
  blockers: string[];
  startableNow: boolean;
  overdue: boolean;
  holdMin?: number;
}

export interface Warning {
  level: 'info' | 'warn' | 'danger';
  code: string;
  text: string;
  taskId?: string;
  dish?: string;
}

export interface DishExposure {
  dish: string;
  name: string;
  startMs: number | null;
  untilMs: number | null;
  soFarMin: number;
  projectedMin: number;
  limitMin: number;
  refrigerateByMs: number | null;
}

export interface Plan {
  nowMs: number;
  originMs: number;
  targetMs: number;
  dinnerMs: number | null;
  status: 'on-target' | 'acceptable' | 'late' | 'blocked';
  lateMin: number;
  tasks: Record<string, PlannedTask>;
  order: string[];
  recommended: string | null;
  next: string | null;
  dueCheckpoints: { taskId: string; id: string; label: string; text: string; atMs: number }[];
  overdue: string[];
  warnings: Warning[];
  exposures: DishExposure[];
  oven: { taskId: string; rack: 0 | 1 | 'both'; startMs: number; endMs: number; tempF: number; transition: boolean }[];
  burners: { taskId: string; startMs: number; endMs: number; lane: number }[];
  progress: { done: number; total: number };
  strategy: string;
}

const HORIZON = 36 * 60;
const WINDOWS = [45, 75, 105, 150, 210, Number.POSITIVE_INFINITY];
const SAMPLES = 40;
const SEED = 20261126;

/** Small deterministic PRNG so sampling is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Work {
  def: TaskDef;
  idx: number;
  status: PlanStatus;
  dMin: number;
  dNom: number;
  start: number | null;
  end: number | null;
  minEnd: number | null;
  fixed: boolean;
  ls: number;
  lf: number;
  chosen: string[];
  blockers: string[];
  cookOwner: boolean;
  overdue: boolean;
}

interface Unit {
  id: string;
  members: Work[];
  offsets: number[];
  dur: number;
  timing: 'asap' | 'jit';
  idx: number;
  start: number | null;
  ls: number;
  lf: number;
  release: number;
}

class Profile {
  cook: Int16Array;
  burners: Int16Array;
  oven: Int16Array;
  ware = new Map<string, Int16Array>();
  constructor(public h: number) {
    this.cook = new Int16Array(h);
    this.burners = new Int16Array(h);
    this.oven = new Int16Array(h);
  }
  wareArr(id: string): Int16Array {
    let a = this.ware.get(id);
    if (!a) {
      a = new Int16Array(this.h);
      this.ware.set(id, a);
    }
    return a;
  }
  clone(): Profile {
    const p = new Profile(this.h);
    p.cook.set(this.cook);
    p.burners.set(this.burners);
    p.oven.set(this.oven);
    for (const [k, v] of this.ware) p.ware.set(k, v.slice());
    return p;
  }
}

/** Hands-on minute intervals for a task started at s with duration d (relative minutes). */
export function cookPattern(def: TaskDef, s: number, d: number, owner = true): [number, number][] {
  if (!owner || def.attention === 'external') return [];
  if (def.attention === 'active') return d > 0 ? [[s, s + d]] : [];
  const out: [number, number][] = [];
  if (def.lead) out.push([s, s + def.lead]);
  if (def.attention === 'periodic') for (const c of def.checkpoints ?? []) out.push([s + c.at, s + c.at + c.dur]);
  if (def.tail) out.push([s + d - def.tail, s + d]);
  return out;
}

const extTotal = (p?: TaskProgress) => (p?.extensions ?? []).reduce((a, e) => a + e.min, 0);

export function plan(input: PlanInput): Plan {
  const { tasks, progress, settings } = input;
  const nowMin = Math.floor(input.nowMs / MINUTE);
  const anyStarted = tasks.some((t) => progress[t.id]?.startedAt != null || progress[t.id]?.completedAt != null);
  const O = anyStarted ? nowMin : Math.max(nowMin, Math.floor(input.kitchenStartMs / MINUTE));
  const rel = (ms: number) => Math.floor(ms / MINUTE) - O;
  const relCeil = (ms: number) => Math.ceil(ms / MINUTE) - O;
  const abs = (r: number) => (O + r) * MINUTE;
  const now = nowMin - O; // ≤ 0
  const planStart = Math.max(0, now);
  const targetRel = rel(input.targetMs);
  const turkeyRel = rel(input.turkeyEtaMs);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const succ = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.deps) succ.set(d.id, [...(succ.get(d.id) ?? []), t.id]);
  const isOwner = (def: TaskDef) => !(def.id === 'turkey-carve' && settings.helperCarvesTurkey) && def.owner !== 'helper';

  // ── Status & durations ──
  const W = new Map<string, Work>();
  tasks.forEach((def, idx) => {
    const p = progress[def.id];
    const ext = extTotal(p);
    const w: Work = {
      def,
      idx,
      status: 'scheduled',
      dMin: def.duration.min + ext,
      dNom: def.duration.nominal + ext,
      start: null,
      end: null,
      minEnd: null,
      fixed: false,
      ls: 0,
      lf: 0,
      chosen: [],
      blockers: [],
      cookOwner: isOwner(def),
      overdue: false,
    };
    if (p?.skippedAt != null) {
      w.status = 'skipped';
      w.fixed = true;
    } else if (p?.completedAt != null) {
      w.status = 'done';
      w.fixed = true;
      w.end = rel(p.completedAt);
      w.start = p.startedAt != null ? rel(p.startedAt) : w.end;
    } else if (p?.startedAt != null) {
      w.status = 'running';
      w.fixed = true;
      const s = rel(p.startedAt);
      let nomEnd = s + def.duration.nominal;
      let reqEnd = s + def.duration.min;
      for (const e of [...(p.extensions ?? [])].sort((a, b) => a.at - b.at)) {
        nomEnd = Math.max(nomEnd, relCeil(e.at)) + e.min;
        reqEnd = Math.max(reqEnd, nomEnd);
      }
      w.start = s;
      w.minEnd = reqEnd;
      w.overdue = Math.max(nomEnd, reqEnd) <= now;
      w.end = Math.max(nomEnd, reqEnd, now + 1);
      w.chosen = p.cookwareUsed ?? [];
    }
    W.set(def.id, w);
  });

  // ── Blocked by skipped prerequisites or unavailable equipment (never silently unlocked) ──
  const memo = new Map<string, string | null>();
  const blockedReason = (id: string): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, null);
    const w = W.get(id)!;
    let r: string | null = null;
    if (w.status === 'scheduled') {
      for (const d of w.def.deps) {
        const dw = W.get(d.id)!;
        if (d.soft) continue;
        if (dw.status === 'skipped') r = `Prerequisite "${dw.def.title}" was skipped`;
        else if (blockedReason(d.id)) r = `Prerequisite "${dw.def.title}" is blocked`;
        if (r) break;
      }
      if (!r)
        for (const req of w.def.cookware ?? []) {
          const alts = Array.isArray(req) ? req : [req];
          if (!alts.some((a) => settings.cookware[a] !== false)) r = `Needs ${alts.join(' or ')} (marked unavailable in Settings)`;
        }
      if (!r && (w.def.burners ?? 0) > settings.burners) r = `Needs ${w.def.burners} burners`;
    }
    memo.set(id, r);
    return r;
  };
  for (const w of W.values()) {
    const r = blockedReason(w.def.id);
    if (r) {
      w.status = 'blocked';
      w.blockers.push(r);
    }
  }

  // ── Topological order and resource-free latest finish (priority) ──
  const topo: string[] = [];
  {
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const d of byId.get(id)!.deps) visit(d.id);
      topo.push(id);
    };
    for (const t of tasks) visit(t.id);
  }
  const live = (w: Work) => w.status !== 'skipped' && w.status !== 'blocked';
  for (const id of [...topo].reverse()) {
    const w = W.get(id)!;
    const ss = (succ.get(id) ?? []).map((s) => W.get(s)!).filter(live);
    w.lf = ss.length ? Math.min(...ss.map((s) => s.lf - s.dNom)) : targetRel;
    if (w.def.final) w.lf = Math.min(w.lf, targetRel);
    if (w.def.preferDoneBeforeDinner != null) w.lf = Math.min(w.lf, targetRel - w.def.preferDoneBeforeDinner);
    w.ls = w.lf - w.dNom;
  }

  // ── Reservations ──
  const cookIntervalsFor = (w: Work): [number, number][] => {
    if (!w.cookOwner || w.start == null || w.end == null) return [];
    const s = w.start;
    const e = w.end;
    const def = w.def;
    if (w.status !== 'running') return cookPattern(def, s, e - s, true);
    const out: [number, number][] = [];
    const done = progress[def.id]?.checkpointsDone ?? {};
    if (def.attention === 'active') out.push([Math.max(s, now), e]);
    else if (def.attention !== 'external') {
      if (def.lead && s + def.lead > now) out.push([Math.max(s, now), s + def.lead]);
      for (const c of def.checkpoints ?? []) {
        if (done[c.id] != null) continue;
        const cs = s + c.at;
        out.push(cs < now ? [now, now + c.dur] : [cs, cs + c.dur]);
      }
      if (def.tail) out.push([Math.max(e - def.tail, now), e]);
    }
    return out.filter(([a, b]) => b > a);
  };
  const reserve = (p: Profile, w: Work, sign: 1 | -1) => {
    const a = Math.max(0, w.start!, now);
    const b = Math.min(HORIZON, w.end!);
    const def = w.def;
    for (let m = a; m < b; m++) {
      if (def.burners) p.burners[m]! += sign * def.burners;
      if (def.oven) p.oven[m]! += sign * def.oven.slots;
      for (const c of w.chosen) p.wareArr(c)[m]! += sign;
    }
    for (const [ca, cb] of cookIntervalsFor(w)) for (let m = Math.max(0, ca); m < Math.min(HORIZON, cb); m++) p.cook[m]! += sign;
  };
  const base = new Profile(HORIZON);
  for (const w of W.values()) if (w.status === 'running') reserve(base, w, 1);
  if (input.paused) base.cook[planStart]! += 1;

  /** Returns chosen cookware if task w fits starting at s, else null. */
  const fits = (p: Profile, w: Work, s: number): string[] | null => {
    const e = s + w.dNom;
    if (s < 0 || e > HORIZON) return null;
    const def = w.def;
    for (const [a, b] of cookPattern(def, s, w.dNom, w.cookOwner)) for (let m = a; m < b; m++) if (m >= HORIZON || p.cook[m]! > 0) return null;
    if (def.burners || def.oven)
      for (let m = s; m < e; m++) {
        if (def.burners && p.burners[m]! + def.burners > settings.burners) return null;
        if (def.oven && p.oven[m]! + def.oven.slots > 2) return null;
      }
    const chosen: string[] = [];
    for (const req of def.cookware ?? []) {
      const alts = (Array.isArray(req) ? req : [req]).filter((a) => settings.cookware[a] !== false);
      let pick: string | null = null;
      for (const a of alts) {
        if (chosen.includes(a)) continue;
        const arr = p.ware.get(a);
        let ok = true;
        if (arr)
          for (let m = s; m < e; m++)
            if (arr[m]! > 0) {
              ok = false;
              break;
            }
        if (ok) {
          pick = a;
          break;
        }
      }
      if (!pick) return null;
      chosen.push(pick);
    }
    return chosen;
  };

  // ── Units: chains of no-wait (`follows`) pending tasks ──
  const pending = tasks.map((t) => W.get(t.id)!).filter((w) => w.status === 'scheduled');
  const pendingSet = new Set(pending.map((w) => w.def.id));
  const follower = new Map<string, string>();
  for (const w of pending) if (w.def.follows && pendingSet.has(w.def.follows)) follower.set(w.def.follows, w.def.id);
  const units: Unit[] = [];
  const unitOf = new Map<string, Unit>();
  for (const w of pending) {
    if (w.def.follows && pendingSet.has(w.def.follows)) continue; // not a chain head
    const members: Work[] = [w];
    let cur = w.def.id;
    while (follower.has(cur)) {
      cur = follower.get(cur)!;
      members.push(W.get(cur)!);
    }
    const offsets: number[] = [];
    let off = 0;
    for (const m of members) {
      offsets.push(off);
      off += m.dNom;
    }
    const ls = Math.min(...members.map((m, i) => m.ls - offsets[i]!));
    const u: Unit = {
      id: w.def.id,
      members,
      offsets,
      dur: off,
      timing: members.some((m) => m.def.timing === 'jit') ? 'jit' : 'asap',
      idx: w.idx,
      start: null,
      ls,
      lf: ls + off,
      release: 0,
    };
    // Followers of a running/finished task must start as soon as possible.
    if (w.def.follows && !pendingSet.has(w.def.follows)) u.timing = 'asap';
    units.push(u);
    for (const m of members) unitOf.set(m.def.id, u);
  }

  const baseRelease = (w: Work): number => {
    let r = planStart;
    const nb = progress[w.def.id]?.notBefore;
    if (nb != null) r = Math.max(r, relCeil(nb));
    if (w.def.release === 'turkeyEta') r = Math.max(r, turkeyRel);
    return r;
  };
  const depEnd = (id: string): number | null => {
    const w = W.get(id)!;
    if (w.status === 'skipped') return Number.NEGATIVE_INFINITY;
    if (w.status === 'blocked' || w.status === 'unschedulable') return null;
    return w.end;
  };
  const unitFits = (p: Profile, u: Unit, s: number): string[][] | null => {
    const res: string[][] = [];
    for (let i = 0; i < u.members.length; i++) {
      const ch = fits(p, u.members[i]!, s + u.offsets[i]!);
      if (!ch) return null;
      res.push(ch);
    }
    return res;
  };
  const placeUnit = (p: Profile, u: Unit, s: number, chosen: string[][]) => {
    u.start = s;
    u.members.forEach((w, i) => {
      w.start = s + u.offsets[i]!;
      w.end = w.start + w.dNom;
      w.minEnd = w.start + w.dMin;
      w.chosen = chosen[i]!;
      reserve(p, w, 1);
    });
  };
  const unplaceUnit = (p: Profile, u: Unit): string[][] => {
    const ch = u.members.map((w) => w.chosen);
    for (const w of u.members) reserve(p, w, -1);
    return ch;
  };
  /** Earliest start allowed by external dependencies (null = some dependency not placed yet). */
  const unitDepReady = (u: Unit): number | null => {
    let t = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < u.members.length; i++) {
      for (const d of u.members[i]!.def.deps) {
        if (unitOf.get(d.id) === u) continue;
        if (d.soft && !live(W.get(d.id)!)) continue; // ordering-only link to something that won't happen
        const e = depEnd(d.id);
        if (e == null) return null;
        t = Math.max(t, e - u.offsets[i]!);
      }
    }
    return t;
  };
  const succUnits = new Map<Unit, Unit[]>();
  for (const u of units) {
    const out = new Set<Unit>();
    for (const m of u.members)
      for (const s of succ.get(m.def.id) ?? []) {
        const su = unitOf.get(s);
        if (su && su !== u) out.add(su);
      }
    succUnits.set(u, [...out]);
  }
  const predUnits = new Map<Unit, Unit[]>(units.map((u) => [u, []]));
  for (const [u, ss] of succUnits) for (const s2 of ss) predUnits.get(s2)!.push(u);
  const unitLatestStart = (u: Unit, D: number): number => {
    let ls = Number.POSITIVE_INFINITY;
    u.members.forEach((m, i) => {
      let le = D;
      for (const s of succ.get(m.def.id) ?? []) {
        if (unitOf.get(s) === u) continue;
        const sw = W.get(s)!;
        if (sw.start != null && sw.status === 'scheduled') le = Math.min(le, sw.start);
      }
      ls = Math.min(ls, le - u.offsets[i]! - m.dNom);
    });
    return ls;
  };

  interface Snapshot {
    starts: Map<string, { start: number; end: number; minEnd: number; chosen: string[]; status: PlanStatus }>;
    dinner: number;
    score: number;
    label: string;
  }

  const resetPending = (win: (u: Unit) => number, minRelease?: (u: Unit) => number | undefined) => {
    for (const u of units) {
      u.start = null;
      let r = Number.NEGATIVE_INFINITY;
      u.members.forEach((m, i) => {
        m.start = m.end = m.minEnd = null;
        m.chosen = [];
        m.status = 'scheduled';
        r = Math.max(r, baseRelease(m) - u.offsets[i]!);
      });
      const x = win(u);
      if (u.timing === 'jit' && Number.isFinite(x)) r = Math.max(r, u.ls - x);
      const extra = minRelease?.(u);
      if (extra != null) r = Math.max(r, extra);
      u.release = Math.max(r, planStart);
    }
  };

  const prioNoise = new Map<Unit, number>();
  const forwardList = (p: Profile) => {
    const key = (u: Unit) => u.ls + (prioNoise.get(u) ?? 0);
    const prio = [...units].sort((a, b) => key(a) - key(b) || a.idx - b.idx);
    let remaining = prio.length;
    const readyAt = new Map<Unit, number | null>();
    for (let t = planStart; t < HORIZON && remaining > 0; t++) {
      for (const u of prio) {
        if (u.start != null || u.release > t) continue;
        let ready = readyAt.get(u);
        if (ready === undefined) {
          ready = unitDepReady(u);
          readyAt.set(u, ready);
        }
        if (ready == null || ready > t) continue;
        const ch = unitFits(p, u, t);
        if (ch) {
          placeUnit(p, u, t, ch);
          remaining--;
          for (const su of succUnits.get(u)!) readyAt.delete(su);
        }
      }
    }
    for (const u of prio) if (u.start == null) for (const m of u.members) m.status = 'unschedulable';
  };

  // Chain priority: each task inherits the highest serve-closeness of the dish finals it feeds.
  const chainPrio = new Map<string, number>();
  for (const id of [...topo].reverse()) {
    const w = W.get(id)!;
    let v = w.def.final ? (w.def.serveCloseness ?? 0) * 1000 + w.lf : Number.NEGATIVE_INFINITY;
    for (const s2 of succ.get(id) ?? []) v = Math.max(v, chainPrio.get(s2) ?? Number.NEGATIVE_INFINITY);
    chainPrio.set(id, v);
  }
  const uChain = (u: Unit) => Math.max(...u.members.map((m) => chainPrio.get(m.def.id)!));
  const uClose = (u: Unit) => Math.max(...u.members.map((m) => m.def.serveCloseness ?? 0));
  const ORDERS = {
    lf: (a: Unit, b: Unit) => b.lf - a.lf || uClose(b) - uClose(a) || (b.start ?? 0) - (a.start ?? 0) || a.idx - b.idx,
    chain: (a: Unit, b: Unit) => uChain(b) - uChain(a) || b.lf - a.lf || (b.start ?? 0) - (a.start ?? 0) || a.idx - b.idx,
  } as const;
  type OrderKey = keyof typeof ORDERS;

  /** Visit units from the end: a unit is eligible once all of its successor units are visited. */
  const reverseVisit = (order: OrderKey, visit: (u: Unit) => void) => {
    const remainingSucc = new Map<Unit, number>(units.map((u) => [u, succUnits.get(u)!.length]));
    const ready = units.filter((u) => remainingSucc.get(u) === 0);
    const cmp = ORDERS[order];
    while (ready.length) {
      let bi = 0;
      for (let i = 1; i < ready.length; i++) if (cmp(ready[i]!, ready[bi]!) < 0) bi = i;
      const u = ready.splice(bi, 1)[0]!;
      visit(u);
      for (const pu of predUnits.get(u)!) {
        const r = remainingSucc.get(pu)! - 1;
        remainingSucc.set(pu, r);
        if (r === 0) ready.push(pu);
      }
    }
  };

  /** Right-shift jit units as late as successors, resources and D allow. */
  const backwardJustify = (p: Profile, D: number, order: OrderKey) =>
    reverseVisit(order, (u) => {
      if (u.timing !== 'jit' || u.start == null) return;
      const latest = unitLatestStart(u, D);
      const cur = u.start;
      if (latest <= cur) return;
      const curCh = unplaceUnit(p, u);
      for (let s = latest; s > cur; s--) {
        const ch = unitFits(p, u, s);
        if (ch) return placeUnit(p, u, s, ch);
      }
      placeUnit(p, u, cur, curCh);
    });

  /** Pull asap units as early as dependencies, release and resources allow. */
  const forwardJustifyAsap = (p: Profile) => {
    const list = units.filter((u) => u.timing === 'asap' && u.start != null).sort((a, b) => a.start! - b.start! || a.idx - b.idx);
    for (const u of list) {
      const ready = unitDepReady(u);
      const lb = Math.max(u.release, ready ?? u.start!);
      const cur = u.start!;
      if (lb >= cur) continue;
      const curCh = unplaceUnit(p, u);
      let moved = false;
      for (let s = lb; s < cur; s++) {
        const ch = unitFits(p, u, s);
        if (ch) {
          placeUnit(p, u, s, ch);
          moved = true;
          break;
        }
      }
      if (!moved) placeUnit(p, u, cur, curCh);
    }
  };

  const finalsOf = () =>
    tasks
      .filter((t) => t.final)
      .map((t) => W.get(t.id)!)
      .filter((w) => live(w) && w.end != null);
  const limit = settings.hotRoom ? 60 : 120;

  const snapshot = (label: string): Snapshot => {
    const finals = finalsOf();
    // Food is served at the later of "everything ready" and the target — finishing early is not a win.
    const dinner = Math.max(targetRel, finals.length ? Math.max(...finals.map((w) => w.end!)) : planStart);
    let hold = 0;
    for (const w of finals) if (input.dishes.find((d) => d.id === w.def.dish)?.serveHot) hold += Math.max(0, dinner - w.end!);
    let exposure = 0;
    let over = 0;
    let overHard = 0;
    for (const dish of input.dishes) {
      if (!dish.exposure || dish.exposure.until) continue;
      const ends = dish.exposure.from.map((f) => W.get(f)!).filter((fw) => fw.end != null && live(fw)).map((fw) => fw.end!);
      if (!ends.length) continue;
      const from = Math.min(...ends);
      let total = Math.max(0, dinner - from);
      for (const t of tasks) {
        if (t.dish !== dish.id || !t.heating) continue;
        const hw = W.get(t.id)!;
        if (hw.start == null || hw.end == null) continue;
        total -= Math.max(0, Math.min(dinner, hw.end) - Math.max(from, hw.start));
      }
      exposure += Math.max(0, total);
      over += Math.max(0, total - limit + 10);
      overHard += Math.max(0, total - limit);
    }
    const unsched = pending.filter((w) => w.status === 'unschedulable').length;
    const starts: Snapshot['starts'] = new Map();
    for (const w of pending) starts.set(w.def.id, { start: w.start ?? -1, end: w.end ?? -1, minEnd: w.minEnd ?? -1, chosen: w.chosen, status: w.status });
    // Score (lower is better): unschedulable ≫ lateness beyond the acceptable window ≫ exposure
    // the acceptable window; 1 min over the limit ≈ 66 min late within the window; then exposure, hold.
    const late = dinner - targetRel;
    const lateBad = Math.max(0, late - ACCEPTABLE_LATE_MIN);
    const score = unsched * 1e9 + overHard * 2e4 + lateBad * 1e5 + late * 300 + over * 100 + exposure * 10 + hold;
    return { starts, dinner, score, label };
  };

  const run = (win: (u: Unit) => number, order: OrderKey, label: string, minRelease?: (u: Unit) => number | undefined): Snapshot => {
    resetPending(win, minRelease);
    const p = base.clone();
    forwardList(p);
    const finals = finalsOf();
    const D = Math.max(targetRel, finals.length ? Math.max(...finals.map((w) => w.end!)) : planStart);
    backwardJustify(p, D, order);
    forwardJustifyAsap(p);
    backwardJustify(p, D, order);
    return snapshot(label);
  };

  let best = null as Snapshot | null;
  if (units.length) {
    let bestWin = Number.POSITIVE_INFINITY;
    let bestOrder: OrderKey = 'chain';
    let bestWinMap: Map<Unit, number> | null = null;
    let bestNoise = new Map<Unit, number>();
    for (const order of ['chain', 'lf'] as OrderKey[])
      for (const win of WINDOWS) {
        const snap = run(() => win, order, `forward/${order}/W${win}`);
        if (!best || snap.score < best.score) {
          best = snap;
          bestWin = win;
          bestOrder = order;
        }
      }
    // Multi-pass sampling (deterministic seed): perturb per-unit release windows and priorities.
    const rand = mulberry32(SEED);
    const jitUnits = units.filter((u) => u.timing === 'jit');
    for (let i = 0; i < SAMPLES; i++) {
      const wins = new Map<Unit, number>();
      for (const u of jitUnits) wins.set(u, WINDOWS[Math.floor(rand() * WINDOWS.length)]!);
      prioNoise.clear();
      for (const u of units) prioNoise.set(u, Math.floor(rand() * 40) - 20);
      const order: OrderKey = rand() < 0.5 ? 'chain' : 'lf';
      const snap = run((u) => wins.get(u) ?? Number.POSITIVE_INFINITY, order, `sample/${order}`);
      if (snap.score < best!.score) {
        best = snap;
        bestOrder = order;
        bestWinMap = wins;
        bestNoise = new Map(prioNoise);
      }
    }
    prioNoise.clear();
    for (const [u, n] of bestNoise) prioNoise.set(u, n);
    // Coordinate descent: delay the unit where each hot dish's room-temperature exposure begins
    // (e.g. browning the sausage) so the dish is assembled and cooked closer to dinner.
    const expUnits = input.dishes
      .flatMap((d) => (d.exposure && !d.exposure.until ? d.exposure.from.map((f) => unitOf.get(f)) : []))
      .filter((u, i, arr): u is Unit => !!u && u.timing === 'jit' && arr.indexOf(u) === i)
      .sort((a, b) => a.idx - b.idx);
    const override = new Map<Unit, number>();
    const release = (u: Unit) => override.get(u);
    for (let sweep = 0; sweep < 2; sweep++) {
      let improved = false;
      for (const u of expUnits) {
        const cur = best!.starts.get(u.id)!.start;
        if (cur < 0) continue;
        const prev = override.get(u);
        let keep = prev;
        for (const delta of [10, 20, 30, 45, 60, 90]) {
          override.set(u, cur + delta);
          const snap = run((x) => bestWinMap?.get(x) ?? bestWin, bestOrder, `${best!.label}+delay`, release);
          if (snap.score < best!.score) {
            best = snap;
            keep = cur + delta;
            improved = true;
          }
        }
        if (keep == null) override.delete(u);
        else override.set(u, keep);
      }
      if (!improved) break;
    }
    for (const [id, s] of best!.starts) {
      const w = W.get(id)!;
      w.status = s.status;
      if (s.status === 'scheduled') {
        w.start = s.start;
        w.end = s.end;
        w.minEnd = s.minEnd;
        w.chosen = s.chosen;
      } else {
        w.start = w.end = w.minEnd = null;
        w.blockers.push('Could not fit within the planning horizon');
      }
    }
  }

  // ── Startability now & blocker explanations ──
  const running = [...W.values()].filter((w) => w.status === 'running');
  const usedNow = { burners: 0, oven: 0, ware: new Set<string>(), active: [] as Work[] };
  for (const w of running) {
    usedNow.burners += w.def.burners ?? 0;
    usedNow.oven += w.def.oven?.slots ?? 0;
    for (const c of w.chosen) usedNow.ware.add(c);
    if (w.def.attention === 'active' && w.cookOwner) usedNow.active.push(w);
  }
  const ovenNowTemp = (() => {
    const done = tasks.filter((t) => t.ovenTransitionTo != null && W.get(t.id)!.status === 'done').sort((a, b) => W.get(b.id)!.end! - W.get(a.id)!.end!);
    return done[0]?.ovenTransitionTo ?? null;
  })();
  for (const w of W.values()) {
    if (w.status !== 'scheduled') continue;
    const b: string[] = [];
    for (const d of w.def.deps) {
      const dw = W.get(d.id)!;
      if (dw.status === 'done' || dw.status === 'skipped' || (d.soft && dw.status === 'blocked')) continue;
      b.push(dw.status === 'running' ? `Waiting for "${dw.def.title}" (in progress)` : `Waiting for "${dw.def.title}"${dw.start != null ? ` (planned ${fmtTime(abs(dw.start))})` : ''}`);
    }
    const nb = progress[w.def.id]?.notBefore;
    if (nb != null && nb > input.nowMs) b.push(`Delayed until ${fmtTime(nb)}`);
    if (w.def.release === 'turkeyEta' && input.turkeyEtaMs > input.nowMs) b.push(`Turkey ETA ${fmtTime(input.turkeyEtaMs)}`);
    if (w.def.burners && usedNow.burners + w.def.burners > settings.burners) b.push(`All ${settings.burners} burners in use`);
    if (w.def.oven) {
      if (usedNow.oven + w.def.oven.slots > 2) b.push('Oven racks full');
      if (w.def.ovenTransitionTo == null && ovenNowTemp !== w.def.oven.tempF) b.push(`Oven not confirmed at ${w.def.oven.tempF}°F`);
    }
    for (const req of w.def.cookware ?? []) {
      const alts = (Array.isArray(req) ? req : [req]).filter((a) => settings.cookware[a] !== false);
      if (alts.length && alts.every((a) => usedNow.ware.has(a))) {
        const holder = running.find((r) => r.chosen.includes(alts[0]!));
        b.push(`${alts.join(' / ')} in use${holder ? ` by "${holder.def.title}"` : ''}`);
      }
    }
    w.blockers = b;
  }

  // ── Output ──
  const out: Record<string, PlannedTask> = {};
  for (const w of W.values()) {
    const p = progress[w.def.id];
    const done = p?.checkpointsDone ?? {};
    const cps = (w.def.checkpoints ?? []).map((c) => {
      const at = w.start != null ? abs(w.start + c.at) : 0;
      return { id: c.id, label: c.label, text: c.text, atMs: at, done: done[c.id] != null, due: w.status === 'running' && done[c.id] == null && at <= input.nowMs };
    });
    const startMs = w.status === 'done' ? (p?.startedAt ?? p!.completedAt!) : w.status === 'running' ? p!.startedAt! : w.start != null ? abs(w.start) : null;
    const endMs = w.status === 'done' ? p!.completedAt! : w.end != null ? abs(w.end) : null;
    out[w.def.id] = {
      id: w.def.id,
      status: w.status,
      startMs: w.status === 'skipped' ? null : startMs,
      endMs: w.status === 'skipped' ? null : endMs,
      minEndMs: w.minEnd != null && w.status !== 'done' ? abs(w.minEnd) : null,
      cook: w.status === 'scheduled' || w.status === 'running' ? cookIntervalsFor(w).map(([a, b]) => [abs(a), abs(b)] as [number, number]) : [],
      cookware: w.chosen,
      checkpoints: cps,
      blockers: w.blockers,
      startableNow: w.status === 'scheduled' && w.blockers.length === 0,
      overdue: w.status === 'running' && w.overdue,
    };
  }

  const finalsOut = tasks.filter((t) => t.final && ['scheduled', 'running', 'done'].includes(out[t.id]!.status));
  const dinnerMs = finalsOut.length ? Math.max(...finalsOut.map((t) => out[t.id]!.endMs!)) : null;
  const lateMin = dinnerMs == null ? 0 : Math.max(0, Math.round((dinnerMs - input.targetMs) / MINUTE));
  const anyBlockedFinal = tasks.some((t) => t.final && (out[t.id]!.status === 'blocked' || out[t.id]!.status === 'unschedulable'));
  const status: Plan['status'] = anyBlockedFinal ? 'blocked' : lateMin === 0 ? 'on-target' : lateMin <= ACCEPTABLE_LATE_MIN ? 'acceptable' : 'late';
  for (const t of finalsOut) if (dinnerMs != null) out[t.id]!.holdMin = Math.round((dinnerMs - out[t.id]!.endMs!) / MINUTE);

  const order = tasks.map((t) => t.id).sort((a, b) => (out[a]!.startMs ?? Infinity) - (out[b]!.startMs ?? Infinity) || W.get(a)!.idx - W.get(b)!.idx);

  const startable = order.filter((id) => out[id]!.startableNow);
  const dueNow = startable.filter((id) => (out[id]!.startMs ?? Infinity) <= input.nowMs + 30_000);
  const needsCook = (id: string) => W.get(id)!.def.attention !== 'external';
  const recommended = input.paused ? null : (dueNow.find(needsCook) ?? dueNow[0] ?? null);
  const next = order.find((id) => out[id]!.status === 'scheduled' && id !== recommended) ?? null;
  const dueCheckpoints = Object.values(out)
    .flatMap((pt) => pt.checkpoints.filter((c) => c.due).map((c) => ({ taskId: pt.id, id: c.id, label: c.label, text: c.text, atMs: c.atMs })))
    .sort((a, b) => a.atMs - b.atMs);
  const overdue = Object.values(out)
    .filter((pt) => pt.overdue)
    .map((pt) => pt.id);

  // ── Warnings ──
  const warnings: Warning[] = [];
  if (status === 'acceptable') warnings.push({ level: 'warn', code: 'late', text: `Dinner projected ${lateMin} min after target (within the ${ACCEPTABLE_LATE_MIN}-minute acceptable window).` });
  if (status === 'late') warnings.push({ level: 'danger', code: 'late', text: `Dinner projected ${lateMin} min after target.` });
  if (usedNow.active.length > 1) warnings.push({ level: 'warn', code: 'cook-conflict', text: `Two hands-on tasks are running at once: ${usedNow.active.map((w) => w.def.title).join(' + ')}.` });
  if (usedNow.burners > settings.burners) warnings.push({ level: 'warn', code: 'burners', text: `More burners in use (${usedNow.burners}) than configured (${settings.burners}).` });
  for (const w of W.values()) {
    if (w.status === 'blocked') warnings.push({ level: 'danger', code: 'blocked', taskId: w.def.id, text: `${w.def.title}: ${w.blockers[0]}` });
    if (w.status === 'unschedulable') warnings.push({ level: 'danger', code: 'unschedulable', taskId: w.def.id, text: `${w.def.title} could not be scheduled.` });
  }
  if (dinnerMs != null)
    for (const t of finalsOut) {
      const dish = input.dishes.find((d) => d.id === t.dish);
      const hold = out[t.id]!.holdMin ?? 0;
      if (dish?.serveHot && hold > dish.holdOkMin && out[t.id]!.status !== 'done')
        warnings.push({
          level: 'info',
          code: 'hold',
          taskId: t.id,
          dish: dish.id,
          text: `${dish.short} ready ${hold} min before dinner — it will cool. Tent loosely with foil; it is not "held hot" unless you measure ≥140°F.`,
        });
    }
  if (out['turkey-arrive']?.status === 'scheduled' && input.turkeyEtaMs < input.nowMs)
    warnings.push({ level: 'warn', code: 'turkey', text: `Turkey ETA (${fmtTime(input.turkeyEtaMs)}) has passed. Update the ETA or mark it arrived.` });

  // ── Room-temperature exposure ──
  const exposures: DishExposure[] = [];
  for (const dish of input.dishes) {
    if (!dish.exposure) continue;
    const fromEnds = dish.exposure.from
      .map((f) => out[f])
      .filter((x): x is PlannedTask => !!x && x.status !== 'skipped' && x.status !== 'blocked' && x.endMs != null)
      .map((x) => x.endMs!);
    if (!fromEnds.length) continue;
    const startMs = Math.min(...fromEnds);
    const untilMs = dish.exposure.until ? (out[dish.exposure.until]?.endMs ?? null) : dinnerMs;
    if (untilMs == null) continue;
    const heat = tasks
      .filter((t) => t.dish === dish.id && t.heating)
      .map((t) => out[t.id]!)
      .filter((pt) => pt.startMs != null && pt.endMs != null && pt.status !== 'skipped')
      .map((pt) => [pt.startMs!, pt.endMs!] as [number, number]);
    const exposed = (a: number, b: number) => {
      if (b <= a) return 0;
      let total = b - a;
      for (const [x, y] of heat) total -= Math.max(0, Math.min(b, y) - Math.max(a, x));
      return Math.max(0, total) / MINUTE;
    };
    const projected = Math.round(exposed(startMs, untilMs));
    const soFar = Math.round(exposed(startMs, Math.min(untilMs, input.nowMs)));
    const refrigerateBy = dish.exposure.until ? null : untilMs + Math.max(0, limit - projected) * MINUTE;
    exposures.push({ dish: dish.id, name: dish.short, startMs, untilMs, soFarMin: soFar, projectedMin: projected, limitMin: limit, refrigerateByMs: refrigerateBy });
    if (projected >= limit)
      warnings.push({
        level: 'danger',
        code: 'exposure',
        dish: dish.id,
        text: `${dish.short}: projected ${projected} min at room temperature before ${dish.exposure.until ? 'refrigeration' : 'dinner'} (limit ${limit}). Refrigerate it, then reheat to 165°F — or re-plan.`,
      });
    else if (dish.serveHot && projected >= limit / 2)
      warnings.push({ level: 'info', code: 'exposure', dish: dish.id, text: `${dish.short}: ~${projected} min at room temperature before dinner — refrigerate leftovers by ${fmtTime(refrigerateBy!)}.` });
  }

  // ── Oven racks & burner lanes (display) ──
  const ovenItems = tasks
    .filter((t) => t.oven && out[t.id]!.startMs != null && out[t.id]!.endMs != null && out[t.id]!.status !== 'skipped')
    .map((t) => ({ t, s: out[t.id]!.startMs!, e: out[t.id]!.endMs! }))
    .sort((a, b) => a.s - b.s || a.t.id.localeCompare(b.t.id));
  const rackFree = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const oven: Plan['oven'] = [];
  for (const it of ovenItems) {
    let rack: 0 | 1 | 'both';
    if (it.t.oven!.slots === 2) {
      rack = 'both';
      rackFree[0] = rackFree[1] = it.e;
    } else {
      rack = rackFree[0]! <= it.s ? 0 : rackFree[1]! <= it.s ? 1 : rackFree[0]! <= rackFree[1]! ? 0 : 1;
      rackFree[rack] = it.e;
    }
    out[it.t.id]!.rack = rack;
    oven.push({ taskId: it.t.id, rack, startMs: it.s, endMs: it.e, tempF: it.t.oven!.tempF, transition: it.t.ovenTransitionTo != null });
  }
  const stove = tasks
    .filter((t) => t.burners && out[t.id]!.startMs != null && out[t.id]!.endMs != null && out[t.id]!.status !== 'skipped')
    .map((t) => ({ id: t.id, s: out[t.id]!.startMs!, e: out[t.id]!.endMs! }))
    .sort((a, b) => a.s - b.s || a.id.localeCompare(b.id));
  const laneFree: number[] = [];
  const burners: Plan['burners'] = [];
  for (const it of stove) {
    let lane = laneFree.findIndex((f) => f <= it.s);
    if (lane < 0) {
      lane = laneFree.length;
      laneFree.push(it.e);
    } else laneFree[lane] = it.e;
    burners.push({ taskId: it.id, startMs: it.s, endMs: it.e, lane });
  }

  const counted = tasks.filter((t) => out[t.id]!.status !== 'skipped');
  return {
    nowMs: input.nowMs,
    originMs: abs(0),
    targetMs: input.targetMs,
    dinnerMs,
    status,
    lateMin,
    tasks: out,
    order,
    recommended,
    next,
    dueCheckpoints,
    overdue,
    warnings,
    exposures,
    oven,
    burners,
    progress: { done: counted.filter((t) => out[t.id]!.status === 'done').length, total: counted.length },
    strategy: best?.label ?? 'none',
  };
}

// ───────────────────────────── Verification ─────────────────────────────

/**
 * Independently re-checks a plan's future: dependencies, no-wait links, minimum durations,
 * burner/oven/cookware capacity, single oven temperature, and cook double-booking (including
 * checkpoints). Used by tests, simulation and runtime diagnostics.
 */
export function verifyPlan(input: PlanInput, p: Plan): string[] {
  const v: string[] = [];
  const { tasks, settings } = input;
  const pt = p.tasks;
  const nowFloor = Math.floor(input.nowMs / MINUTE) * MINUTE;
  for (const t of tasks) {
    const x = pt[t.id]!;
    if (x.status !== 'scheduled') continue;
    if (x.startMs == null || x.endMs == null) {
      v.push(`${t.id}: scheduled without times`);
      continue;
    }
    if (x.startMs < nowFloor) v.push(`${t.id}: planned in the past`);
    const ext = (input.progress[t.id]?.extensions ?? []).reduce((a, e) => a + e.min, 0);
    if ((x.endMs - x.startMs) / MINUTE < t.duration.min + ext) v.push(`${t.id}: planned shorter than its minimum`);
    for (const d of t.deps) {
      const dp = pt[d.id]!;
      if ((dp.status === 'skipped' || dp.status === 'blocked') && d.soft) continue;
      if (dp.status === 'skipped' || dp.status === 'blocked') v.push(`${t.id}: scheduled although prerequisite ${d.id} is ${dp.status}`);
      else if (dp.endMs == null || dp.endMs > x.startMs) v.push(`${t.id}: starts before dependency ${d.id} ends`);
    }
    if (t.follows && pt[t.follows]!.status === 'scheduled' && pt[t.follows]!.endMs !== x.startMs) v.push(`${t.id}: must start right after ${t.follows}`);
  }
  const liveTasks = tasks.filter((t) => pt[t.id]!.status === 'scheduled' || pt[t.id]!.status === 'running');
  const end = Math.max(nowFloor, ...liveTasks.map((t) => pt[t.id]!.endMs ?? nowFloor));
  for (let m = nowFloor; m < end; m += MINUTE) {
    let burners = 0;
    let oven = 0;
    let schedBurner = false;
    const temps = new Set<number>();
    const ware = new Map<string, string>();
    const cookers: string[] = [];
    let runningCook = 0;
    for (const t of liveTasks) {
      const x = pt[t.id]!;
      const inside = m >= Math.max(x.startMs!, nowFloor) && m < x.endMs!;
      if (inside) {
        burners += t.burners ?? 0;
        if (t.burners && x.status === 'scheduled') schedBurner = true;
        if (t.oven) {
          oven += t.oven.slots;
          temps.add(t.oven.tempF);
        }
        for (const c of x.cookware) {
          if (ware.has(c)) v.push(`${c} double-booked (${ware.get(c)} & ${t.id})`);
          ware.set(c, t.id);
        }
      }
      if (x.cook.some(([a, b]) => m >= a && m < b)) {
        if (x.status === 'scheduled') cookers.push(t.id);
        else runningCook++;
      }
    }
    if (cookers.length > 1 || (cookers.length === 1 && runningCook > 0)) v.push(`cook double-booked at ${fmtTime(m)}: ${cookers.join(', ')}`);
    if (burners > settings.burners && schedBurner) v.push(`burners over capacity at ${fmtTime(m)}`);
    if (oven > 2) v.push(`oven over capacity at ${fmtTime(m)}`);
    if (temps.size > 1) v.push(`oven needs two temperatures at ${fmtTime(m)}`);
  }
  return [...new Set(v)];
}
