import { describe, expect, it } from 'vitest';
import { runSimulation, type SimResult } from '../domain/simulation';
import { MINUTE, eventAt, fmtTime } from '../domain/time';

const report = (name: string, r: SimResult) =>
  // eslint-disable-next-line no-console
  console.log(
    `[sim] ${name}: ${r.completed}/${r.total} tasks, dinner ${r.dinnerMs ? fmtTime(r.dinnerMs) : '—'} (first projection ${r.firstProjectionMs ? fmtTime(r.firstProjectionMs) : '—'}), ` +
      `max exposure ${r.maxExposureMin} min, plans ${r.steps}, no-wait gaps ${r.noWaitGaps.length}, breaches ${r.exposureBreaches.map((b) => `${b.dish}:${b.minutes}`).join(',') || 'none'}`,
  );

function commonChecks(r: SimResult) {
  expect(r.completed).toBe(r.total);
  expect(r.planViolations).toEqual([]);
  expect(r.historyViolations).toEqual([]);
  expect(r.honestyViolations).toEqual([]);
  // Any food-safety breach must have been warned about before dinner.
  for (const b of r.exposureBreaches) {
    expect(b.warnedAt, b.dish).not.toBeNull();
    expect(b.warnedAt!).toBeLessThan(r.dinnerMs!);
  }
}

describe('full production-scheduler simulations', () => {
  it('baseline with nominal durations: on time, safe, no-wait respected', () => {
    const r = runSimulation({ durations: 'nominal' });
    report('baseline nominal', r);
    commonChecks(r);
    expect(r.dinnerMs!).toBeLessThanOrEqual(eventAt(13, 15));
    expect(r.dinnerMs!).toBeLessThanOrEqual(r.firstProjectionMs! + 5 * MINUTE);
    expect(r.exposureBreaches).toEqual([]);
    expect(r.noWaitGaps).toEqual([]);
    const temps = r.oven.sort((a, b) => a.start - b.start).map((o) => o.tempF);
    expect([...new Set(temps)]).toEqual([250, 400, 350]);
  }, 240_000);

  for (const seed of [11, 22, 33]) {
    it(`seeded random durations (seed ${seed}) stay valid and honest`, () => {
      const r = runSimulation({ durations: 'random', seed });
      report(`random seed ${seed}`, r);
      commonChecks(r);
    }, 240_000);
  }

  it('every task taking its maximum time: still valid, dinner honestly later', () => {
    const r = runSimulation({ durations: 'max' });
    report('all max', r);
    commonChecks(r);
    expect(r.dinnerMs!).toBeGreaterThan(eventAt(13, 15));
  }, 240_000);

  it('turkey 45 minutes late', () => {
    const r = runSimulation({ durations: 'nominal', turkeyDelayMin: 45 });
    report('turkey +45', r);
    commonChecks(r);
    const carve = r.log.find((l) => l.taskId === 'turkey-check')!;
    expect(carve.start).toBeGreaterThanOrEqual(eventAt(13, 15));
  }, 240_000);
});
