# BL-221 — Fridays by family: how Widesl, Dir and Buy behave on the day furthest from expiry

| | |
|---|---|
| **Priority** | P2 — explains BL-220's pattern and tells which family carries it; descriptive, no rule |
| **Status** | Done — descriptive: far from expiry, Friday earns about nothing; the gap is the SENSEX Dirs and the afternoon, under 2 SE |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-12 |
| **Depends on** | none. Shares its trigger with [BL-220](BL-220-friday-size-down.md) and must not read BL-220's hold-out |
| **TODO.md row** | 3.10.68 |

## Context

The owner asked (2026-11-12), after the weekday read in BL-220, for "another research on Friday on how
widesl, dir, and buy works". The first look, over the 298 stored strategies (2025-01-10 → 2026-11-11,
0.5 % slippage after costs, ₹ per strategy-day), already split by family:

| Family | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Widesl NIFTY | 140 | 372 | −39 | 14 | 47 |
| Widesl SENSEX | −34 | 195 | −150 | 20 | −90 |
| Dir ATM NIFTY | 162 | 220 | −97 | 106 | 79 |
| Dir ATM SENSEX | 46 | 442 | −111 | 227 | 37 |
| Dir ITM1 NIFTY | 195 | 228 | −118 | 121 | 76 |
| Dir ITM1 SENSEX | 74 | 507 | −92 | 308 | 39 |
| Premium (₹80–₹320) NIFTY | 87 | 318 | −15 | −73 | −2 |
| Premium SENSEX | −37 | 163 | −140 | −60 | −52 |
| Buy NIFTY | −122 | −60 | −17 | 62 | −19 |
| Buy SENSEX | −27 | −3 | 11 | 14 | 15 |

So on Fridays the selling families are near zero and SENSEX Widesl is negative. Dir stays slightly
positive and Buy is flat, as it is every day. The family research pages (`research/options/strategies/*/weekday.md`)
hold BL-056's one-regime weekday means and say that within one regime weekday equals days to expiry.
This item asks **how** each family loses its edge on Fridays, not **whether** to act on it.

## Goal

A findings section per family (Widesl, closest-premium Widesl counted under it; Dir ATM / ITM1; Buy), per
index, stating for Fridays against the other days:

- where in the session the money is made or lost (09:17–10:00, 10:00–13:00, 13:00–15:28), from the stored
  per-day results and the minute paths;
