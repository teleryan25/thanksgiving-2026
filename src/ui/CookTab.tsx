import { useState } from 'react';
import type { Plan } from '../domain/scheduler';
import type { CookState } from '../domain/state';
import { DEFAULT_KITCHEN_START, MINUTE, fmtDay, fmtDuration, fmtMinutes, fmtTime } from '../domain/time';
import { activeTimers } from '../domain/timers';
import { Sheet, TaskActions, TaskHeader, TaskMeta, TaskSteps, TimerCard, dishName, taskDef, type Dispatch } from './common';

interface Props {
  plan: Plan;
  state: CookState;
  now: number;
  dispatch: Dispatch;
  toast: (m: string) => void;
  paused: boolean;
  mode: 'live' | 'sim';
}

export function CookTab({ plan, state, now, dispatch, toast, paused, mode }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [newTimer, setNewTimer] = useState({ label: '', min: '' });
  const timers = activeTimers(state.timers, now);
  const running = plan.order.filter((id) => plan.tasks[id]!.status === 'running');
  const focusId = plan.recommended ?? running.find((id) => taskDef(id).attention === 'active') ?? null;
  const upcoming = plan.order.filter((id) => plan.tasks[id]!.status === 'scheduled' && id !== focusId).slice(0, 6);
  const beforeEvent = mode === 'live' && now < DEFAULT_KITCHEN_START - 30 * MINUTE && state.events.length === 0;
  const startable = plan.order.filter((id) => plan.tasks[id]!.startableNow);

  return (
    <div className="cook-grid">
      <div>
        {beforeEvent && (
          <div className="card warn" data-testid="before-event">
            <b>Cooking starts {fmtDay(DEFAULT_KITCHEN_START)} at {fmtTime(DEFAULT_KITCHEN_START)}</b> — in {fmtMinutes((DEFAULT_KITCHEN_START - now) / MINUTE)}. The plan below is ready. Rehearse with
            Simulation in Settings (⚙).
          </div>
        )}
        {paused && (
          <div className="card warn">
            <b>Guidance paused.</b> Timers keep running. The plan assumes you are not working.{' '}
            <button className="btn small" onClick={() => dispatch({ type: 'resume' })}>
              Resume
            </button>
          </div>
        )}

        {timers
          .filter((t) => now >= t.deadlineMs)
          .map((t) => (
            <TimerCard key={t.id} t={t} now={now} dispatch={dispatch} />
          ))}

        {plan.dueCheckpoints.map((c) => (
          <div key={`${c.taskId}-${c.id}`} className="card alert" data-testid="checkpoint-due">
            <div className="row">
              <span className="chip terra">Check-in due {fmtTime(c.atMs)}</span>
              <span className="chip">{dishName(taskDef(c.taskId).dish)}</span>
            </div>
            <h3 style={{ marginTop: 8 }}>{c.label}</h3>
            <p>{c.text}</p>
            <button className="btn big sage" onClick={() => dispatch({ type: 'checkpoint', taskId: c.taskId, checkpointId: c.id })} data-testid="btn-checkpoint">
              ✓ Did it
            </button>
          </div>
        ))}

        {plan.overdue.map((id) => (
          <div key={id} className="card warn" data-testid="overdue">
            <b>Check doneness: {taskDef(id).title}</b>
            <p className="small">Its planned time is up. The plan holds dependent steps until you confirm it is done (or extend it).</p>
            <button className="btn small" onClick={() => setSelected(id)}>
              Open
            </button>
          </div>
        ))}

        {focusId ? (
          <div className="card now" data-testid="now-card">
            <div className="section-title" style={{ marginTop: 0 }}>
              {plan.tasks[focusId]!.status === 'running' ? 'In progress' : 'Do this now'}
            </div>
            <TaskHeader def={taskDef(focusId)} pt={plan.tasks[focusId]} />
            <TaskMeta def={taskDef(focusId)} pt={plan.tasks[focusId]} />
            <TaskSteps def={taskDef(focusId)} />
            <TaskActions def={taskDef(focusId)} plan={plan} now={now} dispatch={dispatch} toast={toast} />
          </div>
        ) : (
          <div className="card" data-testid="now-card">
            {plan.progress.done === plan.progress.total ? (
              <h2>Everything is done. Enjoy dinner! 🦃</h2>
            ) : plan.next ? (
              <>
                <div className="section-title" style={{ marginTop: 0 }}>
                  Up next
                </div>
                <TaskHeader def={taskDef(plan.next)} pt={plan.tasks[plan.next]} />
                <p className="muted">
                  Planned at <b className="num">{fmtTime(plan.tasks[plan.next]!.startMs!)}</b>
                  {plan.tasks[plan.next]!.startMs! > now && <> — free for {fmtMinutes(Math.max(0, (plan.tasks[plan.next]!.startMs! - now) / MINUTE))}</>}.
                </p>
                {plan.tasks[plan.next]!.blockers.length > 0 && (
                  <ul className="plain small muted">
                    {plan.tasks[plan.next]!.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                <button className="btn" onClick={() => setSelected(plan.next)}>
                  View instructions
                </button>
              </>
            ) : (
              <p>No task can be scheduled. Check Timeline for blockers.</p>
            )}
          </div>
        )}

        <div className="btns no-print">
          <button className="btn" onClick={() => setPicker(true)} data-testid="btn-select">
            Choose another task
          </button>
          {paused ? (
            <button className="btn" onClick={() => dispatch({ type: 'resume' })} data-testid="btn-resume">
              ▶ Resume guidance
            </button>
          ) : (
            <button className="btn" onClick={() => toast(dispatch({ type: 'pause' }).message ?? 'Paused')} data-testid="btn-pause">
              ⏸ Pause guidance
            </button>
          )}
          <button
            className="btn"
            disabled={state.events.length === 0}
            onClick={() => {
              const r = dispatch({ type: 'undo' });
              if (r.message) toast(r.message);
            }}
            data-testid="btn-undo"
          >
            ↶ Undo
          </button>
        </div>
      </div>

      <div>
        {running.length > 0 && (
          <>
            <div className="section-title">Running ({running.length})</div>
            <div className="card">
              {running.map((id) => {
                const pt = plan.tasks[id]!;
                const d = taskDef(id);
                return (
                  <button key={id} className="list-item" style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setSelected(id)}>
                    <div className="time-col">{fmtDuration(now - pt.startMs!)}</div>
                    <div className="grow">
                      <b>{d.title}</b>
                      <div className="small muted">
                        {dishName(d.dish)} · {pt.overdue ? 'check doneness' : `until ~${fmtTime(pt.endMs!)}`}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="section-title">Timers ({timers.length})</div>
        {timers
          .filter((t) => now < t.deadlineMs)
          .map((t) => (
            <TimerCard key={t.id} t={t} now={now} dispatch={dispatch} />
          ))}
        <div className="card">
          <div className="row">
            <input
              aria-label="Timer label"
              placeholder="Label"
              className="grow"
              style={{ minHeight: 44, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px' }}
              value={newTimer.label}
              onChange={(e) => setNewTimer({ ...newTimer, label: e.target.value })}
            />
            <input
              aria-label="Timer minutes"
              placeholder="min"
              inputMode="numeric"
              style={{ width: 70, minHeight: 44, border: '1px solid var(--line)', borderRadius: 10, padding: '0 10px' }}
              value={newTimer.min}
              onChange={(e) => setNewTimer({ ...newTimer, min: e.target.value.replace(/[^0-9.]/g, '') })}
            />
            <button
              className="btn"
              disabled={!(Number(newTimer.min) > 0)}
              data-testid="btn-add-timer"
              onClick={() => {
                dispatch({ type: 'timer/add', label: newTimer.label || 'Timer', minutes: Number(newTimer.min) });
                setNewTimer({ label: '', min: '' });
              }}
            >
              + Timer
            </button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Alarms only sound while this app is open on screen. On iPhone, set a backup timer in the Clock app for anything critical.
          </p>
        </div>

        <div className="section-title">Coming up</div>
        <div className="card" data-testid="upcoming">
          {upcoming.length === 0 && <p className="muted">Nothing else planned.</p>}
          {upcoming.map((id) => {
            const pt = plan.tasks[id]!;
            const d = taskDef(id);
            return (
              <button key={id} className="list-item" style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setSelected(id)}>
                <div className="time-col">{fmtTime(pt.startMs!)}</div>
                <div className="grow">
                  <b>{d.title}</b>
                  <div className="small muted">
                    {dishName(d.dish)} · {d.attention === 'active' ? 'hands-on' : d.attention === 'periodic' ? 'check-ins' : 'hands-off'} · {d.duration.nominal} min
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {selected && (
        <Sheet title="Task" onClose={() => setSelected(null)} testId="task-sheet">
          <TaskHeader def={taskDef(selected)} pt={plan.tasks[selected]} />
          <TaskMeta def={taskDef(selected)} pt={plan.tasks[selected]} />
          {plan.tasks[selected]!.blockers.length > 0 && plan.tasks[selected]!.status === 'scheduled' && (
            <div className="card warn small">
              {plan.tasks[selected]!.blockers.map((b) => (
                <div key={b}>• {b}</div>
              ))}
            </div>
          )}
          <TaskSteps def={taskDef(selected)} />
          <TaskActions def={taskDef(selected)} plan={plan} now={now} dispatch={dispatch} toast={toast} />
        </Sheet>
      )}

      {picker && (
        <Sheet title="Choose a task" onClose={() => setPicker(false)} testId="task-picker">
          <p className="small muted">Ready now are listed first. Starting something other than the recommendation re-plans everything else.</p>
          {[...startable, ...plan.order.filter((id) => plan.tasks[id]!.status === 'scheduled' && !startable.includes(id))].map((id) => (
            <button
              key={id}
              className="list-item"
              style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => {
                setPicker(false);
                setSelected(id);
              }}
            >
              <div className="time-col">{fmtTime(plan.tasks[id]!.startMs!)}</div>
              <div className="grow">
                <b>{taskDef(id).title}</b>
                <div className="small muted">
                  {dishName(taskDef(id).dish)} · {plan.tasks[id]!.startableNow ? 'ready' : plan.tasks[id]!.blockers[0]}
                </div>
              </div>
            </button>
          ))}
        </Sheet>
      )}
    </div>
  );
}
