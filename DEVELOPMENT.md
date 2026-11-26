# DEVELOPMENT — Thanksgiving Command Center

## Gate status (actual results, Nov 25 2026)
| # | Phase | Result |
|---|---|---|
| 1 | Canonical recipe data & quantity reconciliation | ✅ 19 Vitest tests |
| 2 | Absolute-deadline independent timers | ✅ 6 tests |
| 3 | Resource/dependency scheduler | ✅ 31 tests |
| 4 | Persistent state & undo | ✅ 14 tests |
| 5 | Mobile UI | ✅ Playwright on 390×844 and 1280×900 |
| 6 | Simulation & runtime diagnostics | ✅ 6 full-day simulation tests; in-app diagnostics (13 checks, plus an optional full simulation) |
| 7 | Offline PWA | ✅ Playwright: verified cache, then offline reload |
| 8 | Browser/integration tests | ✅ 18 Playwright tests (9 scenarios × 2 viewports) |
| 9 | Deployment | see "Deployment" below |

**Totals:** Vitest **76/76** passing (about 100 s, mostly the simulations); Playwright **18/18** passing; `tsc -b` clean; production build OK.
Every gate was rerun as a regression check after the later changes.

## Architecture
- `src/domain/recipes.ts` is the **single canonical dataset**: ingredients, dish cards, and tasks with exact-quantity steps (`{n}` placeholders rendered from structured usages), equipment, heat, durations (min/nominal/max), attention type, check-ins, cues, troubleshooting, hints and food-safety temperatures. Guided tasks, recipes, the printed cookbook and the shopping list all come from it.
- `audit.ts` reconciles each dish card against its step usages (split amounts like butter for sauce, topping and greasing), checks prep vs consumption (no double counting), units and drained weights, and the spec's audit totals. `validate.ts` checks the graph (missing dependencies, cycles, oven-phase ordering, no-wait links, required safety checks).
- `timers.ts` uses absolute deadlines, so an expired timer stays expired after a reload and never restarts. Acknowledging a timer is separate from completing the task.
- `state.ts` is an event-sourced log. Progress, target, turkey ETA and pause are all derived from it. Undo removes the last plan event, cancels only timers that event created, and says that nothing physical was reversed. Unsafe skips, missing safety confirmations and early completions throw unless explicitly confirmed. `storage.ts` handles versioned save/load with per-section validation, a backup of corrupt data, migration from the v1 format and separate live/sim keys.
- `scheduler.ts` is a deterministic resource scheduler covering one cook, N burners, cookware (including either/or choices) and one oven with two racks at a single temperature. Temperature phases (250 → 400 → 350°F) are tasks that need a thermometer confirmation. No-wait chains (e.g. rest right after the bake, simmer right after the sauté, assemble then bake) are scheduled as units. The method is forward list scheduling plus backward/forward justification, searched over release windows, 60 seeded samples, two orderings and a delay search from the top 3. Scoring: unschedulable ≫ beyond 1:15 ≫ food-safety exposure ≫ lateness within the window ≫ exposure ≫ hold time. Safety release bounds stop a dish's first cooked perishable from starting so early that it would pass (limit − 15 min) before the target. A stability hint keeps the previous plan unless a new one is clearly better. Running-late handling prevents endlessly deferring work. Running tasks reserve only their remaining hands-on minutes, and an overdue task is projected to end at now + 1 minute until the cook confirms.
- `simulation.ts` runs a simulated cook through the **production** reducer and planner on an injected clock, then independently checks the executed history.
- UI: React. Planning and diagnostics run in a Web Worker. Separate live and simulation stores. Foreground-only audio, vibration and wake lock.
- PWA: `scripts/sw-plugin.ts` generates `sw.js` with a content-hash cache of every built file plus `asset-manifest.json`. The app reports "Offline-ready" only after checking that every listed file is in the cache. A new version never activates by itself; the cook taps "Update now".

