# BL-056 — Weekday, days-to-expiry and VIX-band breakdown of the 33 start-time variants, NIFTY and SENSEX

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-054 |
| **Status** | Done (descriptive; one year, 2025-09-01 onward; the earlier period is left for later) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-054 (its 33 NIFTY variant results) |
| **TODO.md row** | — |

## Context

BL-054 backtested 33 NIFTY variants (Widesl OTM1, Dir ATM, Buy breakout × 11 start times
09:17–11:47) over 2024-10-09 → 2026-10-08. The owner (2026-10-09 chat) wants the same 33 for
SENSEX, and for both indices each variant's performance by weekday, by days to expiry and by
India VIX at the 09:15 open. Descriptive only: no verdict. Any rule read off these tables (skip a
weekday, skip a VIX band) needs its own pre-registered item; this window has already been looked
at in BL-053/054/055.

Owner's decisions (2026-10-09): VIX bands `<10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 | 18+`;
SENSEX Dir and Buy keep the NIFTY rupee values; report weekday and days to expiry; no verdict.

## Goal

Three long-form tables per index (by weekday, by days to expiry, by VIX band), each cell with its
day count, and a short written summary of the strongest non-thin patterns.

## Out of scope

Any skip/size rule, other windows, other bands, changes to `strategies/legwise/`, a dashboard
screen.

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** none; descriptive.
- **Universe:** (window for the analysis: 2025-09-01 → 2026-10-08; see Dimensions) NIFTY — the 33 BL-054 variants as already run (`research/bl054/results/`, 489
  days, not re-run). SENSEX — 33 variants built the same way from three bases: the live
  `strategies/legwise/sensex_widesl_917_otm2.yaml` (OTM2, SL 114/115 % trailed 15/10 %, ₹2,500
  overall); `nifty_dir_924_itm1_sl21_recost.yaml` with `underlying: SENSEX` and `strike_type: ATM`
  (21 % SL, re-cost once, ₹3,000 overall, unchanged rupees); `nifty_buy_range_breakout.yaml` with
  `underlying: SENSEX` (₹50 premium, 25 % SL, ₹2,000 overall, unchanged rupees). Slots 09:17,
  09:32, … 11:47; exits per family unchanged; 1 lot, today's lot size, 1-minute bars, usable
  days, 2024-10-09 → 2026-10-08, before charges. SENSEX lot = 20 vs NIFTY 75, so SENSEX Dir/Buy
  rupees are not comparable with NIFTY's; stops bind less often on SENSEX.
- **Dimensions:** weekday Mon–Fri (Saturday and Sunday sessions dropped and counted); days to
  expiry (calendar days, 0–6; 7+ pooled) taken from the expiry dates in the lake itself — the
  nearest `contracts_daily.expiry` on or after the day with traded bars, per the owner's
  suggestion to read the expiry from the contract — cross-checked against
  `legwise.anatomy.dte_for`; a day where the two disagree → `unknown`; VIX band from the 09:15
  open of INDIAVIX (missing → `unknown`). All three tables (weekday, days to expiry, VIX
  band) cover only 2025-09-01 → 2026-10-08 (owner, 2026-10-09: one year, after NIFTY's expiry
  moved Thursday → Tuesday; SENSEX moved to Thursday the same day), about 13 months and one
  expiry regime per index. The earlier period (2024-10-09 → 2025-08-31) is left for a later
  block. The SENSEX backtests still run over the full two years so that block needs no re-run.
- **Per cell:** days, total, avg/day, win %, worst day, max drawdown of the days chained within
  the cell (labelled as such). Cells under 30 days are printed and flagged `thin`.
- **Look-ahead check:** none needed; descriptive, no decision is simulated.
- **Pass / kill rule:** none. Reconciliation only: each variant's cell totals sum to its
  whole-window total; `sensex_wide_0917` reproduces the live SENSEX strategy per day; NIFTY
  `wide_0917` total = ₹1,74,537 (BL-054).
