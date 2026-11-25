/** Time helpers. All instants are epoch milliseconds; all display is America/Chicago. */

export const TIME_ZONE = 'America/Chicago';
export const MINUTE = 60_000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A mutable clock used by simulation and tests. It is the same interface production code uses. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** Convert a wall-clock time in America/Chicago to epoch ms (handles DST via Intl). */
export function chicagoTime(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Offset = wall(guess) - guess; iterate twice for DST edges.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const w = zonedParts(t);
    const wallAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    t = t - (wallAsUtc - guess);
  }
  return t;
}

export const EVENT = {
  year: 2026,
  month: 11,
  day: 26,
} as const;

export const eventAt = (h: number, mi: number): number => chicagoTime(EVENT.year, EVENT.month, EVENT.day, h, mi);

export const DEFAULT_KITCHEN_START = eventAt(8, 0);
export const DEFAULT_TARGET = eventAt(13, 0);
export const ACCEPTABLE_LATE_MIN = 15;
export const DEFAULT_TURKEY_ETA = eventAt(12, 30);

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' });

export function fmtTime(ms: number): string {
  return timeFmt.format(new Date(ms));
}
export function fmtDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}
export function fmtDuration(ms: number): string {
  const neg = ms < 0;
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}
export function fmtMinutes(min: number): string {
  const m = Math.round(min);
  if (Math.abs(m) < 60) return `${m} min`;
  const h = Math.trunc(m / 60);
  const r = Math.abs(m % 60);
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/** "HH:MM" (24h) in Chicago for an instant, for <input type="time">. */
export function toTimeInput(ms: number): string {
  const p = zonedParts(ms);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
/** Parse "HH:MM" on the event day (Chicago) to epoch ms. */
export function fromTimeInput(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return eventAt(h, mi);
}

export function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}