## Baseline plan (deterministic, from `scripts/print-plan.ts`)
Projected dinner **1:09 PM** (inside the acceptable window), zero violations, every dish under the 2-hour limit (worst: stuffing 113 min).
```
 8:00 AM– 8:15 AM  scheduled passive  oven-preheat-250  both
 8:01 AM– 8:13 AM  scheduled active   stuffing-cube-rolls  
 8:13 AM– 8:18 AM  scheduled active   compote-prep-orange  
 8:18 AM– 9:18 AM  scheduled periodic stuffing-dry-bread  both
 8:19 AM– 8:29 AM  scheduled active   sp-peel  
 8:29 AM– 8:47 AM  scheduled periodic compote-simmer saucepan 
 8:31 AM– 8:34 AM  scheduled active   mash-garlic-prep  
 8:47 AM– 8:51 AM  scheduled active   compote-finish saucepan 
 8:51 AM– 8:58 AM  scheduled active   gb-prep  
 9:00 AM– 9:10 AM  scheduled active   stuffing-prep-veg  
 9:10 AM– 9:16 AM  scheduled active   sp-streusel  
 9:18 AM– 9:33 AM  scheduled passive  oven-to-400  both
 9:18 AM– 9:33 AM  scheduled passive  stuffing-cool-bread  
 9:19 AM– 9:31 AM  scheduled active   mash-peel  
 9:31 AM– 9:37 AM  scheduled active   mac-shred  
 9:37 AM–10:22 AM  scheduled passive  mash-garlic-roast  0
 9:59 AM–10:08 AM  scheduled active   stuffing-cook-sausage deepSkillet 
10:08 AM–10:18 AM  scheduled active   stuffing-cook-veg deepSkillet 
10:18 AM–10:21 AM  scheduled active   stuffing-season deepSkillet 
10:21 AM–10:31 AM  scheduled passive  stuffing-cool-mix  
10:22 AM–10:42 AM  scheduled passive  oven-to-350  both
10:23 AM–10:26 AM  scheduled active   stuffing-egg-mix  
10:26 AM–10:29 AM  scheduled active   mash-garlic-squeeze  
10:29 AM–10:39 AM  scheduled active   gb-saute deepSkillet 
10:39 AM–11:03 AM  scheduled periodic sp-boil stockpot 
10:39 AM–10:48 AM  scheduled periodic gb-simmer deepSkillet 
10:48 AM–11:00 AM  scheduled passive  mac-boil-water pastaPot 
10:51 AM–10:59 AM  scheduled active   stuffing-assemble  
10:59 AM–11:54 AM  scheduled periodic stuffing-bake  0
11:00 AM–11:07 AM  scheduled periodic mac-cook-pasta pastaPot 
11:03 AM–11:10 AM  scheduled passive  sp-mash  
11:10 AM–11:22 AM  scheduled passive  sp-cool  
11:10 AM–11:24 AM  scheduled active   mac-sauce saucepan2 
11:24 AM–11:32 AM  scheduled active   sp-filling lightSkillet 
11:32 AM–12:10 PM  scheduled passive  sp-bake  1
11:47 AM–11:52 AM  scheduled active   mac-assemble lightSkillet 
11:54 AM–11:59 AM  scheduled passive  stuffing-rest  
11:54 AM–11:58 AM  scheduled active   gb-assemble deepSkillet 
11:59 AM–12:28 PM  scheduled periodic gb-bake  0
12:00 PM–12:08 PM  scheduled active   mash-brown-butter lightSkillet 
12:10 PM–12:32 PM  scheduled passive  mac-bake  1
12:12 PM–12:46 PM  scheduled periodic mash-boil stockpot 
12:30 PM–12:38 PM  scheduled periodic gravy-heat saucepan 
12:30 PM–12:30 PM  scheduled external turkey-arrive  
12:32 PM–12:37 PM  scheduled passive  mac-rest  
12:32 PM–12:34 PM  scheduled active   turkey-check  
12:34 PM–12:46 PM  scheduled passive  turkey-rest  
12:35 PM–12:40 PM  scheduled periodic mash-warm-cream saucepan2 
12:41 PM–12:44 PM  scheduled active   bread-slice  
12:46 PM–12:54 PM  scheduled active   mash-mash stockpot 
12:54 PM– 1:03 PM  scheduled active   corn-cook cornSkillet 
 1:03 PM– 1:09 PM  scheduled active   turkey-carve  
```
**Spec baseline vs. this plan.** The spec's oven baseline (350°F from 11:20) can't also hit 1:00 once the whole stovetop and prep workload is counted: one cook has about 248 hands-on minutes in a 300-minute window (83%). The plan instead brings the oven to 350°F by about 10:42, keeps compote early, finishes mash about 12:54, gravy 12:32 and corn just before 1:03, and moves the last-minute crunch (mash, corn, carving) past 1:00, landing at 1:09. Assigning carving to Devin (a Settings switch) shortens that crunch.

