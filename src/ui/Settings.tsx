import { useEffect, useState } from 'react';
import type { DiagReport } from '../domain/diagnostics';
import { COOKWARE } from '../domain/recipes';
import type { Plan } from '../domain/scheduler';
import { derive, describeEvent, type CookState } from '../domain/state';
import { fmtTime, fromTimeInput, toTimeInput } from '../domain/time';
import { beep, unlockAudio, vibrate } from './alarm';
import { Sheet, type Dispatch } from './common';
import { envChecks, offlineStatus, type EnvCheck } from './env';

interface Props {
  state: CookState;
  plan: Plan | null;
  dispatch: Dispatch;
  toast: (m: string) => void;
  onClose: () => void;
  mode: 'live' | 'sim';
  setMode: (m: 'live' | 'sim') => void;
  runDiag: (full: boolean) => Promise<DiagReport>;
  updateReady: boolean;
  applyUpdate: () => void;
  audioVerified: boolean;
  setAudioVerified: (v: boolean) => void;
}

export function SettingsSheet(props: Props) {
  const { state, dispatch, toast, onClose, mode, setMode } = props;
  const d = derive(state.events);
  const s = state.settings;
  const [confirmReset, setConfirmReset] = useState<null | 'progress' | 'all'>(null);
  const [report, setReport] = useState<DiagReport | null>(null);
  const [running, setRunning] = useState(false);
  const [env, setEnv] = useState<EnvCheck[]>([]);
  const [offline, setOffline] = useState<string>('checking…');
  const [heardPrompt, setHeardPrompt] = useState(false);

  useEffect(() => {
    void offlineStatus().then((o) => setOffline(o.ready ? `✓ Offline-ready (${o.cached}/${o.total} files cached, v${o.version})` : `Not offline-ready yet: ${o.detail}`));
  }, []);

  const setTime = (type: 'setTarget' | 'setTurkeyEta' | 'setKitchenStart', v: string) => {
    const ms = fromTimeInput(v);
    if (ms != null) dispatch({ type, ms });
  };
  const turkeyArrived = props.plan?.tasks['turkey-arrive']?.status === 'done';

  return (
    <Sheet title="Settings" onClose={onClose} testId="settings">
      <h3>Dinner</h3>
      <label className="field">
        Dinner target (Thu Nov 26)
        <input type="time" value={toTimeInput(d.targetMs)} onChange={(e) => setTime('setTarget', e.target.value)} data-testid="input-target" />
      </label>
      <label className="field">
        Kitchen start
        <input type="time" value={toTimeInput(d.kitchenStartMs)} onChange={(e) => setTime('setKitchenStart', e.target.value)} data-testid="input-start" />
      </label>

      <h3>Turkey (Devin)</h3>
      <label className="field">
        Turkey ETA
        <input type="time" value={toTimeInput(d.turkeyEtaMs)} onChange={(e) => setTime('setTurkeyEta', e.target.value)} data-testid="input-turkey" />
      </label>
      <div className="row">
        <span className="grow">{turkeyArrived ? '✓ Turkey has arrived' : `Expected ${fmtTime(d.turkeyEtaMs)}`}</span>
        {!turkeyArrived && (
          <button className="btn" data-testid="btn-turkey-arrived" onClick={() => toast(dispatch({ type: 'complete', taskId: 'turkey-arrive' }).message ?? 'Turkey arrived — check it reads 165°F.')}>
            Turkey arrived
          </button>
        )}
      </div>
      <label className="switch">
        <span>Devin (or a helper) carves the turkey</span>
        <input type="checkbox" checked={s.helperCarvesTurkey} onChange={(e) => dispatch({ type: 'settings', patch: { helperCarvesTurkey: e.target.checked } })} />
      </label>

      <h3>Kitchen equipment</h3>
      <div className="switch">
        <span>Burners</span>
        <span className="row">
          <button className="btn small" aria-label="Fewer burners" onClick={() => dispatch({ type: 'settings', patch: { burners: Math.max(1, s.burners - 1) } })}>
            −
          </button>
          <b className="num" data-testid="burners">
            {s.burners}
          </b>
          <button className="btn small" aria-label="More burners" onClick={() => dispatch({ type: 'settings', patch: { burners: Math.min(8, s.burners + 1) } })}>
            +
          </button>
        </span>
      </div>
      {COOKWARE.map((c) => (
        <label key={c.id} className="switch">
          <span>
            {c.name}
            {c.note && <div className="small muted">{c.note}</div>}
          </span>
          <input type="checkbox" checked={s.cookware[c.id] !== false} onChange={(e) => dispatch({ type: 'settings', patch: { cookware: { [c.id]: e.target.checked } } })} />
        </label>
      ))}
      <label className="switch">
        <span>Kitchen above 90°F (1-hour food safety limit)</span>
        <input type="checkbox" checked={s.hotRoom} onChange={(e) => dispatch({ type: 'settings', patch: { hotRoom: e.target.checked } })} />
      </label>

      <h3>Alerts</h3>
      <div className="card warn small">
        Alarms only work while this app is open and on screen. iPhone suspends web apps in the background and when locked — <b>set a backup timer in the Clock app for anything critical</b>.
      </div>
      <label className="switch">
        <span>Alarm sound {mode === 'sim' && <span className="small muted">(in simulation too)</span>}</span>
        <input
          type="checkbox"
          checked={s.sound}
          data-testid="chk-sound"
          onChange={async (e) => {
            const on = e.target.checked;
            if (on) await unlockAudio();
            dispatch({ type: 'settings', patch: { sound: on } });
          }}
        />
      </label>
      <div className="row" style={{ margin: '8px 0' }}>
        <button
          className="btn"
          data-testid="btn-test-sound"
          onClick={async () => {
            const ok = (await unlockAudio()) && beep(3);
            if (!ok) toast('This browser blocked audio. Check the silent switch and volume.');
            else setHeardPrompt(true);
          }}
        >
          🔔 Test sound
        </button>
        {heardPrompt && (
          <>
            <button
              className="btn sage"
              onClick={() => {
                props.setAudioVerified(true);
                setHeardPrompt(false);
              }}
            >
              I heard it
            </button>
            <button
              className="btn"
              onClick={() => {
                props.setAudioVerified(false);
                setHeardPrompt(false);
                toast('Check the ring/silent switch and media volume, then try again.');
              }}
            >
              Didn&apos;t hear it
            </button>
          </>
        )}
        {props.audioVerified && <span className="chip sage">Sound verified</span>}
      </div>
      <label className="switch">
        <span>Vibrate on alarm (Android)</span>
        <input
          type="checkbox"
          checked={s.vibration}
          onChange={(e) => {
            if (e.target.checked) vibrate([100]);
            dispatch({ type: 'settings', patch: { vibration: e.target.checked } });
          }}
        />
      </label>
      <label className="switch">
        <span>Keep screen awake while cooking</span>
        <input type="checkbox" checked={s.wakeLock} onChange={(e) => dispatch({ type: 'settings', patch: { wakeLock: e.target.checked } })} />
      </label>

      <h3>Offline</h3>
      <p data-testid="offline-status">{offline}</p>
      {props.updateReady && (
        <div className="card warn">
          A new version is downloaded. It will NOT switch automatically during cooking.{' '}
          <button className="btn small" onClick={props.applyUpdate}>
            Update now
          </button>
        </div>
      )}

      <h3>Simulation</h3>
      <p className="small muted">Rehearse the day on a virtual clock starting Thu 8:00 AM. Separate storage — your real progress is never touched.</p>
      {mode === 'live' ? (
        <button
          className="btn primary"
          data-testid="btn-enter-sim"
          onClick={() => {
            setMode('sim');
            onClose();
          }}
        >
          Enter simulation
        </button>
      ) : (
        <button
          className="btn primary"
          data-testid="btn-exit-sim"
          onClick={() => {
            setMode('live');
            onClose();
          }}
        >
          Return to live
        </button>
      )}

      <h3>Diagnostics</h3>
      <div className="btns">
        <button
          className="btn"
          disabled={running}
          data-testid="btn-diag"
          onClick={async () => {
            setRunning(true);
            const [r, e] = await Promise.all([props.runDiag(false), envChecks(props.audioVerified)]);
            setReport(r);
            setEnv(e);
            setRunning(false);
          }}
        >
          {running ? 'Running…' : 'Run diagnostics'}
        </button>
        <button
          className="btn"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            const [r, e] = await Promise.all([props.runDiag(true), envChecks(props.audioVerified)]);
            setReport(r);
            setEnv(e);
            setRunning(false);
          }}
        >
          + full simulation (slow)
        </button>
      </div>
      {report && (
        <div className="card" data-testid="diag-report">
          <b>
            {report.passed} passed, {report.failed} failed
          </b>
          <div className="small muted">
            {new Date(report.ranAt).toLocaleString()} · data v{report.version} · build {__BUILD_TIME__}
          </div>
          <table className="simple">
            <tbody>
              {report.results.map((r) => (
                <tr key={r.name}>
                  <td className={r.pass ? 'diag-pass' : 'diag-fail'}>{r.pass ? 'PASS' : 'FAIL'}</td>
                  <td>
                    {r.name}
                    <div className="small muted">
                      expected {r.expected} · actual {r.actual} · {r.ms} ms{r.details ? ` · ${r.details}` : ''}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>This device</h4>
          <table className="simple">
            <tbody>
              {env.map((c) => (
                <tr key={c.name}>
                  <td className={c.verified ? 'diag-pass' : c.verified === null ? 'diag-info' : 'diag-fail'}>{c.verified ? 'VERIFIED' : c.verified === null ? (c.capability ? 'CAPABLE' : 'N/A') : c.capability ? 'NOT YET' : 'NO'}</td>
                  <td>
                    {c.name}
                    <div className="small muted">{c.detail}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>History</h3>
      <div className="card small" style={{ maxHeight: 220, overflowY: 'auto' }} data-testid="history">
        {state.events.length === 0 && <p className="muted">No actions yet.</p>}
        {[...state.events].reverse().map((e) => (
          <div key={e.id}>
            <span className="num">{fmtTime(e.at)}</span> {describeEvent(e)}
          </div>
        ))}
        {state.undone.length > 0 && <p className="muted">Undone: {state.undone.length} action(s)</p>}
      </div>

      <h3>Reset {mode === 'sim' ? 'simulation' : ''}</h3>
      <div className="btns">
        <button className="btn" onClick={() => setConfirmReset('progress')} data-testid="btn-reset-progress">
          Reset cooking progress…
        </button>
        <button className="btn terra" onClick={() => setConfirmReset('all')}>
          Reset everything…
        </button>
      </div>
      {confirmReset && (
        <div className="card alert" data-testid="confirm-reset">
          <b>{confirmReset === 'progress' ? 'Clear all task progress and timers? Shopping checks and settings stay.' : 'Clear progress, timers, shopping checks and settings?'}</b>
          <p className="small">This cannot be undone. It only clears this {mode === 'sim' ? 'simulation' : 'live'} data.</p>
          <div className="btns">
            <button
              className="btn terra"
              data-testid="btn-confirm-reset"
              onClick={() => {
                const r = dispatch({ type: 'reset', scope: confirmReset });
                setConfirmReset(null);
                if (r.message) toast(r.message);
              }}
            >
              Yes, reset
            </button>
            <button className="btn" onClick={() => setConfirmReset(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
