# BL-102 — Options Lab redesign: three workspaces, lists first, a leg-grid builder

| | |
|---|---|
| **Priority** | P1 — the Options Lab is where the rotation is followed daily; today it is nine flat tabs that are hard to read |
| **Status** | In progress |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-14 |
| **Depends on** | none (BL-103 builds on Phase 1c and Phase 2) |
| **TODO.md row** | 3.28 |

## Context

Owner (2026-10-14): "redesign option backtesting page … in UX perspective, clean, and user
understand". A read-only review of every screen (screenshots in [assets/BL-102/](assets/BL-102/),
taken 14 Oct at 1280×860 on live data) found:

| Screen | What the screenshot shows |
|---|---|
| All | Two navigations for the same nine sections (pill tab bar in `OptionsLabView.tsx` and nested sidebar links in `shell/nav.ts`). Header pills "API · Closed · Connected" do not say what they mean. A red "1 issue" badge appears because `/api/meta` and `/api/payment/*` return 500 when `apps/server` is not running |
| Heatmap | Seven controls before the answer; the table and its "Total / Best cell" strip are clear |
| Rotation | Three rows of controls before any content; jargon status pills ("Chain ef10c45a… intact", "Base 491 days"); only skeletons, no message, for about 10 s |
| Builder | Two-pane layout works; "Load saved… / Start from… / New" is ambiguous; "File name" and "Strategy id" duplicate each other |
| Strategies | Leg summaries wrap into four lines; raw file ids as names |
| Runs | "Can't reach the YAML run registry" and "Builder experiments … not listed yet" shown as explanations |
| Regimes | A very long page of calendars |
| Correlation | Still only skeletons after 6 s, no "loading…" text |
| Matrix | Owner: already shows every view wanted — out of scope |
| Daily results | Owner: no longer used this way — retired in Phase 2 |

Nothing in Options Lab follows the Analytics page pattern (`apps/dashboard/CLAUDE.md`) that Momentum ›
Backtest uses. BL-058 Phase 3 (2026-10-09) marked several screens "hide" for the rotation; it was
never applied.

Mockups were shown to the owner in the session and saved as [assets/BL-102/mockups.html](assets/BL-102/mockups.html).

## Goal

- One navigation with three workspaces: **Today**, **Explore data**, **Build and test**.
- Today, the landing page, answers "how are Steady, Calendar and Adaptive doing?" on the first screen.
- Every redesigned screen reads: breadcrumb → a question as the title → one-line explanation and
  "How to read this" → chips plus Change (settings drawer) → 3–4 headline numbers → one main chart or
  table → widgets below.
- A strategy can be built and backtested in the leg grid without reading the Guide.
- Lists and strategies can be starred; stars are the default selection in Correlation.

## Out of scope

- Matrix (unchanged, moved into Explore data).
- Daily results (retired in Phase 2; see the Log).
- New engine features: those are [BL-103](BL-103-options-backtesting-features.md).
- Changing any registered rotation rule, list, weight or the journal (BL-058).

## Plan

### Phase 1 — Structure and wording (PR 1)
- **Tasks:**
  - Three workspaces in the sidebar; remove the pill tab bar. Today = the Rotation page (new
    default section, was Heatmap); Explore data = Heatmap, Matrix, Correlation, Regimes; Build and
    test = Strategies, Builder, Runs.
  - Hide Daily results: `/optionslab/results` redirects to Today; Strategies' "View results"
    points to Runs filtered by the strategy; Overview's link points to Today.
  - Edit `OPTIONS_LAB_SECTIONS` / `OPTIONS_LAB_DEFAULT_SECTION` (`lib/routes.ts`), `nav.ts` and the
    guide registry together; keep old URLs and the `?load=` / `?strategy=` deep links working.
  - A one-line "what this answers" header and a "How to read this" link on every screen.
  - Glossary tooltips on Widesl, Dir, REF, DTE, PBO, composite, VIX band; DTE says calendar days.
  - Housekeeping: the stale comment in `App.tsx`, the repeated paragraph in `apps/dashboard/CLAUDE.md`.
- **Deliverables:** one PR; Guide pages updated in the same commit.
- **Done when:** typecheck and dashboard tests pass (routes, navigation, guide registry); a
  Playwright smoke spec loads every section, `/optionslab` lands on Today and `/optionslab/results`
  redirects.

### Phase 1b — Strategies and baskets, favourites, Correlation picker (PR 2)
- **Tasks:**
  - `GET` / `PUT /legwise/favourites` (`api/favourites_routes.py`, `favourites.py`), stored in
    `TRADING_DATA_ROOT/options_lab/favourites.json`, atomic writes; default Steady, Calendar,
    Adaptive. Fastify proxy route (no credit). `hooks/useFavourites.ts` with optimistic toggle.
  - Correlation selectors `list:A|B|C|REF|base`: a list's daily gross, recorded journal days plus
    reconstructed earlier days (`daylog.reconstruction`, as `rotation/basket.py`), flagged.
  - **Strategies and baskets** page replaces Strategies: basket cards (Steady, Calendar, Adaptive;
    Baseline and Fixed base as comparators) and the strategy table, each with a star, Open and
    Correlate.
  - **New strategy** dialog: index; From a template (Short strangle OTM1 09:17; Buy range breakout
    ₹50; Short strangle at a premium ₹X), Copy an existing strategy (starred first), Blank.
    Templates are built in TypeScript, modelled on `nifty_widesl_917_otm1`,
    `nifty_buy_range_breakout`, `nifty_widesl_917_closest_premium`.
  - Correlation multiselect grouped Lists / Strategies, opening on the starred items; the URL
    query still wins.
