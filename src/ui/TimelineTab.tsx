import { useState } from 'react';
import { COOKWARE, EQUIPMENT_LIST } from '../domain/recipes';
import type { Plan } from '../domain/scheduler';
import { MINUTE, fmtTime } from '../domain/time';
import { Sheet, TaskActions, TaskHeader, TaskMeta, TaskSteps, dishName, taskDef, type Dispatch } from './common';

function Chart({ plan, now }: { plan: Plan; now: number }) {
  const all = Object.values(plan.tasks).filter((t) => t.startMs != null && t.endMs != null);
  const from = Math.min(...all.map((t) => t.startMs!), now);
  const to = Math.max(...all.map((t) => t.endMs!), plan.dinnerMs ?? 0, plan.targetMs);
  const span = Math.max(1, to - from);
  const pct = (ms: number) => `${((ms - from) / span) * 100}%`;
  const w = (a: number, b: number) => `${Math.max(0.4, ((b - a) / span) * 100)}%`;
  const hours: number[] = [];
  for (let h = Math.ceil(from / (60 * MINUTE)) * 60 * MINUTE; h <= to; h += 60 * MINUTE) hours.push(h);
  const nowLine = now >= from && now <= to ? <div className="nowline" style={{ left: pct(now) }} /> : null;
  const label = (id: string) => taskDef(id).title.replace(/ at \d+°F/, '');
  const cookBlocks = Object.values(plan.tasks).flatMap((t) => t.cook.map(([a, b]) => ({ id: t.id, a, b })));
  const lanes = Math.max(1, ...plan.burners.map((b) => b.lane + 1));
  return (
    <div className="chart" data-testid="oven-chart">
      <div className="axis">
        {hours.map((h) => (
          <span key={h} style={{ left: pct(h) }}>
            {fmtTime(h).replace(':00', '')}
          </span>
        ))}
      </div>
      {[0, 1].map((rack) => (
        <div key={rack}>
          <div className="lane-label">Oven — {rack === 0 ? 'upper' : 'lower'} rack</div>
          <div className="lane">
            {nowLine}
            {plan.oven
              .filter((o) => o.rack === rack || o.rack === 'both')
              .map((o) => (
                <div
                  key={o.taskId}
                  className={`bar ${o.transition ? 'trans' : `t${o.tempF}`} ${plan.tasks[o.taskId]!.status === 'done' ? 'done' : ''}`}
                  style={{ left: pct(o.startMs), width: w(o.startMs, o.endMs) }}
                  title={`${label(o.taskId)} ${fmtTime(o.startMs)}–${fmtTime(o.endMs)}`}
                >
                  {o.transition ? `→${o.tempF}°` : label(o.taskId)}
                </div>
              ))}
          </div>
        </div>
      ))}
      {Array.from({ length: lanes }, (_, lane) => (
        <div key={`b${lane}`}>
          <div className="lane-label">Burner {lane + 1}</div>
          <div className="lane">
            {nowLine}
            {plan.burners
              .filter((b) => b.lane === lane)
              .map((b) => (
                <div
                  key={b.taskId}
                  className={`bar stove ${plan.tasks[b.taskId]!.status === 'done' ? 'done' : ''}`}
                  style={{ left: pct(b.startMs), width: w(b.startMs, b.endMs) }}
                  title={`${label(b.taskId)} ${fmtTime(b.startMs)}–${fmtTime(b.endMs)}`}
                >
                  {label(b.taskId)}
                </div>
              ))}
          </div>
        </div>
      ))}
      <div className="lane-label">Cook — hands-on minutes</div>
      <div className="lane">
        {nowLine}
        {cookBlocks.map((c, i) => (
          <div key={i} className="bar cook" style={{ left: pct(c.a), width: w(c.a, c.b) }} title={`${label(c.id)} ${fmtTime(c.a)}`} />
        ))}
      </div>
      <div className="row small muted" style={{ marginTop: 6 }}>
        <span className="chip" style={{ background: '#c9a227', color: '#fff' }}>
          250°F
        </span>
        <span className="chip" style={{ background: 'var(--terra)', color: '#fff' }}>
          400°F
        </span>
        <span className="chip" style={{ background: 'var(--sage)', color: '#fff' }}>
          350°F
        </span>
        <span className="chip">striped = changing temp</span>
      </div>
    </div>
  );
}

