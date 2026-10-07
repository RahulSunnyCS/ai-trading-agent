# BL-041 — In-app Guide: what each section does and how to use it

| | |
|---|---|
| **Priority** | P2 — helps the friends read Momentum this month; not on the validation path |
| **Status** | In progress (Phases 1–5 built 2026-10-07; owner review of the wording outstanding) |
| **Type** | feature |
| **Area** | dashboard |
| **Created** | 2026-10-07 |
| **Depends on** | none |
| **TODO.md row** | §3.19 |

## Context

The dashboard has grown to Options Lab (five views), Momentum (six views), Data › Coverage, Jobs,
Broker logins and Settings. The only help today is about 18 scattered `InfoTooltip`s, inline
`help` strings (`MomentumSettingsPanel.tsx`, `MomentumKpiCards.tsx`, `LegCard.tsx`'s `HINTS`) and
`lib/regimeMeta.ts`. The friends who see Momentum results, and the owner months from now, cannot
learn the tool from the UI. The owner asked for a standard docs section that someone who knows
basic options and momentum can read to understand every section, how to use it, and how to read
its results.

Source material already in the repo: `docs/momentum-parameters-plain-english.md`,
`docs/momentum-parameters-reference.md`,
`packages/momentum-backtesting/docs/how-backtests-run-and-how-we-sped-them-up.md` (§7 glossary),
the package READMEs, `apps/scheduler/CLAUDE.md`.

## Goal

- A **Guide** entry in the sidebar (`/guide`, aliases `/help` and `/docs`) with chapters: Start
  here, Momentum, Options Lab, Data & operations, Glossary.
- Every visible screen has a guide page in one template: what it's for · before you start · the
  controls · reading the results · common questions · what it does not tell you.
- Strategy explainers (momentum rotation, leg-wise options backtest), worked walkthroughs, and a
  Limits & caveats page.
- A "How this works" link on each documented screen that opens its guide page.
- Content is Markdown in the repo; a test fails when a guide link or screen reference breaks.

## Out of scope

- The frozen Live group (Live, Trades, P&L, Personalities, Regimes) and Billing — one line on the
  Guide home says they are paused experiments.
- Hidden Momentum datasets (Nifty 50 Stocks, Custom Index) and the CLI-only options tools
  (walk-forward, sweeps, PBO, deflated Sharpe).
- A from-scratch options or investing course; developer documentation.
- Replacing the existing `InfoTooltip` strings with glossary lookups (later, if wanted).

## Plan

### Phase 1 — Shell
- **Tasks:** `guide` tab in `nav.ts` (own "Help" group, cannot be hidden), routes and aliases,
  `case 'guide'` in `App.tsx`, `PENDING_BY_TAB` entry; `?raw` Markdown loading (webpack rule in
  `next.config.ts`; Vitest handles it natively); `react-markdown` + `remark-gfm`; `GuideView`,
  `GuideMarkdown` (callouts `> [!NOTE]`, `app:` links, `glossary:` terms, token-styled tables),
  `src/guide/registry.ts`, `src/guide/glossary.ts`.
- **Deliverables:** `/guide` renders with chapter index, filter box, previous/next.
- **Done when:** `/guide`, `/help`, `/guide/momentum/backtest` render and the registry tests pass.

### Phase 2 — Start here + Momentum
- **Tasks:** Welcome, tour, a day and a week, Limits & caveats; momentum explainer; one page per
  Momentum screen; two walkthroughs; momentum and metric glossary entries.
- **Done when:** every Momentum screen has a page and every link in them resolves.

### Phase 3 — Options Lab
- **Tasks:** leg-wise explainer; one page per Options Lab screen; two walkthroughs; options glossary.
- **Done when:** every Options Lab screen has a page and every link resolves.

### Phase 4 — Data & operations + help links
- **Tasks:** Overview, Coverage, Jobs, Broker logins, Settings pages; `GuideLink` on every
  documented screen.
- **Done when:** each documented screen links to its page.

### Phase 5 — Upkeep rule
- **Tasks:** `apps/dashboard/CLAUDE.md`: a change to a screen's controls or metrics updates its
  guide page in the same commit; test that every registry `screen` exists in `NAV_GROUPS`.
- **Done when:** the rule is written and the test is in CI.

## Risks

- Guide pages go stale as screens change. Mitigation: the upkeep rule, the link test, and one
  template per page so a missing control is easy to spot.
- Defaults quoted in the guide drift from the code. Mitigation: describe what a control does and
  where to see its current default, quote numbers sparingly.

## Open questions

Answered 2026-10-07 (below).

## Log

- 2026-10-07 — Phases 1–5 built on branch `feat/bl-041-in-app-guide`: Guide tab (Help group, last,
  cannot be hidden), `/guide/<chapter>/<page>` with `/help` and `/docs` aliases, 5 chapters /
  29 pages (4 introduction, 10 Momentum, 9 Options Lab, 5 operations, 1 glossary page of 64 terms),
  search, hover glossary terms, "Open this screen", and a "How this works" link in the top bar of
  every documented screen (looked up from the registry, so it cannot point at a missing page).
  Checks: 944 dashboard tests, typecheck, Biome and a production build pass; clicked through in
  the browser at desktop and phone width. **Decision recorded:** the help link lives once in the
  top bar rather than in each view's header, so a new screen gets it by having a registry entry.
  **Not yet done:** the owner has not read the wording; the quoted defaults were spot-checked
  against the code (top N 5, exit rank 10, 0.10% cost, 35% ETF cap, Broad pool 200/250, categories 4/8,
  coverage floor 40%, 2 picks per category); the Broad per-stock/sector caps and the ₹20,000
  price ceiling come from `docs/momentum-parameters-plain-english.md`, so the page tells the
  reader to read them off the form instead.

- 2026-10-07 — created and started. Owner's answers: track as a backlog item, then build; a
  separate Guide section **and** "How this works" links on each page; reader knows the basics
  but is new to the tool; include glossary, strategy explainers, worked walkthroughs, and
  limits & caveats.