- **Hold-out:** none (owner override, same window).
- **Will not run:** other bands, other windows, any skip or sizing rule, Widesl premium versions.
- **Result:** descriptive, no verdict. Window 2025-09-01 → 2026-10-08, 267 weekdays per index (the Sunday
  1 Feb 2026 session dropped); 33 variants × 3 tables per index; cell totals reconcile with each
  variant's total; `sensex_wide_0917` equals the live strategy (₹1,86,287 over the full two
  years); one SENSEX day (30 Sep 2026, contract not collected) is `unknown` for days to expiry.
  Expiry weekday in the window: NIFTY Tuesday on all 267 days, SENSEX Thursday on all 267. Within a
  single regime weekday and days to expiry are the same split (NIFTY Tue = 0, Mon = 1, Fri = 4,
  Thu = 5, Wed = 6). Averages are family means over the 11 start times, ₹ per day per lot.
  **NIFTY, weekday (Mon Tue Wed Thu Fri; 52–55 days each):** Widesl 190 673 −73 −39 40; Dir ATM 563 602
  −67 392 355; Buy −88 −43 64 287 −6. By days to expiry (0, 1, 4, 5, 6): Widesl 616 216 17 −57 −52 — a
  steady fall away from expiry. **SENSEX, weekday:** Widesl −204 426 51 264 −191 (no gradient); Dir 260
  829 213 436 318; Buy −17 −17 87 61 56. **VIX band at open** (<10.5, 10.5–11.5, 11.5–13, 13–15,
  15–18, 18+; days 35/50/70/45/24/43 NIFTY, 34/49/70/47/24/43 SENSEX): NIFTY Widesl 231 74 375 227 68
  −179, Dir 625 449 381 383 −248 366, Buy −24 269 −94 201 62 −128; SENSEX Widesl 112 82 175 254 −401
  −104, Dir 537 407 530 409 −126 412, Buy 1 91 −4 36 60 37. Common to both indices: Widesl weak at 18+
  and Dir and Widesl weak at 15–18 (24 days, thin). The two indices trade the same market days, so
  that is not independent confirmation. Per-start-time tables: `research/bl056/out/`. About 1,100
  cells were looked at, and a weekday cell's standard error is roughly ₹300–400 a day, so differences
  under about ₹700 between cells are not distinguishable from noise.

### Phase 1 — SENSEX runs
- Generate `research/bl056/variants/` (33 files) from the three bases; run each; per-day CSVs in
  `research/bl056/results/`. Done when 33 files share one day set and the 09:17 Widesl check holds.

### Phase 2 — Analysis
- `research/bl056/analyse.py` → `research/bl056/out/{nifty,sensex}_by_{weekday,dte,vix}.csv` and a
  printed family × slot heat table per dimension. Done when totals reconcile and the summary is
  in Result.

### Phase 3 — Report
- Chat summary; offer an HTML page. Note ~530 cells per index, so some will look striking by
  chance.

## Risks

- Weekday over two years mixes expiry regimes (NIFTY Thu→Tue, SENSEX moved too); the
  days-to-expiry table is the one to read for "expiry effect".
- Vendor gap (BL-040) and uncollected expiring contracts (e.g. SENSEX 2026-09-30) thin some cells;
  skipped days are counted.

## Log

- 2026-10-09 — before any SENSEX result was read: days to expiry now comes from the contract expiry
  dates in the lake (owner's suggestion), calendar function as cross-check; checked on both indices —
  490 days each, no gaps, equals the lake's own dte column; the calendar disagrees on 6 SENSEX days
  in Oct 2024 (nearest weekly contract missing from the data) → `unknown`. Expiry weekday: NIFTY
  Thu → Tue (about Sep 2025); SENSEX Fri → Tue → Thu (about Aug 2025).
- 2026-10-09 — before any SENSEX result was read: owner restricted the weekday analysis to
  2025-09-01 onward (one expiry regime per index); the extra latest-regime table is dropped.
- 2026-10-09 — before any SENSEX result was read: owner restricted the whole analysis (all three
  tables) to 2025-09-01 → 2026-10-08, the earlier period "later". Thin cells will be more common
  (about 290 days spread over 6 VIX bands); they stay flagged, not hidden.
- 2026-10-09 — created; owner chose bands, SENSEX rupee values, both weekday and dte, no verdict.
