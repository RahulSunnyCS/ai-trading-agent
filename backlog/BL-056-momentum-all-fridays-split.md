# BL-056 — Momentum: backtest and follow a config with its money split across every rebalance Friday

| | |
|---|---|
| **Priority** | P0 — set by the owner (2026-10-09); how real money should follow any config that trades every 2 or 4 weeks |
| **Status** | In progress (started 2026-10-09) |
| **Type** | feature |
| **Area** | momentum / dashboard |
| **Created** | 2026-10-09 |
| **Depends on** | BL-051 (saved-run groups), BL-054 (the measurement below) |
| **TODO.md row** | 3.12.19 |

## Context

A config that rebalances every K weeks has K possible trading calendars (`Config.rebalance_offset`
0..K-1). Which one you pick is luck. On the 10 top Broad configs (BL-054 L2,
`packages/momentum-backtesting/docs/bl054-levers-2026-10-09.md`), pre-tax:

| Median over 10 configs | CAGR |
|---|---|
| Luckiest single Friday | 43.8% |
| The Friday the search picked | 41.3% |
| All Fridays, money split equally | 40.4% |
| Unluckiest single Friday | 35.1% |

Five Sectors Monthly alone runs from 34.6% to 44.8% purely by calendar. Splitting removes the
gamble; it does not raise the average. Every after-tax number in BL-054 already assumes the
split. The owner (2026-10-09) wants it in the dashboard, both to backtest and to follow with
money.

**Measured after tax at Rs 5 lakh, 2017-2026** (`scripts/bl054_phase_split.py`, output
`data/search/round7_A/bl054/phase_split/phase_split.csv`): the split's worst fall is shallower
than the typical single Friday's in 10 of 10 configs (median -27.6% against -31.1%; the
unluckiest Friday -35.7%) and its Ulcer index is lower in 10 of 10 (9.9% against 10.8%), in
both FY2018-22 and FY2023-26; CAGR lands mid-range (31.5%, single Fridays 27.5% to 33.9%). A
measurement, not a pre-registered test, but consistent across every config and both windows.

**What already exists (reuse, do not rebuild):**
- `packages/momentum-backtesting/src/momentum_backtesting/tranches.py`: K equal sub-portfolios on
  staggered offsets, `capital / K` each, curves averaged; separate tax ledgers (documented as
  slightly pessimistic).
- `method._score_group` and `scripts/bl054_levers.py`: every phase, blended by
  `pd.concat(phases, axis=1).mean(axis=1)`.
- `api.py`: `BacktestRequest.rebalance_every` / `rebalance_offset`; background jobs with stages
  and lazily built sections (`analysis.payload_parts`, `run_parts.RunParts`,
  `GET /api/backtest/jobs/{id}/sections/{name}`). A new section needs `api.BacktestSection` and
  `MomentumSectionName` in `apps/dashboard/src/types/momentum.ts`.
- Saved-run groups (BL-051): `runs_store.create_group`, `POST /api/saved-runs/groups`;
  `groups.py` combines sleeves' weekly signals into one Telegram message; the Phase 6 ensemble is
  already a group of four sleeves on different Fridays. `SavedStrategiesView.tsx` has
  `createGroup()`.
- Settings: `components/momentum/MomentumSettingsPanel.tsx`, `lib/momentumConfig.ts`.

## Goal

1. A backtest can be run "All Fridays": the blended curve, plus each Friday's figures.
2. A favourite run "All Fridays", and every favourite with rebalance_every > 1 that exists today
   (migrated once), is followed on all Fridays: one group, one sleeve per Friday, one Telegram
   message per week, every sleeve journalled (owner, 2026-10-09).
3. The Rebalance preview previews such a favourite (and any group) as the whole account: every
   sleeve's target, weighted by its value since the April reset, against the actual holdings.
4. A backtest's result changes only when "All Fridays" is switched on for it.

## Out of scope

Changing the frozen Phase 6 ensemble (already a group of sleeves on different Fridays, left as
it is); any new research; weekly (every = 1) configs, which have only one calendar.

## Plan

### Phase 1 — API
- **Tasks:** `BacktestRequest.split_fridays: bool = False` (meaningful only when
  rebalance="weekly" and rebalance_every > 1): run every offset with `capital / K` and return the
  blended equity as the run's curve, equal capital restored at each April reset
  (`choose.ensemble_curve`, `groups.reset_weeks`); separate tax ledgers per sleeve, labelled
  slightly pessimistic. A lazily built `friday_spread` section with each offset's CAGR, max
  drawdown and Ulcer (after tax when the request is taxed). The flag is in the request key; in
  `saved_identity` it is dropped when off (so no existing fingerprint moves) and kept when on.
  Broad ranking is shared across offsets (the offset is not in its cache key).
