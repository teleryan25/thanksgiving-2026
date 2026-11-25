import { plan, verifyPlan } from '../src/domain/scheduler';
import { baselineInput } from '../src/domain/fixtures';
import { fmtTime } from '../src/domain/time';
import { TASKS } from '../src/domain/recipes';

const input = baselineInput();
const t0 = performance.now();
const p = plan(input);
const ms = performance.now() - t0;
console.log('dinner', p.dinnerMs && fmtTime(p.dinnerMs), p.status, p.strategy, `${ms.toFixed(0)}ms`);
for (const id of p.order) {
  const x = p.tasks[id]!;
  const t = TASKS.find((q) => q.id === id)!;
  console.log(`${x.startMs ? fmtTime(x.startMs).padStart(8) : '   -    '}–${x.endMs ? fmtTime(x.endMs).padStart(8) : ''}  ${x.status.padEnd(9)} ${t.attention.padEnd(8)} ${id} ${x.cookware.join(',')} ${x.rack ?? ''}`);
}
console.log(p.warnings.map((w) => `${w.level}: ${w.text}`).join('\n'));
console.log('violations', verifyPlan(input, p));
console.log(p.exposures.map((e) => `${e.name}: ${e.projectedMin}min`).join(', '));
