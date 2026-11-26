/** Environment checks that distinguish "the browser supports it" from "we verified it works here". */
import { audioCapability, audioRunning, wakeLockCapability, wakeLockHeld } from './alarm';

export interface EnvCheck {
  name: string;
  capability: boolean;
  verified: boolean | null; // null = not verifiable automatically
  detail: string;
}

export const BASE = import.meta.env.BASE_URL;

export async function offlineStatus(): Promise<{ ready: boolean; cached: number; total: number; version: string | null; detail: string }> {
  if (!('caches' in window) || !('serviceWorker' in navigator)) return { ready: false, cached: 0, total: 0, version: null, detail: 'Service workers or Cache Storage not supported' };
  try {
    const keys = (await caches.keys()).filter((k) => k.startsWith('tcc-'));
    if (!keys.length) return { ready: false, cached: 0, total: 0, version: null, detail: 'Not cached yet' };
    const name = keys.sort().at(-1)!;
    const cache = await caches.open(name);
    const manRes = await cache.match(`${BASE}asset-manifest.json`, { ignoreVary: true });
    if (!manRes) return { ready: false, cached: 0, total: 0, version: null, detail: 'Cache incomplete (no manifest)' };
    const man = (await manRes.json()) as { version: string; urls: string[] };
    let cached = 0;
    for (const u of man.urls) if (await cache.match(u, { ignoreVary: true })) cached++;
    const ready = cached === man.urls.length && `tcc-${man.version}` === name;
    return { ready, cached, total: man.urls.length, version: man.version, detail: ready ? 'All assets verified in cache' : `${cached}/${man.urls.length} assets cached` };
  } catch (e) {
    return { ready: false, cached: 0, total: 0, version: null, detail: `Cache check failed: ${String(e)}` };
  }
}

export async function envChecks(audioVerifiedByUser: boolean): Promise<EnvCheck[]> {
  const out: EnvCheck[] = [];
  // Storage: really write, read back, delete an isolated key.
  let storageOk = false;
  try {
    const k = 'tcc:diag:probe';
    const v = String(Math.random());
    localStorage.setItem(k, v);
    storageOk = localStorage.getItem(k) === v;
    localStorage.removeItem(k);
  } catch {
    storageOk = false;
  }
  out.push({ name: 'Local storage', capability: typeof localStorage !== 'undefined', verified: storageOk, detail: storageOk ? 'Write/read/delete verified' : 'Could not write — progress will not persist (private mode?)' });
  const swCap = 'serviceWorker' in navigator;
  const reg = swCap ? await navigator.serviceWorker.getRegistration() : undefined;
  out.push({ name: 'Service worker', capability: swCap, verified: !!(reg?.active && navigator.serviceWorker.controller), detail: reg?.active ? (navigator.serviceWorker.controller ? 'Active and controlling this page' : 'Active; reload to let it control the page') : 'Not registered' });
  const off = await offlineStatus();
  out.push({ name: 'Offline cache', capability: 'caches' in window, verified: off.ready, detail: off.detail });
  out.push({
    name: 'Alarm sound',
    capability: audioCapability(),
    verified: audioVerifiedByUser ? true : null,
    detail: audioVerifiedByUser ? 'You confirmed hearing the test sound' : audioRunning() ? 'Audio unlocked — tap Test sound and confirm you heard it' : 'Enable sound and tap Test sound',
  });
  out.push({ name: 'Vibration', capability: 'vibrate' in navigator, verified: null, detail: 'vibrate' in navigator ? 'Supported (not on iPhone Safari)' : 'Not supported in this browser' });
  out.push({ name: 'Screen wake lock', capability: wakeLockCapability(), verified: wakeLockCapability() ? wakeLockHeld() : false, detail: wakeLockHeld() ? 'Currently holding the screen awake' : wakeLockCapability() ? 'Supported; enable it in Settings' : 'Not supported' });
  out.push({ name: 'Background alarms', capability: false, verified: false, detail: 'Web apps cannot reliably alarm in the background or when locked (especially iPhone). Use the Clock app for critical timers.' });
  return out;
}
