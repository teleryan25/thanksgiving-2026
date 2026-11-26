import type { Plan } from '../domain/scheduler';
import { derive, type CookState } from '../domain/state';
import { MINUTE, fmtDay, fmtTime } from '../domain/time';
import { nextDeadline } from '../domain/timers';
import type { Dispatch } from './common';

export function SimBar({ state, plan, now, dispatch, toast, exit }: { state: CookState; plan: Plan | null; now: number; dispatch: Dispatch; toast: (m: string) => void; exit: () => void }) {
  const go = (ms: number) => dispatch({ type: 'sim/set', ms });
  const nextTask = () => {
    if (!plan) return;
    const c = Object.values(plan.tasks)
      .flatMap((t) => (t.status === 'scheduled' && t.startMs ? [t.startMs] : t.status === 'running' && t.endMs ? [t.endMs] : []))
      .filter((x) => x > now);
    if (c.length) go(Math.min(...c));
    else toast('No upcoming task.');
  };
  const nextTimer = () => {
    const d = nextDeadline(state.timers, now);
    if (d) go(d);
    else toast('No running timers.');
  };
  const running = plan ? Object.values(plan.tasks).filter((t) => t.status === 'running') : [];
  return (
    <div className="sim-banner no-print" data-testid="sim-banner">
      <span className="tag">SIMULATION</span>
      <span className="num">
        {fmtDay(now)} {fmtTime(now)}
      </span>
      <span className="small" style={{ opacity: 0.8 }}>
        separate data · {state.settings.sound ? 'sound on' : 'no alarms'}
      </span>
      <div className="row" style={{ width: '100%', gap: 6 }}>
        {[1, 5, 15, 30].map((m) => (
          <button key={m} className="btn small" onClick={() => go(now + m * MINUTE)} data-testid={`sim-adv-${m}`}>
            +{m}m
          </button>
        ))}
        <button className="btn small" onClick={nextTask} data-testid="sim-next-task">
          Next task
        </button>
        <button className="btn small" onClick={nextTimer} data-testid="sim-next-timer">
          Next timer
        </button>
        <button className="btn small" onClick={() => toast(dispatch({ type: 'sim/expireTimers' }).message ?? '')} data-testid="sim-expire">
          Expire timers
        </button>
        <button
          className="btn small"
          disabled={running.length === 0}
          data-testid="sim-complete-all"
          onClick={() => {
            for (const t of running) dispatch({ type: 'complete', taskId: t.id, earlyConfirmed: true, safetyConfirmed: true });
            toast(`Completed ${running.length} running task(s) now (early or late as it happens).`);
          }}
        >
          Finish running now
        </button>
        <button className="btn small" onClick={() => dispatch({ type: 'setTurkeyEta', ms: derive(state.events).turkeyEtaMs + 15 * MINUTE })} data-testid="sim-turkey">
          Turkey +15m
        </button>
        <button className="btn small" onClick={() => dispatch({ type: 'reset', scope: 'all' })} data-testid="sim-reset">
          Reset sim
        </button>
        <button className="btn small terra" onClick={exit} data-testid="sim-exit">
          Exit to live
        </button>
      </div>
    </div>
  );
}
