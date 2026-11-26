# Thanksgiving Command Center

A mobile-first, offline-capable web app that runs one cook through Thanksgiving dinner on **Thu Nov 26 2026** (America/Chicago): start 8:00 AM, dinner target 1:00 PM (1:15 acceptable), one oven with two racks, four burners.

**Live:** https://teleryan25.github.io/thanksgiving-2026/

## What it does
- **Cook** — the one thing to do now, with exact quantities, heat, time range, doneness cues, troubleshooting and expandable technique help. Start / Done / Extend / Delay / Skip / Undo / Pause, check-ins (stir the bread, remove the foil, add the onions), timers and what's coming up.
- **Timeline** — a live re-plan of every task: two-rack oven chart, burner lanes, cook load, blockers, equipment use and how long each dish spends at room temperature.
- **Recipes** — all eight dishes as standalone recipes from the same data as the guided plan, plus a printable emergency cookbook with the baseline schedule.
- **Shopping** — a categorized list with dish references and saved checkmarks; the totals are audited against the spec.
- **Settings** — dinner time, turkey ETA and arrival, burners and cookware, alarm sound/vibration/screen wake lock, offline status, simulation, diagnostics, history and reset.

Food safety comes first: thermometer confirmation for sausage 160°F, sweet potato casserole 160°F, stuffing and turkey 165°F. A timer going off never marks anything done, and nothing counts as "held hot" unless you measure it at ≥140°F.

## Install on iPhone
1. Open the live URL in **Safari** while online. Wait until Settings → Offline says **"Offline-ready"**.
2. Share → **Add to Home Screen**. Launch it from the icon.
3. **Alarms only sound while the app is open on screen.** iOS suspends web apps in the background and when locked. Set a backup timer in the Clock app for anything critical. Turn on "Keep screen awake" in Settings and tap "Test sound" (check the silent switch).

## Develop
```bash
npm ci
npm run dev          # local dev server
npm run typecheck    # strict TypeScript
npm test             # Vitest: data, timers, scheduler, state, full simulations
npm run build        # production build + service worker
npm run test:e2e     # build + Playwright (390x844 mobile + desktop, offline, print)
npm run test:all
npx tsx scripts/print-plan.ts         # baseline schedule in the terminal
npx tsx scripts/sim.ts random 7       # one seeded full-day simulation
```
Stack: React 19, strict TypeScript, Vite, Vitest, Playwright, a custom service worker. No backend, accounts or remote runtime assets (fonts are bundled).

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, test results and known limitations.