## Simulation results (`src/test/simulation.test.ts`)
| Scenario | Done | Dinner | First projection | Max exposure | Plan/history/honesty violations |
|---|---|---|---|---|---|
| Nominal durations | 52/52 | 1:09 PM | 1:10 PM | 112 min | 0 / 0 / 0 |
| Random seed 11 | 52/52 | 1:42 PM | 1:10 PM | 133 min ⚠ (warned) | 0 / 0 / 0 |
| Random seed 22 | 52/52 | 1:23 PM | 1:10 PM | 112 min | 0 / 0 / 0 |
| Random seed 33 | 52/52 | 1:14 PM | 1:10 PM | 114 min | 0 / 0 / 0 |
| Every task at its max | 52/52 | 2:48 PM | 1:10 PM | 180 min ⚠ (warned) | 0 / 0 / 0 |
| Turkey 45 min late | 52/52 | 1:35 PM | 1:10 PM | 138 min ⚠ (warned) | 0 / 0 / 0 |

Checked in every run: all tasks complete; no burner, cookware, oven-capacity, two-temperature or two-hands-on-tasks violations; dependencies respected; every check-in recorded within 2 minutes; no cooking shorter than its minimum; no projection earlier than physically possible; final projection equals the actual result. In overrun scenarios dinner moves later honestly, and a dish that crosses the 2-hour limit always gets a danger warning before dinner.

## Known limitations (honest)
- **Recipes are not physically tested.** The adaptations are as specified. No material errors were found that required changing a recipe; buying notes flag that canned beans and corn are measured by drained weight.
- **The scheduler is heuristic, not optimal.** Quality depends on a seeded search. Small data changes can shift the plan by several minutes. Planning takes about 0.3 s on a desktop (in a worker; slower on phones).
- **Overruns cause no-wait gaps.** If a task runs long, the cook may be busy when a no-wait follower is due (e.g. mashing waits while a casserole is unloaded). The simulation reports these gaps; the nominal run has none. The model also doesn't let the cook do two hands-on things at once, which is stricter than real cooking.
- **Food-safety exposure is an estimate.** It counts time from the first cooked perishable to serving, minus heating steps. It doesn't model how quickly dishes cool. A late turkey ETA is only known once you update it; with a 45-minute surprise delay some dishes cross the 2-hour limit (and the app says so).
- **Alarms are foreground-only.** No background or locked-screen alarms on iOS; vibration doesn't work on iPhone Safari. Audio counts as verified only after the cook confirms hearing the test sound.
- Only a pre-release "v1" storage format exists to migrate from; it was defined to exercise the migration path.

## Manual acceptance checklist (iPhone)
- [ ] Open the live URL in Safari; Settings → Offline shows "Offline-ready (N/N files cached)".
- [ ] Add to Home Screen; launch; switch on Airplane Mode; relaunch — the app loads with recipes and plan.
- [ ] Settings → Alert sound on → Test sound → "I heard it"; Diagnostics shows Alarm sound VERIFIED.
- [ ] Keep screen awake on; screen stays on for 5+ minutes on the Cook tab.
- [ ] Simulation: start preheat, Expire timers → alarm sounds (sound on) and the task is still running; Acknowledge; Done needs the thermometer checkbox.
- [ ] Skip the sausage → confirmation required; the stuffing chain shows blocked.
- [ ] Undo → the toast says nothing physical was reversed.
- [ ] Exit to live → live progress untouched (0/52).
- [ ] Recipes → Print cookbook → print preview shows the schedule and all recipes.
- [ ] Settings → Diagnostics: all PASS.

## Deployment
Push to `main` → `.github/workflows/pages.yml` (typecheck, unit tests, build, deploy to Pages). `ci.yml` also runs Playwright.

**Verified Nov 25 2026** with `node scripts/verify-live.mjs` (headless Chromium, 390×844) against https://teleryan25.github.io/thanksgiving-2026/: HTTP 200; projected dinner 1:09 PM; service worker controlling; "Offline-ready (20/20 files cached)"; in-app diagnostics 13 passed, 0 failed; offline reload OK; no console errors. GitHub Actions: CI (typecheck, Vitest, build, Playwright) and the Pages deploy both green.
