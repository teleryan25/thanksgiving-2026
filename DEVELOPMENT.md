# DEVELOPMENT — Thanksgiving Command Center

## Status (paused mid-build)

| Gate | Phase | Status |
|---|---|---|
| 1 | Canonical recipe data & quantity reconciliation | ✅ passing (19 tests) |
| 2 | Absolute-deadline independent timers | ✅ passing (6 tests) |
| 3 | Resource/dependency scheduler | ✅ passing (31 tests) |
| 4 | Persistent state & undo | ✅ passing (14 tests) |
| 5 | Mobile UI | 🚧 in progress — CookTab, TimelineTab, RecipesTab (+print), ShoppingTab, shared components, hooks, plan Web Worker, alarm helpers written; **not yet wired** (App.tsx, main.tsx, index.html, Settings/Diagnostics/SimPanel missing). Not typechecked yet. |
| 6 | Simulation & runtime diagnostics | 🚧 `src/domain/simulation.ts` written; **first run FAILS** (see below). `diagnostics.ts` not written. |
| 7–9 | PWA, browser tests, deployment | ⏳ not started (`scripts/sw-plugin.ts` exists; `scripts/sw-template.js` missing, so `vite build` will fail until added) |

Last full unit run: **70/70 passing**, `tsc -b` clean (before the UI/simulation files were added).

## Known failing / next steps
1. **Simulation bug** (`npx tsx scripts/sim.ts nominal 1`): the simulated cook stalls at ~12:28 — mash/corn/gravy/turkey-carve/bread never complete, loop hits 2000 steps. Likely cause: the turkey-arrive/external-task path or the "advance clock" step when `recommended` is null but a startable task is due. Also no-wait followers start 4–5 min late in the sim (compote-finish, mac-cook-pasta) — follower units of a finished head become `asap` but aren't recommended immediately.
2. Write App.tsx/main.tsx/index.html, Settings sheet (target, turkey ETA/arrived, burners, cookware, sound/vibration/wake lock, reset, history), SimPanel, diagnostics (domain + env checks).
3. sw-template.js, manifest, icons, offline-ready check; Playwright tests (390x844 + desktop, offline reload, print).
4. README, CI + Pages workflows, enable Pages (`build_type=workflow`), push, verify live URL.

## Scheduler notes (real findings)
- Total hands-on cook load is ~248 of 300 minutes (83%). The spec's baseline (350°F phase from 11:20) cannot also hit 1:00 once the full stovetop/prep workload is counted; the scheduler starts the 350°F phase ≈10:42.
- Current baseline plan: dinner 1:00 PM, zero violations, no dish over the 2-hour room-temperature limit (max ≈109 min, green beans), ~100 ms per plan on desktop.
- Algorithm: forward list scheduling with no-wait units → backward/forward justification → windows × 2 orderings + 40 seeded samples + exposure-start delay descent. Deterministic (fixed seed).
- Scoring trades up to the 15-min acceptable window for food-safety margin.

## Commands
`npm test` · `npm run typecheck` · `npx tsx scripts/print-plan.ts` (baseline schedule) · `npx tsx scripts/sim.ts nominal|random|max <seed>`