export function TimelineTab({ plan, now, dispatch, toast }: { plan: Plan; now: number; dispatch: Dispatch; toast: (m: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const statusChip = (s: string) =>
    s === 'done' ? 'sage' : s === 'running' ? 'amber' : s === 'blocked' || s === 'unschedulable' ? 'terra' : s === 'skipped' ? '' : 'dark';
  return (
    <>
      {plan.warnings.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 0 }}>
            Attention
          </div>
          {plan.warnings.map((w, i) => (
            <div key={i} className={`card ${w.level === 'danger' ? 'alert' : w.level === 'warn' ? 'warn' : ''}`} style={{ padding: 10 }} data-testid={`warning-${w.code}`}>
              {w.text}
            </div>
          ))}
        </>
      )}

      <div className="section-title">Oven, burners & cook</div>
      <div className="card">
        <Chart plan={plan} now={now} />
      </div>

      <div className="section-title">Oven sequence</div>
      <div className="card" data-testid="oven-list">
        {plan.oven.map((o) => (
          <div key={o.taskId} className="list-item">
            <div className="time-col">{fmtTime(o.startMs)}</div>
            <div className="grow">
              <b>{taskDef(o.taskId).title}</b>
              <div className="small muted">
                {o.rack === 'both' ? 'Whole oven' : o.rack === 0 ? 'Upper rack' : 'Lower rack'} · until {fmtTime(o.endMs)}
                {o.transition && ' · confirm with oven thermometer'}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">Room-temperature exposure (food safety)</div>
      <div className="card">
        <table className="simple">
          <thead>
            <tr>
              <th>Dish</th>
              <th>So far</th>
              <th>By dinner</th>
              <th>Refrigerate by</th>
            </tr>
          </thead>
          <tbody>
            {plan.exposures.map((e) => (
              <tr key={e.dish}>
                <td>{e.name}</td>
                <td className="num">{e.soFarMin} min</td>
                <td className={`num ${e.projectedMin >= e.limitMin ? 'diag-fail' : ''}`}>{e.projectedMin} min</td>
                <td className="num">{e.refrigerateByMs ? fmtTime(e.refrigerateByMs) : 'in fridge'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">
          Counts time cooked food spends out of the oven/pan before serving. Limit: 2 hours total (1 hour above 90°F). Nothing is assumed to be held hot unless you measure ≥140°F.
          Reheat leftovers to 165°F.
        </p>
      </div>

      <div className="section-title">All tasks</div>
      <div className="card" data-testid="task-list">
        {plan.order.map((id) => {
          const pt = plan.tasks[id]!;
          const d = taskDef(id);
          return (
            <button key={id} className="list-item" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'left', cursor: 'pointer' }} onClick={() => setSelected(id)} data-testid={`row-${id}`}>
              <div className="time-col">{pt.startMs ? fmtTime(pt.startMs) : '—'}</div>
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <b>{d.title}</b>
                  <span className={`chip ${statusChip(pt.status)}`}>{pt.status}</span>
                </div>
                <div className="small muted">
                  {dishName(d.dish)}
                  {pt.endMs ? ` · until ${fmtTime(pt.endMs)}` : ''}
                  {d.deps.length > 0 && ` · after ${d.deps.map((x) => taskDef(x.id).title).join(', ')}`}
                </div>
                {pt.status !== 'done' && pt.blockers.length > 0 && <div className="small" style={{ color: 'var(--terra)' }}>⛔ {pt.blockers.join(' · ')}</div>}
              </div>
            </button>
          );
        })}
      </div>

      <div className="section-title">Equipment</div>
      <div className="card">
        <table className="simple">
          <tbody>
            {COOKWARE.map((c) => {
              const uses = plan.order.filter((id) => plan.tasks[id]!.cookware.includes(c.id));
              return (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    {c.note && <div className="small muted">{c.note}</div>}
                  </td>
                  <td className="small">{uses.map((id) => `${fmtTime(plan.tasks[id]!.startMs!)} ${taskDef(id).title}`).join(' → ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <details>
          <summary>Full equipment list</summary>
          <ul className="plain">
            {EQUIPMENT_LIST.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </details>
      </div>

      {selected && (
        <Sheet title="Task" onClose={() => setSelected(null)} testId="task-sheet">
          <TaskHeader def={taskDef(selected)} pt={plan.tasks[selected]} />
          <TaskMeta def={taskDef(selected)} pt={plan.tasks[selected]} />
          {plan.tasks[selected]!.blockers.length > 0 && plan.tasks[selected]!.status !== 'done' && (
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
    </>
  );
}