- how the exits happen (leg SL, MTM SL, trail, time exit) and how often;
- the premium collected at entry and its decay by 15:28, by weekdays to expiry;
- whether entry time changes the Friday picture (morning vs afternoon starts);
- VIX band and opening gap on Fridays against other days, to rule out a Friday-specific market;
- each of the above in two expiry calendars: **Jan–Aug 2025** (NIFTY expired Thursday, SENSEX Tuesday:
  a Friday was 6 / 4 calendar days from them) and **Sep 2025 – Nov 2026** (NIFTY Tuesday, SENSEX Thursday:
  4 / 6 days). Owner, 2026-11-12: **expiry Fridays are left out of every table.** Every Friday from
  2024-10-11 to 2025-01-03 was a SENSEX expiry day (11 Fridays; 2024-10-25's label reads `unknown`), so that
  stretch (2024-10-09 → 2025-01-03, 59 sessions) is left out whole; no Friday after it was an expiry day.

## Out of scope

- Any trading rule or Friday size change (BL-220 owns that).
- **NIFTY 2022-04-05 → 2024-10-08 and any day from 2026-11-13 on**: BL-220's hold-outs. This item reads
  only 2024-10-09 → 2026-11-12, which is already spent.
- New engine sweeps. It reads stored results and replayed paths only.

## Plan

### Phase 0 — Pre-register
Descriptive only: no pass / kill rule, no verdict that changes a setting.
- **Hypothesis (to describe, not test):** selling families earn less on Fridays because intraday decay is
  slow far from expiry, so the leg SLs take a larger share of the day's result.
- **Universe:** the 298 stored strategies (Core-298) as the main table, and T1's 223 extra strategies
  (`rotation/track_t1/results/`) as their own rows, flagged in-sample (they were tuned on these days);
  2024-10-09 → 2026-11-12, point-in-time weekdays to expiry from `rotation/days.csv` (`store.read_days`).
- **Figures:** net after costs at 0.5 % slippage (the dashboard's and the 16:00 message's basis) with gross
  beside it; one lot per strategy-day; a mean always with its standard error and number of days.
  Clarified 2026-11-12, before the full run: the rotation strategy files carry no costs (stored `costs` is 0),
  so "net" here is after 0.5 % slippage and before brokerage; a second figure subtracts brokerage the way
  Lot plans does (₹20 × 1.18 × 2 per trade, `rotation/lot_plans.py`).
- **Source of the intraday splits:** each strategy-day replayed with the nightly update's own call
  (`legwise.engine.simulate_day`, the strategy file, `SIZING_DATE`), as `rotation.portfolio._replay` does;
  about 1 s for all 298 on one day (timed 2026-11-12), so the whole span runs, no sampling. A replay must
  reproduce the stored net; a strategy-day that does not is reported and left out. Clarified 2026-11-12
  after a four-day smoke run (all 405 mismatches on 2026-11-06, the other days to the paisa) and before the
  full read: a day where 5 % or more of its strategy-days are not reproduced had its data changed after
  it was stored, and is left out whole, so no session mean mixes the two.
- **Look-ahead check:** none needed for a description; every split uses only the day's own data.
- **Hold-out:** none here, on purpose: BL-220's two hold-outs are not to be read.
- **Will not run:** anything on 2022–24 NIFTY or after 2026-11-12; any rule test.

### Phase 1 — Tables from stored results
- **Tasks:** per family × weekday × regime: mean, median, win rate and share of days stopped, after costs
  and 0.5 % slippage; exit-reason counts from the trade-level results (`--trades`).
- **Deliverables:** the tables in this file.
- **Done when:** every family has its Friday row with a standard error.

### Phase 2 — Intraday path and premium
- **Tasks:** from the replayed minute paths (the portfolio path cache), the P&L by session window and the
  premium at entry versus 15:28, by weekdays to expiry.
- **Deliverables:** one short findings paragraph per family.
- **Done when:** each paragraph says where on a Friday that family's result comes from.

### Phase 3 — Close
- **Tasks:** add a "Fridays" section to `research/options/strategies/{widesl,directional,buy-breakout}/weekday.md`
  citing this item, in the same commit as the item's close.
- **Done when:** the pages cite this item and INDEX shows Done.

## Findings (2026-11-12; expiry Fridays left out, owner the same day)

Run: `research/bl221/replay.py` (every Core-298 and T1-extra strategy on every stored weekday session
2024-10-09 → 2026-11-12, 0.5 % slippage, 402 s; 2026-11-06 left out whole: 405 of 521 not reproduced, its
data changed after it was stored; no other day had a mismatch) and `research/bl221/analyse.py` (tables in
`out/summary.md`, git-ignored). The stretch 2024-10-09 → 2025-01-03 is left out: its Fridays were SENSEX
expiry days. What remains: Jan 2025 → Nov 2026, 87 Fridays and 361 other sessions, 233,408 strategy-days.
Means are per strategy-day at one lot, averaged within each session first, ± one standard error over
sessions; before brokerage unless said. Descriptive: no test, no rule.

**1. Far from expiry, Friday nets about zero.** Core-298, net, Friday against the other days:

| Family | Fri, Jan–Aug 2025 (31) | Fri, Sep 2025 – Nov 2026 (56) | Other days, Jan 2025 – Nov 2026 (361) |
|---|---|---|---|
| Widesl NIFTY | 189 ± 163 | −36 ± 151 | 97 ± 52 |
| Widesl SENSEX | 229 ± 170 | −185 ± 138 | 4 ± 54 |
| Dir ATM NIFTY | 16 ± 169 | 66 ± 131 | 98 ± 48 |
| Dir ATM SENSEX | 105 ± 171 | −55 ± 123 | 154 ± 47 |
| Dir ITM1 NIFTY | −15 ± 173 | 72 ± 147 | 108 ± 54 |
| Dir ITM1 SENSEX | 138 ± 180 | −74 ± 132 | 199 ± 53 |
| Buy NIFTY | −61 ± 68 | −11 ± 71 | −33 ± 28 |
| Buy SENSEX | −30 ± 21 | 32 ± 26 | −2 ± 9 |

Since Sep 2025 every selling family is at or below zero on Fridays; in Jan–Aug 2025 Widesl was positive.

**2. The Friday shortfall is Dir, mostly SENSEX, and it is under two standard errors.** Jan 2025 – Nov 2026,
Friday minus other days: Dir ITM1 SENSEX −₹198 (about 1.7 SE), Dir ATM SENSEX −₹152 (1.4 SE), the NIFTY Dirs
about −₹50 to −₹67 (under 0.5 SE); Widesl −₹41 to −₹53 (under 0.5 SE); Buy no difference. After brokerage
(₹47.20 a trade) every family is negative on Fridays; on other days only the SENSEX Dirs stay positive.

**3. Where the money goes: the afternoon.** Gross by session window (Friday | other days): 09:15–10:00
about zero for every family both ways; 10:00–13:00 Friday as good or slightly better (Dir SENSEX +₹60 to
+₹67 against +₹29 to +₹40); **13:00 to the close is where Friday falls behind**: Widesl NIFTY +₹30 against
+₹111, Widesl SENSEX −₹49 against +₹40, Dir ATM SENSEX −₹71 against +₹119, Dir ITM1 SENSEX −₹66 against
+₹152, the NIFTY Dirs +₹13 / +₹26 against +₹102 / +₹131. On other days (two of them expiry days) the
afternoon is when the premium falls fastest; on a Friday far from expiry it does not.

**4. Exits: Fridays are quieter, not more violent.** Sold legs hit their own SL less often on Fridays
(Widesl 1–3 % of trades against 9 %; Dir 36–41 % against 49–54 %), more trades run to the time exit
(Widesl 83–85 % against 79 %; Dir 52–57 % against 42–46 %), and Dir re-enters less (2.3–2.4 trades a day
against 2.6–2.7). MTM stops are about as frequent (Widesl 15–16 % of days both ways; Dir 11–15 % against
9–17 %). Friday's weak result is slow decay held to 15:28, not more stop-outs.

**5. Premium: more is sold, it does not decay more.** The first entry's premium is higher on Fridays (Dir
ITM1 SENSEX median 998 points against 735, Dir ATM SENSEX 896 against 632, Dir ATM NIFTY 258 against 195,
Widesl SENSEX 621 against 524), and its value at exit is about the same share (median 0.98–1.00 for the
sold families both ways). More premium sold for the same fractional decay, with a flat afternoon.