- **Done when:** a test shows the split result equals the April-reset blend of the per-offset
  runs; the flag is in the key and (when on) the fingerprint; existing fingerprints unchanged;
  momentum goldens unchanged.

### Phase 2 — Dashboard backtest
- **Tasks:** a "Fridays: One / All (split)" `SegmentedControl` beside the rebalance cadence
  (disabled when every = 1); a "Friday luck" card (each Friday against the split), following the
  Analytics page pattern, `components/ui/` controls, `lib/format.ts` and design tokens; the
  Guide pages for the changed screens in the same commit.
- **Done when:** dashboard unit tests and `bun run --filter @ata/dashboard typecheck` pass and the
  card renders on a real Broad run.

### Phase 3 — Follow on all Fridays
- **Tasks:** favouriting a saved run that was run "All Fridays" follows it on all Fridays: save
  one run per offset (same config, `rebalance_offset` 0..K-1, capital / K) and `create_group`
  them as "<strategy> · all Fridays"; respect `MAX_FOLLOWED` (the group takes one slot) and the
  status rules. A run on one Friday is favourited as it is today. Existing every-2+ favourites
  are migrated once to all Fridays by `mbt saved split-fridays [--apply]` (dry run by default;
  applied to the live catalog only after the owner says so).
  On This week, the group's card names the sleeve trading this Friday and shows its orders at its
  capital share; the other sleeves are listed with their next Friday.
- **Done when:** a test creates the group on favouriting, the conversion's dry run lists the
  live favourites it would change, the weekly job journals each sleeve, and the group's Telegram
  message names this week's sleeve and its orders.

### Phase 4 — Rebalance preview for a group
- **Tasks:** `/api/rebalance-preview` accepts a favourite group (all-Fridays or any other, e.g.
  the ensemble): run each sleeve's model target, weight it by the sleeve's value since the last
  April reset (`groups.sleeve_value`; equal on a first allocation), and build one plan against the
  actual holdings. `MomentumRebalanceView` offers groups (today it filters them out), says which
  sleeve trades this Friday, and drops the strategy-start-date field for an all-Fridays group
  (every calendar is held, so the phase no longer matters). Guide page in the same commit.
- **Done when:** a test shows a group's target equals the value-weighted mix of its sleeves'
  targets, and the preview renders for a real all-Fridays favourite.

## Risks

- K times the compute for a split backtest (about 20 s becomes about a minute for a monthly
  config): keep it a background job.
- Tax: separate ledgers per sleeve understate how losses offset gains in one real account.
- More, smaller orders every week; the flat Rs 16 depository charge counts more.

## Open questions

Answered by the owner on 2026-10-09:
1. **Default:** the backtest's "All Fridays" is opt-in. A new favourite follows what its run was
   set to in the UI (All Fridays becomes a group of sleeves; one Friday stays one favourite).
   The favourites that exist today with rebalance_every > 1 are migrated once to all Fridays.
   The Rebalance page follows suit (Phase 4).
2. **April reset:** yes, equal capital each April (the groups / ensemble convention), in both the
   backtest blend and the followed group. The split figures therefore move slightly from
   BL-054's, which never rebalanced the sleeves.
3. **Tax ledger:** separate ledgers per sleeve, as `tranches.py` does. `tax.py` models no LTCG
   exemption and carries losses forward without limit, so the gap from one shared ledger is only
   timing; labelled slightly pessimistic.
4. **This week:** one group card naming the sleeve trading this Friday, its orders at its capital
   share, the other sleeves with their next Friday.

## Log

- 2026-10-09 — created at P0 by the owner, from the BL-054 L2 result.
- 2026-10-09 — the split-against-single-Friday measurement landed (above): shallower falls in 10 of 10.
- 2026-10-09 — started. Owner's answers recorded above; scope widened to every favourite and the
  Rebalance preview (Phase 4). Built on PR #152's branch (owner: do not wait for it). Number clash:
  an unpushed branch `research/bl-056-favourites-score-delay` also uses BL-056; the owner chose to
  keep this item's number and renumber that one when it is pushed. The phase-split fall-depth
  measurement (`scripts/bl054_phase_split.py`) was still running at start; cite it when it lands.
