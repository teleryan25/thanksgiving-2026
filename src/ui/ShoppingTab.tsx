import { auditAgainstExpected, shoppingList } from '../domain/audit';
import { dishName, type Dispatch } from './common';

const LIST = shoppingList();
const AUDIT = auditAgainstExpected();

export function ShoppingTab({ checks, dispatch }: { checks: Record<string, boolean>; dispatch: Dispatch }) {
  const all = LIST.groups.flatMap((g) => g.items);
  const done = all.filter((i) => checks[i.key]).length;
  return (
    <>
      <div className="row">
        <p className="grow muted" style={{ margin: 0 }}>
          Groceries are already bought — use this to double-check. <b className="num">{done}</b>/{all.length} checked.
        </p>
        <button className="btn small" onClick={() => dispatch({ type: 'shopping/clear' })} disabled={done === 0}>
          Clear checks
        </button>
      </div>
      {LIST.groups.map((g) => (
        <div key={g.category}>
          <div className="section-title">{g.category}</div>
          <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {g.items.map((i) => (
              <label key={i.key} className={`check ${checks[i.key] ? 'done' : ''}`} data-testid={`shop-${i.key}`}>
                <input type="checkbox" checked={!!checks[i.key]} onChange={() => dispatch({ type: 'shopping/toggle', key: i.key })} />
                <span className="lbl grow">
                  <b>{i.name}</b> — <span className="num">{i.amount || 'as needed'}</span>
                  {i.toTaste && <span className="muted"> + to taste</span>}
                  {i.note && <div className="small muted">{i.note}</div>}
                  {i.optional.length > 0 && <div className="small muted">Optional: {i.optional.join('; ')}</div>}
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {i.dishes.map((d) => (
                      <span key={d} className="chip">
                        {dishName(d)}
                      </span>
                    ))}
                  </div>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="section-title">Devin brings</div>
      <div className="card">
        {LIST.brought.map((b) => (
          <div key={b.key}>
            <b>{b.name}</b> — {b.note}
          </div>
        ))}
      </div>
      <details className="card">
        <summary>Quantity audit ({AUDIT.filter((a) => a.pass).length}/{AUDIT.length} match the plan)</summary>
        <table className="simple">
          <tbody>
            {AUDIT.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td className="num">{a.actual}</td>
                <td className={a.pass ? 'diag-pass' : 'diag-fail'}>{a.pass ? '✓' : `expected ${a.expected}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}
