import { useEffect, useState, type ReactNode } from 'react';
import { renderStep } from '../domain/audit';
import type { TaskDef } from '../domain/model';
import { DISHES, TASKS, COOKWARE } from '../domain/recipes';
import type { Plan, PlannedTask } from '../domain/scheduler';
import type { Action } from '../domain/state';
import { MINUTE, fmtDuration, fmtMinutes, fmtTime } from '../domain/time';
import { remainingMs, timerStatus, type Timer } from '../domain/timers';

export const taskDef = (id: string): TaskDef => TASKS.find((t) => t.id === id)!;
export const dishName = (id: string) => (id === 'kitchen' ? 'Oven' : (DISHES.find((d) => d.id === id)?.short ?? id));
export const cookwareName = (id: string) => COOKWARE.find((c) => c.id === id)?.name ?? id;

export type Dispatch = (a: Action) => { ok: boolean; message?: string };

export function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose} data-testid={testId}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 className="grow" style={{ margin: 0 }}>
            {title}
          </h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const ATTENTION: Record<TaskDef['attention'], [string, string]> = {
  active: ['Hands-on', 'terra'],
  passive: ['Hands-off', 'sage'],
  periodic: ['Check-ins', 'amber'],
  external: ['Waiting', ''],
};

export function TaskHeader({ def, pt }: { def: TaskDef; pt?: PlannedTask | undefined }) {
  const [label, cls] = ATTENTION[def.attention];
  return (
    <>
      <div className="row">
        <span className="chip dark">{dishName(def.dish)}</span>
        <span className={`chip ${cls}`}>{label}</span>
        {def.safety && <span className="chip terra">🌡 {def.safety.tempF}°F</span>}
        {pt?.status === 'running' && <span className="chip sage">In progress</span>}
        {pt?.status === 'done' && <span className="chip sage">Done ✓</span>}
        {pt?.status === 'skipped' && <span className="chip">Skipped</span>}
        {pt?.status === 'blocked' && <span className="chip terra">Blocked</span>}
      </div>
      <div className="task-title">{def.title}</div>
    </>
  );
}