**6. Entry time.** The early Widesl (09:17–10:00 start) is the one cell clearly worse on Fridays (NIFTY −₹211 ±
227 against +₹213 ± 121; SENSEX −₹270 ± 230 against +₹137 ± 106); early Dir was not worse (+₹239 to +₹366).
Late starts (13:01 on) lose on Friday for Dir SENSEX (−₹152 / −₹156 against +₹66 / +₹80). Wide bands.

**7. The market itself is not different on Fridays.** Mean opening VIX on Fridays 14.5 (Jan–Aug 2025) and
13.5 (Sep 2025 on) against 14.0–15.0 on other weekdays; the median absolute NIFTY opening gap 0.17 / 0.24 %
against 0.17–0.31 %.

**8. By opening VIX (owner, 2026-11-12, descriptive; more cells looked at).** Core-298, Jan 2025 – Nov 2026,
expiry Fridays out, the day's band from `days.csv`; Friday | other days, ₹ per strategy-day ± SE (sessions):

| Family | VIX < 13 (43 Fri) | VIX 13–15 (18) | VIX 15–18 (16) | VIX 18+ (10) |
|---|---|---|---|---|
| Widesl NIFTY | −29 ± 148 \| 107 ± 66 | 114 ± 281 \| 55 ± 111 | 137 ± 290 \| 140 ± 136 | 81 ± 357 \| 84 ± 165 |
| Widesl SENSEX | −122 ± 133 \| 68 ± 75 | 91 ± 287 \| −32 ± 95 | 143 ± 278 \| −19 ± 155 | −195 ± 364 \| −100 ± 170 |
| Dir ATM NIFTY | 137 ± 95 \| 152 ± 64 | 39 ± 259 \| 91 ± 92 | −23 ± 297 \| 44 ± 119 | −200 ± 473 \| 12 ± 160 |
| Dir ATM SENSEX | **27 ± 89 \| 251 ± 63** | 233 ± 249 \| 95 ± 92 | −14 ± 331 \| 91 ± 117 | −497 ± 353 \| 37 ± 156 |
| Dir ITM1 NIFTY | 139 ± 111 \| 151 ± 79 | 43 ± 272 \| 110 ± 99 | −87 ± 327 \| 67 ± 128 | −181 ± 497 \| 28 ± 177 |
| Dir ITM1 SENSEX | **18 ± 99 \| 298 ± 72** | 287 ± 260 \| 153 ± 104 | −66 ± 360 \| 123 ± 129 | −478 ± 364 \| 70 ± 169 |
| Buy NIFTY | −87 ± 68 \| −39 ± 38 | 52 ± 112 \| 17 ± 76 | 80 ± 154 \| −11 ± 70 | −97 ± 119 \| −126 ± 45 |
| Buy SENSEX | 25 ± 25 \| 0 ± 13 | −19 ± 22 \| −1 ± 21 | 14 ± 62 \| −4 ± 18 | −8 ± 56 \| −8 ± 19 |

