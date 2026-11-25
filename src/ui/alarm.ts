/**
 * Foreground alerts only. Browsers (especially iOS Safari) suspend timers and audio when the app
 * is in the background or the screen is locked, so these alarms are NOT reliable then.
 */
let ctx: AudioContext | null = null;

export function audioCapability(): boolean {
  return typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window);
}

/** Must be called from a user gesture at least once (iOS requirement). */
export async function unlockAudio(): Promise<boolean> {
  if (!audioCapability()) return false;
  try {
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
    ctx ??= new AC();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function audioRunning(): boolean {
  return ctx?.state === 'running';
}

export function beep(times = 3): boolean {
  if (!ctx || ctx.state !== 'running') return false;
  const t0 = ctx.currentTime;
  for (let i = 0; i < times; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.35);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + i * 0.35 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.35 + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + i * 0.35);
    o.stop(t0 + i * 0.35 + 0.3);
  }
  return true;
}

export function vibrate(pattern: number[] = [300, 150, 300]): boolean {
  try {
    return typeof navigator !== 'undefined' && 'vibrate' in navigator ? navigator.vibrate(pattern) : false;
  } catch {
    return false;
  }
}

export function wakeLockCapability(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

interface Sentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(t: 'release', cb: () => void): void;
}
let sentinel: Sentinel | null = null;

export async function acquireWakeLock(): Promise<boolean> {
  if (!wakeLockCapability() || document.visibilityState !== 'visible') return false;
  if (sentinel && !sentinel.released) return true;
  try {
    sentinel = (await (navigator as unknown as { wakeLock: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock.request('screen')) ?? null;
    return !!sentinel;
  } catch {
    sentinel = null;
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    await sentinel?.release();
  } catch {
    /* ignore */
  }
  sentinel = null;
}

export function wakeLockHeld(): boolean {
  return !!sentinel && !sentinel.released;
}