- **Deliverables:** one PR with pytest and vitest coverage; Guide `strategies.md`, `correlation.md`.
- **Done when:** a star set on one screen is the default on Correlation after a reload, and a list
  correlates against a strategy with reconstructed days labelled.

### Phase 1c — Builder editor, design A "leg grid" (PR 3)
- **Tasks:**
  - Header line: auto name (editable), file id derived (the separate File name / Strategy id
    fields go), status badge, Open…, New, Save, Backtest with a settings popover (period, lot size
    today's / as it was, bars 1 / 5 min, bad-data days skip / include, costs, compare with).
  - Strategy token strip (Index, Enter, Exit, Max loss, Target, "Leg stops → exit that leg / all";
    optional tokens only when used).
  - Leg grid: one 32 px row per leg (B/S, Lots, Type, Expiry, Strike, Stop, Trail, Target,
    Re-entry), click-to-edit cells with keyboard navigation; range breakout and re-entry details in
    a per-leg drawer; "Edit both legs together" links a CE/PE pair.
  - "In plain words" read-back and validation under the grid; "View as YAML" read-only.
  - `POST /legwise/backtest` gains optional `bars` and `include_excluded` (defaults unchanged).
  - The old YAML engine leaves the Form | YAML switch (moves under Advanced in Phase 3).
- **Deliverables:** one PR; Guide `builder-form.md` rewritten.
- **Done when:** all five saved strategies load and serialise back byte-identical; a template can
  be backtested from the grid without leaving it.

### Phase 2 — One page layout (Analytics page pattern)
- **Tasks:** extract `Widget` from `MomentumResultWidgets.tsx` into `components/ui/`. Today: three
  list cards (focus = highlighted card), hero chart of the three lists plus the dashed fixed base,
  then widgets in bands — Track (Day by day, Drawdowns, Why these picks?), Diagnose (Pulse, Drift,
  Rank predicts, Regime), Experiments (Shadow scoreboard, collapsed); the status pill absorbs the
  health strip, read-out banner and evening-run bar; the portfolio stop is a run-bar chip; Baseline
  and random baskets move into Change. Builder result and Runs detail get headline + chart +
  widgets; Heatmap, Correlation and Regimes move their inline controls into chips plus a drawer.
  Loading states say "still working" after about 3 s.
- **Done when:** at 1600×1000 Today's first screen answers "how are the lists doing?" without
  scrolling.

### Phase 3 — Declutter
- **Tasks:** the YAML engine and Regimes go under an "Advanced" disclosure; hide the "1 issue"
  noise when `apps/server` is down.

## Risks

- The routes / nav / guide registry tests keep sections in step; hiding a section breaks deep
  links unless the redirect is added in the same change.
- Stacked PRs touch the same registration files (`routes.ts`, `nav.ts`, `guide/registry.ts`,
  `routes/backtest.ts`, `app.py`): merge in order, keep both sides on conflict.
- The main checkout runs the scheduler: build in a worktree only.

## Open questions

None open; the owner answered them on 2026-10-14 (Log).

## Log

- 2026-10-14 — created from a review session with the owner. Answers: three workspaces with
  sidebar navigation only; landing page Today; Today is about the Steady, Calendar and Adaptive lists,
  not individual strategies; Daily results hidden; Matrix unchanged; Correlation gets a multiselect
  over lists and strategies defaulting to favourites, starred on a new Strategies and baskets page;
  New strategy templates are Short strangle, Buy range breakout and Short strangle at a premium;
  Builder design A (leg grid) chosen over a sentence design and a collapsible-sections draft.
  Delivery: backlog first, then Phase 1, 1b, 1c as separate PRs. Phase 1 started.
- 2026-10-14 — Phase 1 built. Deviation from the plan: Daily results is hidden from the sidebar but
  its URL still opens the page (it does not redirect to Today yet), because the evening run's Run
  button lives only on that page until Today's status pill exists (Phase 2); the redirect lands
  with that. Strategies' "View results" now opens Runs filtered by the strategy (`?strategy=`). No
  separate "How to read this" link was added: the top bar already carries "How this works" for
  every screen.
- 2026-10-15 — Phases 1b, 1c and most of 2 built and reviewed (PRs #213 to #222). Notes where the
  build differs from the plan: Today's bands are What happened (day log, with drawdowns and
  selection drift), Is the rule still working? (why a pick and the pulse, market context) and
  Experiments, not the plan's Track / Diagnose grouping (drift sits with drawdowns, "why a pick"
  with the pulse); the Builder's backtest settings are inside the Run panel, not a popover on the
  button; lot size (`execution.lot_sizing`) is not exposed yet; a Family-pulse link to the Matrix
  and back lands on Today with the accordions closed (the open accordion is not in the URL).
- 2026-10-15 — Daily results retired as planned: `/optionslab/results` redirects to Today (PATH_ALIASES),
  Today carries the evening run's status and Run button (`EveningRunBar`), and the page's
  components (ResultsPanel, ComparisonTable, DayGrid, DayTypeCard, PnlScatter) and two Guide pages
  (daily-results, walkthrough-losing-days) are deleted. This is a change from the plan, which kept
  the code so the page could come back; the owner asked for the page to go once Today carried the
  run bar. DayForensics stays (the day log opens it); the anatomy chips and the Daily-results
  parts of `lib/legwiseResults.ts` / `legwiseJoin.ts` are now unused and left for a clean-up.
- 2026-10-15 — Phase 3: Regimes is its own Advanced group in the sidebar and the Builder's YAML
  mode is labelled "YAML engine (advanced)". Heatmap has chips and a drawer (PR #224). Not done: moving Correlation and Regimes
  inline controls into a run bar plus drawer (Phase 2's last bullet, "only if time allows").