The SENSEX Dirs' Friday shortfall sits at VIX below 13 (half of the Fridays): ₹18–27 against ₹251–298, about
2–2.3 SE; the SENSEX Widesl is also below there. At VIX 13–15 Friday was not worse (18 Fridays). The books
(T1, Core, base, 8–22 Fridays a band) show no common VIX pattern. A lead for a registered test, not a finding.

**T1's extras** (in-sample, tuned on these days): Sep 2025 on, Fridays about zero (Widesl NIFTY +₹5, Widesl
SENSEX −₹106, the Dirs −₹18 to +₹57), while T1's Widesl SENSEX earns +₹421 to +₹608 Tuesday to Thursday.

**What this does and does not say.** It describes 87 Fridays far from expiry already read in the weekday
study; every gap is under two standard errors, and about 60 cells were looked at. It names where a Friday
rule would act (the SENSEX Dirs and the afternoon). It is not evidence for a rule: BL-220 tests that.

## Risks

- About 90 Fridays over two regimes: cells split by family, window and regime get small. Report the
  standard error with every mean and say when a gap is under the ~₹700 noise bar.
- Reading these days again adds to the multiple-testing count for any future rule built on them; that is
  why BL-220 tests on other days.

## Open questions

Answered 2026-11-12 (owner, at "start working on BL221"):

1. Closest-premium Widesl: **under Widesl**, not its own family.
2. The SENSEX-expiry Fridays (Oct 2024 – Jan 2025; asked as 14, the store has 11): first answered "their own
   row"; changed the same day (owner: "remove all the expiry Fridays"): **left out**, with the stretch they
   sit in.
3. T1's 223 extra strategies: **yes, as their own rows**, flagged in-sample.
4. Extra splits: no preference. Kept to the item's splits plus the entry-time bands already in the Goal;
   Friday-before-a-holiday and the monthly-expiry week left out (cells would be too thin).

## Log

- 2026-11-12 — created at the owner's request alongside BL-220. Nothing run.
- 2026-11-12 — started; the four questions answered (above), Phase 0 updated with them before any run.
- 2026-11-12 — Phases 1-3 done: full replay (508 days, 264,147 strategy-days, 2026-11-06 left out whole),
  findings above, research weekday pages updated. Closed.
- 2026-11-12 — owner: "remove all the expiry Fridays … don't say R-a, R-b". The stretch 2024-10-09 →
  2025-01-03 (every Friday a SENSEX expiry day) is left out of every table; periods are named by their
  dates (`analyse.py` updated; the replay is unchanged). The findings above are rewritten on what remains;
  no number from Jan 2025 on changed.
- 2026-11-12 — owner: "split friday by VIX". Finding 8 added (descriptive): the SENSEX Dirs' Friday shortfall
  is at VIX below 13; the books show no common VIX pattern.
