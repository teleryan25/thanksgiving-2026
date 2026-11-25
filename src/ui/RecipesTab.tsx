import { useState } from 'react';
import { recipeCardLines, renderStep } from '../domain/audit';
import { DISHES, EQUIPMENT_LIST, TASKS } from '../domain/recipes';
import type { Plan } from '../domain/scheduler';
import { fmtTime } from '../domain/time';
import { dishName, taskDef, type Dispatch } from './common';

const ORDER = ['compote', 'stuffing', 'mash', 'sweetpotato', 'greenbeans', 'mac', 'corn', 'gravy', 'turkey', 'bread'] as const;

export const FOOD_SAFETY = [
  'Sausage: 160°F. Sweet potato casserole: 160°F (contains egg). Stuffing center and turkey: 165°F.',
  'Use an instant-read thermometer; a timer going off never means food is done.',
  'Cooked food: no more than 2 hours total at room temperature (1 hour if the room is above 90°F), counting time before and after serving.',
  'Nothing is "held hot" unless you measure it at 140°F or above. Counter rests are fine but food cools.',
  'Refrigerate leftovers in shallow containers promptly. Reheat leftovers to 165°F.',
  'Never taste anything containing raw egg. Wash hands and tools after handling raw egg or raw sausage.',
  'Glass dishes: avoid thermal shock — no cold dish into a hot oven, no hot dish on a wet or cold surface.',
];

function RecipeBody({ dishId, checks, dispatch, print = false }: { dishId: string; checks: Record<string, boolean>; dispatch?: Dispatch; print?: boolean }) {
  const d = DISHES.find((x) => x.id === dishId)!;
  const tasks = TASKS.filter((t) => t.dish === dishId);
  const Check = ({ k, children }: { k: string; children: React.ReactNode }) =>
    print ? (
      <li>{children}</li>
    ) : (
      <li style={{ listStyle: 'none', marginLeft: '-1.2em' }}>
        <label className={`check ${checks[k] ? 'done' : ''}`}>
          <input type="checkbox" checked={!!checks[k]} onChange={() => dispatch?.({ type: 'recipe/toggle', key: k })} />
          <span className="lbl">{children}</span>
        </label>
      </li>
    );
  return (
    <>
      {d.notes.map((n) => (
        <p key={n} className="muted">
          {n}
        </p>
      ))}
      {d.flags.length > 0 && (
        <div className="card warn">
          {d.flags.map((f) => (
            <p key={f}>⚠ {f}</p>
          ))}
        </div>
      )}
      <h3>Ingredients</h3>
      <ul className="plain">
        {recipeCardLines(d).map((l) => (
          <Check key={l.name} k={`ing:${d.id}:${l.name}`}>
            <b>{l.name}</b> — {l.parts.join('; ')}
          </Check>
        ))}
      </ul>
      <h3>Equipment</h3>
      <p>{d.equipment.join(' · ')}</p>
      <h3>Method</h3>
      {tasks.map((t) => (
        <div key={t.id}>
          <h4 style={{ margin: '10px 0 2px' }}>
            {t.title}{' '}
            <span className="small muted">
              ({t.duration.min === t.duration.max ? `${t.duration.min} min` : `${t.duration.min}–${t.duration.max} min`}
              {t.heat ? `, ${t.heat}` : ''})
            </span>
          </h4>
          <ol className="steps">
            {t.steps.map((s, i) => (
              <Check key={i} k={`step:${t.id}:${i}`}>
                {renderStep(s)}
                {s.hint && (print ? <div className="small muted">Tip: {s.hint}</div> : (
                  <details>
                    <summary>Technique help</summary>
                    <div className="hint">{s.hint}</div>
                  </details>
                ))}
              </Check>
            ))}
          </ol>
          {t.cues.length > 0 && <p className="small"><b>Done when:</b> {t.cues.join('; ')}</p>}
          {t.troubleshooting.length > 0 && <p className="small muted"><b>If:</b> {t.troubleshooting.join(' ')}</p>}
        </div>
      ))}
      {d.explain.length > 0 && (
        <>
          <h3>Why it works</h3>
          {d.explain.map((e) => (
            <p key={e.title}>
              <b>{e.title}.</b> {e.body}
            </p>
          ))}
        </>
      )}
    </>
  );
}

export function RecipesTab({ checks, dispatch }: { checks: Record<string, boolean>; dispatch: Dispatch }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="row no-print" style={{ marginBottom: 8 }}>
        <p className="grow muted small" style={{ margin: 0 }}>
          Standalone recipes from the same data as the guided plan. Checkboxes here are just for reference — they don&apos;t change the plan.
        </p>
        <button className="btn" onClick={() => window.print()} data-testid="btn-print">
          🖨 Print cookbook
        </button>
      </div>
      <div className="card warn small">These recipe adaptations are intentional and have not been physically test-cooked. Trust your thermometer and doneness cues.</div>
      {ORDER.map((id) => {
        const d = DISHES.find((x) => x.id === id)!;
        const isOpen = open === id;
        return (
          <div className="card" key={id} data-testid={`recipe-${id}`}>
            <button
              onClick={() => setOpen(isOpen ? null : id)}
              aria-expanded={isOpen}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', width: '100%', alignItems: 'center', minHeight: 44 }}
            >
              <h2 className="grow" style={{ margin: 0 }}>
                {d.name}
              </h2>
              <span aria-hidden>{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen && <RecipeBody dishId={id} checks={checks} dispatch={dispatch} />}
          </div>
        );
      })}
      <div className="card">
        <h2>Food safety</h2>
        <ul className="plain">
          {FOOD_SAFETY.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function PrintCookbook({ baseline }: { baseline: Plan | null }) {
  return (
    <div className="print-only" data-testid="print-cookbook">
      <h1>Thanksgiving Emergency Cookbook — Thu Nov 26, 2026</h1>
      <p>Start 8:00 AM · Dinner 1:00 PM (1:15 acceptable) · One oven, two racks · Devin brings the smoked turkey (ETA 12:30) and Parmesan bread.</p>
      <h2>Baseline schedule</h2>
      {baseline ? (
        <table className="simple">
          <thead>
            <tr>
              <th>Start</th>
              <th>End</th>
              <th>Task</th>
              <th>Dish</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {baseline.order.map((id) => {
              const pt = baseline.tasks[id]!;
              const t = taskDef(id);
              return (
                <tr key={id}>
                  <td>{pt.startMs ? fmtTime(pt.startMs) : ''}</td>
                  <td>{pt.endMs ? fmtTime(pt.endMs) : ''}</td>
                  <td>{t.title}</td>
                  <td>{dishName(t.dish)}</td>
                  <td>{t.oven ? `Oven ${t.oven.tempF}°F` : pt.cookware.length ? pt.cookware.join(', ') : t.attention === 'active' ? 'Counter' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p>Schedule is being computed…</p>
      )}
      <h2>Food safety</h2>
      <ul>
        {FOOD_SAFETY.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <h2>Equipment</h2>
      <ul>
        {EQUIPMENT_LIST.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      {ORDER.map((id) => (
        <section className="print-recipe" key={id}>
          <h2>{DISHES.find((d) => d.id === id)!.name}</h2>
          <RecipeBody dishId={id} checks={{}} print />
        </section>
      ))}
    </div>
  );
}
