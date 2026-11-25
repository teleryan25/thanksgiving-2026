/**
 * Independent timers. Each timer stores an ABSOLUTE deadline (epoch ms), so its state can be
 * reconstructed after reload, sleep or tab switch. A timer expiring never completes a task.
 */
import { MINUTE } from './time';

export interface Timer {
  id: string;
  taskId?: string;
  checkpointId?: string;
  label: string;
  startMs: number;
  deadlineMs: number;
  cancelledAt?: number;
  cancelReason?: string;
  ackAt?: number;
  /** Total minutes added by the cook. */
  extendedMin: number;
}

export type TimerStatus = 'running' | 'expired' | 'acknowledged' | 'cancelled';

export function timerStatus(t: Timer, now: number): TimerStatus {
  if (t.cancelledAt != null) return 'cancelled';
  if (now < t.deadlineMs) return 'running';
  return t.ackAt != null && t.ackAt >= t.deadlineMs ? 'acknowledged' : 'expired';
}

export function remainingMs(t: Timer, now: number): number {
  return t.deadlineMs - now;
}

export function createTimer(p: { id: string; label: string; startMs: number; minutes: number; taskId?: string; checkpointId?: string }): Timer {
  if (!(p.minutes > 0)) throw new Error('Timer duration must be positive');
  return {
    id: p.id,
    label: p.label,
    startMs: p.startMs,
    deadlineMs: p.startMs + Math.round(p.minutes * MINUTE),
    extendedMin: 0,
    ...(p.taskId ? { taskId: p.taskId } : {}),
    ...(p.checkpointId ? { checkpointId: p.checkpointId } : {}),
  };
}

/** Extend by N minutes. A running timer extends from its deadline; an expired one from now. */
export function extendTimer(t: Timer, minutes: number, now: number): Timer {
  if (!(minutes > 0)) throw new Error('Extension must be positive');
  if (t.cancelledAt != null) return t;
  const from = Math.max(t.deadlineMs, now);
  const { ackAt: _ack, ...rest } = t;
  return { ...rest, deadlineMs: from + Math.round(minutes * MINUTE), extendedMin: t.extendedMin + minutes };
}

export function cancelTimer(t: Timer, now: number, reason = 'cancelled'): Timer {
  if (t.cancelledAt != null) return t;
  return { ...t, cancelledAt: now, cancelReason: reason };
}

/** Acknowledge (silence) an expired timer. Does NOT complete its task. */
export function ackTimer(t: Timer, now: number): Timer {
  if (timerStatus(t, now) !== 'expired') return t;
  return { ...t, ackAt: now };
}

/** Timers whose expiry has not been acknowledged — these should alert. */
export function alertingTimers(ts: Timer[], now: number): Timer[] {
  return ts.filter((t) => timerStatus(t, now) === 'expired').sort((a, b) => a.deadlineMs - b.deadlineMs);
}

export function activeTimers(ts: Timer[], now: number): Timer[] {
  return ts
    .filter((t) => {
      const s = timerStatus(t, now);
      return s === 'running' || s === 'expired';
    })
    .sort((a, b) => a.deadlineMs - b.deadlineMs);
}

export function nextDeadline(ts: Timer[], now: number): number | null {
  const r = ts.filter((t) => timerStatus(t, now) === 'running').map((t) => t.deadlineMs);
  return r.length ? Math.min(...r) : null;
}

export function isTimer(x: unknown): x is Timer {
  if (!x || typeof x !== 'object') return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.label === 'string' &&
    Number.isFinite(t.startMs) &&
    Number.isFinite(t.deadlineMs) &&
    Number.isFinite(t.extendedMin) &&
    (t.taskId === undefined || typeof t.taskId === 'string') &&
    (t.ackAt === undefined || Number.isFinite(t.ackAt)) &&
    (t.cancelledAt === undefined || Number.isFinite(t.cancelledAt))
  );
}
