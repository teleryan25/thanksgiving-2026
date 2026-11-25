import { describe, expect, it } from 'vitest';
import { ackTimer, activeTimers, alertingTimers, cancelTimer, createTimer, extendTimer, isTimer, nextDeadline, remainingMs, timerStatus, type Timer } from '../domain/timers';
import { ManualClock, MINUTE, eventAt } from '../domain/time';

const T0 = eventAt(8, 0);

function four(): Timer[] {
  return [
    createTimer({ id: 'a', label: 'Bread', startMs: T0, minutes: 20, taskId: 'stuffing-dry-bread' }),
    createTimer({ id: 'b', label: 'Garlic', startMs: T0 + 1 * MINUTE, minutes: 45 }),
    createTimer({ id: 'c', label: 'Compote', startMs: T0 + 2 * MINUTE, minutes: 7 }),
    createTimer({ id: 'd', label: 'Custom', startMs: T0 + 3 * MINUTE, minutes: 1.5 }),
  ];
}

describe('timers', () => {
  it('runs four simultaneous timers with independent absolute deadlines', () => {
    const ts = four();
    expect(new Set(ts.map((t) => t.id)).size).toBe(4);
    expect(ts.map((t) => t.deadlineMs - T0)).toEqual([20, 46, 9, 4.5].map((m) => m * MINUTE));
    const clock = new ManualClock(T0 + 5 * MINUTE);
    expect(ts.map((t) => timerStatus(t, clock.now()))).toEqual(['running', 'running', 'running', 'expired']);
    clock.set(T0 + 9 * MINUTE);
    expect(alertingTimers(ts, clock.now()).map((t) => t.id)).toEqual(['d', 'c']);
    expect(nextDeadline(ts, clock.now())).toBe(T0 + 20 * MINUTE);
  });

  it('extends by 1, 5 and custom minutes; running timers extend from deadline, expired from now', () => {
    const [a] = four();
    let t = extendTimer(a!, 1, T0);
    t = extendTimer(t, 5, T0);
    t = extendTimer(t, 2.5, T0);
    expect(t.deadlineMs).toBe(T0 + 28.5 * MINUTE);
    expect(t.extendedMin).toBe(8.5);
    const late = T0 + 40 * MINUTE;
    const e = extendTimer(t, 5, late);
    expect(e.deadlineMs).toBe(late + 5 * MINUTE);
    expect(() => extendTimer(t, 0, T0)).toThrow();
  });

  it('cancel and acknowledge are separate, and neither touches other timers', () => {
    const ts = four();
    const now = T0 + 10 * MINUTE;
    const cancelled = ts.map((t) => (t.id === 'b' ? cancelTimer(t, now) : t));
    expect(cancelled.map((t) => timerStatus(t, now))).toEqual(['running', 'cancelled', 'expired', 'expired']);
    const acked = cancelled.map((t) => (t.id === 'c' ? ackTimer(t, now) : t));
    expect(acked.map((t) => timerStatus(t, now))).toEqual(['running', 'cancelled', 'acknowledged', 'expired']);
    // ack on a running timer is a no-op
    expect(ackTimer(ts[0]!, now)).toBe(ts[0]);
    expect(activeTimers(acked, now).map((t) => t.id)).toEqual(['d', 'a']);
  });

  it('reconstructs after refresh / closed app: expired timers stay expired and never restart', () => {
    const ts = four();
    const json = JSON.stringify(ts);
    // App closed for 30 minutes.
    const restored: unknown[] = JSON.parse(json);
    expect(restored.every(isTimer)).toBe(true);
    const now = T0 + 30 * MINUTE;
    const statuses = (restored as Timer[]).map((t) => timerStatus(t, now));
    expect(statuses).toEqual(['expired', 'running', 'expired', 'expired']);
    expect(remainingMs((restored as Timer[])[0]!, now)).toBe(-10 * MINUTE);
    // Re-reading later keeps the same deadline (no restart from reload time).
    expect((restored as Timer[])[1]!.deadlineMs).toBe(T0 + 46 * MINUTE);
  });

  it('timer state depends only on the clock (tab switch / sleep independent)', () => {
    const t = createTimer({ id: 'x', label: 'x', startMs: T0, minutes: 10 });
    // Simulate a sleeping device: no ticks for 2 hours. Status computed on wake.
    expect(timerStatus(t, T0 + 120 * MINUTE)).toBe('expired');
    expect(timerStatus(t, T0 + 9 * MINUTE)).toBe('running');
  });

  it('rejects malformed timers', () => {
    expect(isTimer({ id: 'x', label: 'y', startMs: 'a', deadlineMs: 1, extendedMin: 0 })).toBe(false);
    expect(() => createTimer({ id: 'x', label: 'y', startMs: T0, minutes: -1 })).toThrow();
  });
});