export function TaskMeta({ def, pt }: { def: TaskDef; pt?: PlannedTask | undefined }) {
  const d = def.duration;
  return (
    <div className="meta">
      <div>
        <span>Time</span>
        {d.min === d.max ? fmtMinutes(d.min) : `${d.min}–${d.max} min`}
      </div>
      {def.heat && (
        <div>
          <span>Heat</span>
          {def.heat}
        </div>
      )}
      {pt?.startMs != null && pt.status !== 'skipped' && (
        <div>
          <span>{pt.status === 'done' ? 'Done' : pt.status === 'running' ? 'Started' : 'Planned'}</span>
          <b className="num">{pt.status === 'done' ? fmtTime(pt.endMs!) : `${fmtTime(pt.startMs)}–${fmtTime(pt.endMs!)}`}</b>
        </div>
      )}
      {pt?.cookware.length ? (
        <div>
          <span>Using</span>
          {pt.cookware.map(cookwareName).join(', ')}
        </div>
      ) : null}
      {pt?.rack != null && (
        <div>
          <span>Oven rack</span>
          {pt.rack === 'both' ? 'Both racks' : pt.rack === 0 ? 'Upper' : 'Lower'}
        </div>
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <span>Equipment</span>
        {def.equipment.join(' · ') || '—'}
      </div>
    </div>
  );
}

/** Exact canonical instructions with expandable technique hints. */
export function TaskSteps({ def, compact = false }: { def: TaskDef; compact?: boolean }) {
  return (
    <>
      <ol className="steps">
        {def.steps.map((s, i) => (
          <li key={i}>
            {renderStep(s)}
            {s.hint && (
              <details>
                <summary>Technique help</summary>
                <div className="hint">{s.hint}</div>
              </details>
            )}
          </li>
        ))}
      </ol>
      {!compact && def.cues.length > 0 && (
        <div className="card ok" style={{ padding: 10 }}>
          <b>Done when:</b>
          <ul className="plain">
            {def.cues.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {!compact && def.troubleshooting.length > 0 && (
        <details>
          <summary>Troubleshooting</summary>
          <ul className="plain">
            {def.troubleshooting.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function TimerCard({ t, now, dispatch, quiet }: { t: Timer; now: number; dispatch: Dispatch; quiet?: boolean }) {
  const st = timerStatus(t, now);
  const [custom, setCustom] = useState('');
  const rem = remainingMs(t, now);
  return (
    <div className={`card timer ${st === 'expired' ? 'expired alert' : ''}`} data-testid={`timer-${t.id}`} data-status={st}>
      <div>
        <div style={{ fontWeight: 600 }}>{t.label}</div>
        <div className="small muted">
          {st === 'expired' ? `Expired at ${fmtTime(t.deadlineMs)} — check it; the timer does not mark anything done.` : `Ends ${fmtTime(t.deadlineMs)}`}
          {t.extendedMin > 0 && ` · extended ${t.extendedMin} min`}
        </div>
      </div>
      <div className="left" aria-live="polite">
        {st === 'expired' ? `+${fmtDuration(-rem)}` : fmtDuration(rem)}
      </div>
      {!quiet && (
        <div className="btns" style={{ gridColumn: '1 / -1', marginTop: 0 }}>
          {st === 'expired' && (
            <button className="btn terra" onClick={() => dispatch({ type: 'timer/ack', timerId: t.id })}>
              Acknowledge
            </button>
          )}
          <button className="btn small" onClick={() => dispatch({ type: 'timer/extend', timerId: t.id, min: 1 })}>
            +1 min
          </button>
          <button className="btn small" onClick={() => dispatch({ type: 'timer/extend', timerId: t.id, min: 5 })}>
            +5 min
          </button>
          <input
            aria-label="Custom minutes"
            inputMode="numeric"
            style={{ width: 64, minHeight: 40, borderRadius: 10, border: '1px solid var(--line)', padding: '0 8px' }}
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="min"
          />
          <button
            className="btn small"
            disabled={!(Number(custom) > 0)}
            onClick={() => {
              dispatch({ type: 'timer/extend', timerId: t.id, min: Number(custom) });
              setCustom('');
            }}
          >
            +custom
          </button>
          <button className="btn small" onClick={() => dispatch({ type: 'timer/cancel', timerId: t.id })}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Task actions with confirmations ─────────────────────────

type Dialog =
  | { kind: 'complete' }
  | { kind: 'skip' }
  | { kind: 'force-start'; blockers: string[] }
  | { kind: 'blocked'; blockers: string[] }
  | null;

export function TaskActions({ def, plan, now, dispatch, toast }: { def: TaskDef; plan: Plan; now: number; dispatch: Dispatch; toast: (m: string) => void }) {
  const pt = plan.tasks[def.id]!;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [safetyOk, setSafetyOk] = useState(false);
  const [earlyOk, setEarlyOk] = useState(false);
  const [unsafeOk, setUnsafeOk] = useState(false);
  const [customExt, setCustomExt] = useState('');
  const run = (a: Action) => {
    const r = dispatch(a);
    if (r.message) toast(r.message);
    return r.ok;
  };
  const close = () => {
    setDialog(null);
    setSafetyOk(false);
    setEarlyOk(false);
    setUnsafeOk(false);
  };

  const startClick = () => {
    if (def.attention === 'external') return setDialog({ kind: 'complete' });
    if (pt.startableNow && def.timing === 'jit' && pt.startMs != null && pt.startMs > now + 10 * MINUTE) return setDialog({ kind: 'force-start', blockers: [] });
    if (pt.startableNow) return run({ type: 'start', taskId: def.id, cookware: pt.cookware });
    const deps = pt.blockers.filter((b) => b.startsWith('Waiting for') || b.startsWith('Prerequisite'));
    if (deps.length || pt.status === 'blocked') return setDialog({ kind: 'blocked', blockers: pt.blockers });
    return setDialog({ kind: 'force-start', blockers: pt.blockers });
  };

  const early = pt.status === 'running' && def.enforceMin && pt.minEndMs != null && now < pt.minEndMs;
  const openCps = pt.checkpoints.filter((c) => !c.done);
  const dependents = TASKS.filter((t) => t.deps.some((d) => d.id === def.id && !d.soft));
  const needsUnsafe = !!(def.critical || def.safety);

  if (pt.status === 'done' || pt.status === 'skipped') return null;
  return (
    <>
      <div className="btns">
        {pt.status === 'running' ? (
          <button className="btn big sage" onClick={() => setDialog({ kind: 'complete' })} data-testid="btn-complete">
            ✓ Done
          </button>
        ) : (
          <button className="btn big primary" onClick={startClick} disabled={pt.status === 'blocked'} data-testid="btn-start">
            {def.attention === 'external' ? 'Mark arrived' : '▶ Start'}
          </button>
        )}
        {pt.status === 'running' &&
          (def.extendOptions ?? [5]).map((m) => (
            <button key={m} className="btn" onClick={() => run({ type: 'extend', taskId: def.id, min: m })} data-testid={`btn-extend-${m}`}>
              +{m} min
            </button>
          ))}
        {pt.status === 'running' && (
          <span className="row" style={{ gap: 4 }}>
            <input
              aria-label="Extend minutes"
              inputMode="numeric"
              style={{ width: 60, minHeight: 48, borderRadius: 10, border: '1px solid var(--line)', padding: '0 8px' }}
              value={customExt}
              placeholder="min"
              onChange={(e) => setCustomExt(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <button
              className="btn"
              disabled={!(Number(customExt) > 0)}
              onClick={() => {
                run({ type: 'extend', taskId: def.id, min: Number(customExt) });
                setCustomExt('');
              }}
            >
              Extend
            </button>
          </span>
        )}
        {pt.status !== 'running' && def.attention !== 'external' && (
          <>
            <button className="btn" onClick={() => run({ type: 'delay', taskId: def.id, min: 5 })} data-testid="btn-delay">
              Delay 5
            </button>
            <button className="btn" onClick={() => run({ type: 'delay', taskId: def.id, min: 15 })}>
              Delay 15
            </button>
          </>
        )}
        <button className="btn" onClick={() => setDialog({ kind: 'skip' })} data-testid="btn-skip">
          Skip…
        </button>
      </div>

      {dialog?.kind === 'complete' && (
        <Sheet title={def.attention === 'external' ? 'Mark arrived?' : `Finish: ${def.title}`} onClose={close} testId="dlg-complete">
          {def.cues.length > 0 && (
            <div className="card ok">
              <b>Check the doneness cues — the timer alone never means done:</b>
              <ul className="plain">
                {def.cues.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {(def.safety || def.confirm) && (
            <label className="check">
              <input type="checkbox" checked={safetyOk} onChange={(e) => setSafetyOk(e.target.checked)} data-testid="chk-safety" />
              <span className="lbl">
                <b>{def.safety ? `I measured ${def.safety.what} at ${def.safety.tempF}°F or higher with a thermometer.` : `${def.confirm}.`}</b>
              </span>
            </label>
          )}
          {early && (
            <label className="check">
              <input type="checkbox" checked={earlyOk} onChange={(e) => setEarlyOk(e.target.checked)} data-testid="chk-early" />
              <span className="lbl">
                Only {Math.max(0, Math.round((now - pt.startMs!) / MINUTE))} of the {def.duration.min}-minute minimum has passed. I checked the doneness cues and it really is done.
              </span>
            </label>
          )}
          {openCps.length > 0 && <div className="card warn small">Not recorded: {openCps.map((c) => c.label).join(', ')}. Make sure those were done.</div>}
          <div className="btns">
            <button
              className="btn big sage"
              data-testid="btn-confirm-complete"
              disabled={(!!(def.safety || def.confirm) && !safetyOk) || (early && !earlyOk)}
              onClick={() => {
                if (run({ type: 'complete', taskId: def.id, safetyConfirmed: safetyOk, earlyConfirmed: earlyOk })) close();
              }}
            >
              Confirm done
            </button>
            <button className="btn big" onClick={close}>
              Not yet
            </button>
          </div>
        </Sheet>
      )}

      {dialog?.kind === 'skip' && (
        <Sheet title={`Skip: ${def.title}?`} onClose={close} testId="dlg-skip">
          {dependents.length > 0 && (
            <div className="card warn">
              These stay <b>blocked</b> after skipping — nothing is unlocked automatically: {dependents.map((t) => t.title).join(', ')}. Skip them too or mark this done
              another way.
            </div>
          )}
          {needsUnsafe && (
            <label className="check">
              <input type="checkbox" checked={unsafeOk} onChange={(e) => setUnsafeOk(e.target.checked)} data-testid="chk-unsafe" />
              <span className="lbl">
                <b>This is a {def.safety ? 'food-safety' : 'critical'} step.</b> I understand skipping it may be unsafe and I take responsibility.
              </span>
            </label>
          )}
          <div className="btns">
            <button
              className="btn big terra"
              data-testid="btn-confirm-skip"
              disabled={needsUnsafe && !unsafeOk}
              onClick={() => {
                if (run({ type: 'skip', taskId: def.id, unsafeConfirmed: unsafeOk })) close();
              }}
            >
              Skip it
            </button>
            <button className="btn big" onClick={close}>
              Keep it
            </button>
          </div>
        </Sheet>
      )}

      {dialog?.kind === 'blocked' && (
        <Sheet title="Can't start yet" onClose={close} testId="dlg-blocked">
          <ul className="plain">
            {dialog.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="muted">Prerequisites are never unlocked silently. Finish (or deliberately skip) them first.</p>
          <button className="btn big" onClick={close}>
            OK
          </button>
        </Sheet>
      )}

      {dialog?.kind === 'force-start' && (
        <Sheet title="Start anyway?" onClose={close} testId="dlg-force">
          <p>The plan says this shouldn't start right now:</p>
          <ul className="plain">
            {dialog.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {dialog.blockers.length === 0 && <p className="muted">It is planned for {pt.startMs ? fmtTime(pt.startMs) : 'later'}; starting now may finish hot food too early.</p>}
          <div className="btns">
            <button
              className="btn big primary"
              onClick={() => {
                if (run({ type: 'start', taskId: def.id, cookware: pt.cookware })) close();
              }}
              data-testid="btn-confirm-force"
            >
              Start anyway
            </button>
            <button className="btn big" onClick={close}>
              Wait
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
