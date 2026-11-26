import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { baselineInput } from '../domain/fixtures';
import { DATA_VERSION } from '../domain/recipes';
import type { Plan } from '../domain/scheduler';
import { derive } from '../domain/state';
import { KEYS } from '../domain/storage';
import { fmtTime } from '../domain/time';
import { alertingTimers } from '../domain/timers';
import { acquireWakeLock, beep, releaseWakeLock, vibrate } from './alarm';
import { CookTab } from './CookTab';
import { readMode, safeStorage, useCookStore, usePlan, type Mode } from './hooks';
import { PrintCookbook, RecipesTab } from './RecipesTab';
import { SettingsSheet } from './Settings';
import { ShoppingTab } from './ShoppingTab';
import { SimBar } from './SimBar';
import { TimelineTab } from './TimelineTab';
import { diagAsync, planAsync } from './workerClient';

type Tab = 'cook' | 'timeline' | 'recipes' | 'shopping';
const TABS: [Tab, string, string][] = [
  ['cook', 'Cook', '🍳'],
  ['timeline', 'Timeline', '🕑'],
  ['recipes', 'Recipes', '📖'],
  ['shopping', 'Shopping', '🛒'],
];

export function App({ swUpdate }: { swUpdate: { ready: boolean; apply: () => void; subscribe: (cb: () => void) => () => void } }) {
  const kv = useMemo(() => safeStorage(), []);
  const [mode, setModeState] = useState<Mode>(() => readMode(kv));
  const setMode = useCallback(
    (m: Mode) => {
      kv.setItem(KEYS.mode, m);
      setModeState(m);
    },
    [kv],
  );
  const store = useCookStore(kv, mode);
  const { state, now, dispatch } = store;
  const { plan } = usePlan(state, now);
  const [tab, setTab] = useState<Tab>('cook');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Plan | null>(null);
  const [audioVerified, setAudioVerified] = useState(false);
  const [, force] = useState(0);
  const toastTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((m: string) => {
    if (!m) return;
    setToastMsg(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 4500);
  }, []);

  useEffect(() => swUpdate.subscribe(() => force((x) => x + 1)), [swUpdate]);

  // Baseline schedule for the printable cookbook (computed off the main thread).
  useEffect(() => {
    void planAsync(baselineInput()).then(setBaseline);
  }, []);

  // Foreground alarms: beep/vibrate while any timer is expired and unacknowledged.
  const alerting = alertingTimers(state.timers, now);
  const alertKey = alerting.map((t) => t.id).join(',');
  useEffect(() => {
    if (!alertKey) return;
    const fire = () => {
      if (document.visibilityState !== 'visible') return;
      if (state.settings.sound) beep(3);
      if (state.settings.vibration) vibrate();
    };
    fire();
    const id = window.setInterval(fire, 4000);
    return () => window.clearInterval(id);
  }, [alertKey, state.settings.sound, state.settings.vibration]);

  // Wake lock: (re)acquire when enabled and visible.
  useEffect(() => {
    if (!state.settings.wakeLock) {
      void releaseWakeLock();
      return;
    }
    void acquireWakeLock();
    const vis = () => document.visibilityState === 'visible' && void acquireWakeLock();
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [state.settings.wakeLock]);

  const d = derive(state.events);
  const statusClass = plan ? `status-${plan.status}` : '';
  const pct = plan ? Math.round((plan.progress.done / Math.max(1, plan.progress.total)) * 100) : 0;

  return (
    <div className="app">
      {mode === 'sim' && <SimBar state={state} plan={plan} now={now} dispatch={dispatch} toast={toast} exit={() => setMode('live')} />}
      <header className={`top no-print ${statusClass}`}>
        <div className="top-row">
          <div className="clock" data-testid="clock">
            {fmtTime(now)}
          </div>
          <div className="spacer" />
          <button className="icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)} data-testid="btn-settings">
            ⚙
          </button>
        </div>
        <div className="top-stats">
          <span>
            Target <b className="num">{fmtTime(d.targetMs)}</b>
          </span>
          <span data-testid="projected">
            Dinner <b className="num proj">{plan?.dinnerMs ? fmtTime(plan.dinnerMs) : '…'}</b>{' '}
            {plan && (plan.status === 'on-target' ? 'on target' : plan.status === 'acceptable' ? `+${plan.lateMin} min` : plan.status === 'late' ? `${plan.lateMin} min late` : 'blocked')}
          </span>
          <span>
            Done <b className="num">{plan ? `${plan.progress.done}/${plan.progress.total}` : '…'}</b>
          </span>
        </div>
        <div className="progress" aria-label={`${pct}% complete`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      </header>

      {store.notices.map((n, i) => (
        <div key={i} className="card warn no-print" style={{ margin: '10px 14px' }} role="alert">
          {n}{' '}
          <button className="btn small" onClick={() => store.dismissNotice(i)}>
            OK
          </button>
        </div>
      ))}
      {!store.saveOk && (
        <div className="card alert no-print" style={{ margin: '10px 14px' }}>
          Progress could not be saved on this device (storage full or private browsing). Keep this tab open.
        </div>
      )}

      <main>
        {!plan ? (
          <div className="card" data-testid="planning">
            Planning…
          </div>
        ) : tab === 'cook' ? (
          <CookTab plan={plan} state={state} now={now} dispatch={dispatch} toast={toast} paused={d.paused} mode={mode} />
        ) : tab === 'timeline' ? (
          <TimelineTab plan={plan} now={now} dispatch={dispatch} toast={toast} />
        ) : tab === 'recipes' ? (
          <RecipesTab checks={state.recipeChecks} dispatch={dispatch} />
        ) : (
          <ShoppingTab checks={state.shopping} dispatch={dispatch} />
        )}
      </main>

      <PrintCookbook baseline={baseline} />

      <nav className="tabs no-print" role="tablist">
        {TABS.map(([id, label, ico]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`tab-${id}`}>
            <span className="ico" aria-hidden>
              {ico}
            </span>
            {label}
            {id === 'cook' && alerting.length > 0 && <span className="chip terra">{alerting.length}</span>}
          </button>
        ))}
      </nav>

      {toastMsg && (
        <div className="toast no-print" role="status" data-testid="toast" onClick={() => setToastMsg(null)}>
          {toastMsg}
        </div>
      )}

      {settingsOpen && (
        <SettingsSheet
          state={state}
          plan={plan}
          dispatch={dispatch}
          toast={toast}
          onClose={() => setSettingsOpen(false)}
          mode={mode}
          setMode={setMode}
          runDiag={(full) => diagAsync(full, DATA_VERSION)}
          updateReady={swUpdate.ready}
          applyUpdate={swUpdate.apply}
          audioVerified={audioVerified}
          setAudioVerified={setAudioVerified}
        />
      )}
    </div>
  );
}
