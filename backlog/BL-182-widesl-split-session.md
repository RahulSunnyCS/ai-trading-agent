# BL-182 — Widesl split session: 09:17–12:00 plus 13:00–15:28 against the whole day

| | |
|---|---|
| **Priority** | P1 — the owner trades Widesl with real money on Core and T1; a friend's study says the split earns ₹160 a day more per lot with half the drawdown |
| **Status** | Done 2026-10-28: not adopted. Phase 1 killed on its rule (+₹39 NIFTY / +₹89 SENSEX a day net, intervals include zero); Phase 2 (owner override: Adaptive two morning + two afternoon Widesl vs its top two whole-day, Core's six families) also failed its rule: +₹75 [−56, +205] net per margin lot-day, gross +₹158 [+27, +288], drawdown shallower, the gain confined to one of the two years; E1 (the split's sets at a ₹2,000 stop) worse on both counts |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-058 (the Core-298 files and stored results), BL-113 (the T1 settings), BL-063 (the charge model, `ruletest/charges.py`) |
| **TODO.md row** | §3.10.47 |

## Context

A friend of the owner suggested (2026-10-28) that the live Widesl is better run as two trades a day:
sell in the morning, close at 12:00, sell again at 13:00 and close at the end of the day. The friend's
own dashboard ("NIFTY Lot Allocator", a claude.ai artifact, Playground tab) backs it with a table:
NIFTY OTM1, 115 % leg stop, no trail, ₹2,500 MTM stop per set, one lot of 65, ₹40 costs a set,
2024-09-25 → 2026-10-27, 510 days:

| | Split 09:17–12 + 13–15:29 | All day 09:17–15:29 |
|---|---|---|
| Total after its costs | ₹222,681 | ₹139,929 |
| Days in profit | 60 % | 53 % |
| Max drawdown | −₹18,409 | −₹40,316 |

Its hourly grid for a set held from 09:17 shows 12:00–13:00 losing on every strike row (about ₹47 a
day for OTM1) and 13:00–15:29 earning twice what 09:17–12:00 does; by days to expiry the midday loss sits
in the 1-DTE and 6-DTE buckets only. The edge is concentrated: April–June 2025 and January–March 2026
hold ₹59,000 of the ₹82,752, and four of nine quarters are flat or negative. No interval is given.

The study's whole-day baseline reconciles with this repo: our stored `N_wide_0917` (trail 15/10, MTM
₹2,500) earns ₹326 a day gross over 501 days from 2024-10-09; the study's whole-day figure is about ₹314
a day before its costs, its trailing version ₹435. So the data is plausible; what the study lacks is a
realistic charge model (ours is about ₹90–100 a set, theirs ₹40), an interval, SENSEX, the live and T1
definitions, and any unseen days.

What the split changes mechanically: a fresh set at 13:00 is re-centred on spot and carries a fresh
MTM budget, so a morning stop-out no longer ends the day; the 12:00–13:00 hour is not held; two sets
pay two sets of charges and the afternoon premiums are smaller, so the percent stops are tighter in
rupees. The repo's own evidence (`research/options/strategies/widesl/exit-time.md`,
`entry-time.md`) says no exit earlier than 15:28 made a top-four list (12:00 was never tried) and
that the start-time curve is flat before charges.

Owner (2026-10-28): reproduce the split on our engine with our charges, both indices and the T1
settings, with the block bootstrap; if it holds, the Adaptive version (top two Widesl in the morning,
top two in the afternoon, from T1's Widesl pool, Dir and Buy left out) follows as a parallel track.

## Goal

A verdict, against the rule below, on whether the split beats the whole day for the live NIFTY and
SENSEX Widesl after our charges; the same numbers for the study's definition (as a reconciliation)
and the four T1 Widesl settings (descriptive); then, only on a pass, the Adaptive two-plus-two stage.

## Out of scope

Any change to a live file, list or pick. A search over the close or re-entry times. Conditional
afternoon entries. Slippage beyond the engine's fills. Anything traded.

## Plan

### Phase 0 — Pre-register (committed 2026-10-28 before any run)

- **Hypothesis:** a Widesl set sold at 09:17 and closed at 12:00, then a fresh set of the same
  definition sold at 13:00 (strikes chosen again from spot) and closed at 15:28, earns more per
  lot-day after charges than the same set held 09:17–15:28, with a max drawdown no worse.
- **Universe and data:** every usable NIFTY and SENSEX day in the lake from 2024-10-09 to
  2026-10-27 (`data_quality` verdict `usable`; excluded days skipped and counted), the legwise engine
  (`legwise/engine.simulate_day`) on the 1-minute bars with its default trigger-level fills, weekly
  expiry from the reference calendar, lot sizing `current` at the rotation's sizing date 2026-10-12
  (NIFTY 65, SENSEX 20), the research reference override of BL-080/BL-181 for days before the first
  lot-size row. Three runs per definition: whole day (entry 09:17, exit 15:28), morning (entry 09:17,
  exit 12:00) and afternoon (entry 13:00, exit 15:28). The split's day = morning + afternoon; the
  afternoon set enters whether or not the morning set was stopped, with its own full MTM stop.
- **Definitions (fixed, no search):**
  - **A, reproduction:** NIFTY OTM1, leg SL 115 %, no trail, MTM ₹2,500 — the study's split definition.
  - **B, live NIFTY:** `strategies/rotation/N_wide_0917.yaml` (OTM1, SL 115 %, trail 15/10, MTM ₹2,500). **Primary.**
  - **C, live SENSEX:** `strategies/rotation/S_wide_0917.yaml` (OTM2, SL 114/115 %, trail 15/10, MTM ₹2,500). Read on its own.
  - **D, T1 Widesl settings, descriptive:** `N_wide-t1s4` (OTM1, SL 150 %, trail 25/15, re-entry cost ×1,
    MTM ₹4,000), `N_wide-t1s8` (OTM1, SL 60 %, trail 15/10, MTM ₹3,000), `N_p150-t1s11` (₹150, SL 60 %,
    trail 15/10, MTM ₹4,000), `S_p285-t1s22` (₹285, SL 40 %, trail 25/15, re-entry cost ×1, MTM ₹4,000).
  The half-day files are the 09:17 file with only `exit_time` (12:00) or `entry_time` (13:00) changed.
- **Measure:** net per lot-day = gross − charges, charges from `ruletest/charges.py` (BL-063: ₹13 an
  order, STT on the sell value at 0.10 %, 0.15 % from 2026-04-01, exchange, SEBI/IPFT, stamp, GST),
  applied to each run's own trades (`trade_values`), so the split pays for both sets. Difference =
  split minus whole day on the same day. Reported per definition: mean net per lot-day of each book,
  the difference's mean and its two-sided 90 % interval from a circular 5-day block bootstrap (2,000
  resamples, seed 20261028), max drawdown per lot of each book's cumulative net, days in profit, and
  the same per half-year; the morning and afternoon halves alone, descriptive; before charges beside.
- **Pass / kill rule:** definition B passes if the difference's 90 % lower bound is above zero after
  charges AND the split's max drawdown is no deeper than the whole day's. C is read by the same rule on
  its own. A passes as a reconciliation if our whole-day and split totals before charges are each within
  15 % per day of the study's (₹314 and ₹477 a day; corrected to ₹517 after the run, see the Log). D is descriptive and decides only which settings
  the Phase 2 pool keeps. B fails → not adopted; the Log records everything and Phase 2 is not run.
- **Look-ahead:** every strike is chosen from the spot at its entry minute; stops and exits use bars
  up to that minute; the only free choices (12:00, 13:00) come from the friend's study, which was
  built on these same days, so the whole of Phase 1 is on **seen data** and can only reconcile and
  size the effect, not prove it. Hold-out: none remains for this period; the unseen test is Phase 3's
  forward track.
- **Will not run:** other close or re-entry times (11:30, 12:30, 13:02, 13:30), a 15:29 exit,
  skipping 12:00–13:00 only on some days to expiry, an afternoon set conditional on the morning's
  result, other strikes or stops, a per-quarter selection. Running any of these needs
  `override: <reason>` here.

### Phase 1 — Reproduce on our engine

- **Tasks:** `packages/option-backtesting/research/bl182/run.py` (variant files generated into its own
  folder, the three runs per definition, charges, the bootstrap, a results table); this Log; findings
  page `research/options/strategies/widesl/session-split.md` (new variable) plus rows in
  `widesl/README.md`, `exit-time.md` and `entry-time.md`.
- **Deliverables:** `research/bl182/out/summary.md` and `daily.csv` (git-ignored), the verdicts here.
- **Done when:** A, B, C and D each have their numbers against the rule and the pages are updated.

### Phase 2 — Adaptive two-plus-two (pre-registered 2026-10-28, before any run; opened by the owner's override, Log)

- **Hypothesis:** Adaptive choosing two Widesl for the morning (entries 09:17–11:47, exit 12:00) and two
  for the afternoon (entries 13:02–15:02, exit 15:28) earns more per margin lot-day after charges than
  Adaptive choosing two whole-day Widesl (entries 09:17–15:17, exit 15:28) from the same families, with a
  max drawdown no worse.
- **Universe (owner, 2026-10-28):** Core's six Widesl families only — NIFTY OTM1, ₹80, ₹100; SENSEX OTM2,
  ₹250, ₹320 (`strategies/rotation/N_wide, N_p80, N_p100, S_wide, S_p250, S_p320`); T1's own settings are
  left out because they were chosen on this period. Half-day variants = the family's 09:17 file with only
  `entry_time` / `exit_time` changed: 11 morning slots (09:17, 09:32 … 11:47; exit 12:00) and 9 afternoon
  slots (13:02 … 15:02; exit 15:28) → 120 half-day variants; the comparator pool is the same six families'
  25 whole-day slots (150, the Core-298 files themselves), re-simulated in the same batch so both sides
  share one engine version (their gross is checked against the stored `rotation/results/` and any
  variant-day that differs is counted and reported). Dir and Buy are out on both sides. Same engine, fills,
  sizing (`current`, 2026-10-12) and charges as Phase 1.
- **Ranking:** list C's composite exactly as the 09:16 job computes it (`score.composite` with C's weights
  and lookbacks, `family_index` for the family-band criterion, attributes from `rotation/days.csv`, the
  ranking read on gross as the live store's `net` is), run three times a day on three pools — morning
  (66 variants), afternoon (54) and whole-day (150) — and in each the top two by composite (ties by name;
  `score.select`'s order without the Dir swap or Buy). Both half-day picks are made at 09:16 on history up
  to the previous day. No expiry-day rule on either side (the replay of history never applies it). The
  first pick day is the 64th day of results (`WARMUP` = 63), so picks run from about 2025-01-10 to
  2026-10-27.
- **Measure:** book net per day = the sum of its picks' one-lot net after charges (split: 2 morning + 2
  afternoon; comparator: 2 whole-day). Per margin lot-day = book net ÷ 2, since a morning and an afternoon
  set use one lot of margin in turn (Phase 1's convention). Difference = split − comparator per margin
  lot-day; its mean with the 90 % interval from `readout.block_bootstrap_mean` (circular 5-day blocks,
  2,000 resamples, seed 20261028); max drawdown per margin lot (`readout.max_drawdown`); days in profit;
  gross beside net; at ₹13 an order and, reported only, Shoonya's ₹5. Also reported, descriptive: the same
  over T1's selection year (pick days to 2025-10-08) and the year after (2025-10-09 on), the morning and
  afternoon books alone, the picks' family and slot shares, and the whole-day book against Core Adaptive
  as traded (gross, from the stored results) for context.
- **Pass / kill rule:** pass if the difference's 90 % lower bound is above zero after charges at ₹13 AND
  the split's max drawdown per margin lot is no deeper than the comparator's, over the whole pick span.
  A pass earns Phase 3 (a forward paper track), never a trade. Fail → recorded; the split stays not
  adopted.
- **Look-ahead:** every composite reads only rows before the pick day; attributes are the day's own
  weekday, VIX band and days to expiry as the live job uses them. The 12:00 / 13:02 times and the two-plus-
  two shape are fixed above, chosen from the friend's study and Phase 1, which saw these same days: the
  whole phase is seen data.
- **Will not run:** other close or re-entry times, three-plus-three or one-plus-one books, an afternoon
  pick at 12:55, the expiry-day rule, T1's settings in the pool, any reweighting of the composite, a
  per-period selection. Any of these needs `override: <reason>` in the Log.
- **Tasks:** `research/bl182/phase2.py` (variants, simulation, parity check, replay, summary); the Log;
  `session-split.md` and the Widesl README row.
- **Done when:** the rule above has its verdict and the pages are updated.

### Phase 3 — Forward track (only on a Phase 2 pass)

- A parallel track like T1 (`--track`), private Telegram, 60 forward days, BL-058 pass rule.

## Result (2026-10-28, Phase 1)

501 NIFTY and 501 SENSEX days, 2024-10-09 → 2026-10-27; net after `ruletest/charges.py` (about ₹87 a
day for one set, ₹171 for the split's two); per lot-day; the interval is the registered 90 % 5-day block
bootstrap. Full tables: `research/bl182/out/summary.md` (git-ignored; `uv run python research/bl182/run.py
--analyse-only` rebuilds it from `results/`).

| Definition | Whole day net | Split net | Split − whole, net [90 %] | Split − whole, gross [90 %] | Max DD whole → split | Verdict |
|---|---|---|---|---|---|---|
| A study (NIFTY OTM1, no trail) | +236 | +331 | +95 [−62, +252] | +179 [+22, +336] | −43,252 → −22,685 | Reconciles: gross 323 / 502 a day vs the study's 314 / 517, both within 15 % |
| **B live NIFTY** (`N_wide_0917`) | +239 | +278 | **+39 [−107, +187]** | +123 [−22, +271] | −50,353 → −22,807 | **FAIL**: lower bound below zero (drawdown condition met) |
| **C live SENSEX** (`S_wide_0917`) | +260 | +348 | **+89 [−63, +241]** | +171 [+21, +323] | −41,554 → −27,379 | **FAIL**: lower bound below zero (drawdown condition met) |
| D `N_wide-t1s4` (SL 150, RE ×1, MTM 4,000) | +326 | +403 | +77 [−82, +237] | +162 [+3, +322] | −47,724 → −23,877 | descriptive |
| D `N_wide-t1s8` (SL 60, MTM 3,000) | +277 | +361 | +84 [−36, +207] | +168 [+47, +292] | −49,012 → −22,468 | descriptive |
| D `N_p150-t1s11` (₹150, SL 60) | +311 | +196 | −115 [−297, +76] | −15 [−197, +176] | −57,319 → −51,389 | descriptive: the split hurts |
| D `S_p285-t1s22` (₹285, SL 40, RE ×1) | +312 | +343 | +31 [−104, +177] | +113 [−20, +260] | −23,749 → −22,570 | descriptive |

What the numbers say:

- **The friend's study reproduces.** On its own definition our engine gives the same picture: the split
  earns about ₹180 a day more gross and halves the drawdown. The difference is charges: their ₹40 a set
  against our ₹87, so the second set costs ₹84 a day more here and the net edge shrinks to ₹95 for the
  study's definition and ₹39 for the live NIFTY file.
- **Before charges the split clears zero** for the study's definition, the live SENSEX file and both T1
  OTM1 settings (gross lower bounds +3 to +47). **After charges no net interval does.** The registered rule
  is net, so B and C fail and the split is not adopted; Phase 2 is not run.
- **The drawdown halving is the robust part**: every OTM1/OTM2 definition's max drawdown falls from
  ₹41–50k to ₹22–27k per lot, because the afternoon set is stopped a third as often as the whole day (42–47
  afternoon MTM stops vs 144–166 whole-day) and a morning stop no longer ends the day.
- **Where the halves earn:** NIFTY's two halves are alike (+141 / +138 net for the live file); SENSEX's
  morning carries it (+266 morning vs +83 afternoon, the whole day +260), so on SENSEX the split's gain is
  the fresh afternoon set, not a stronger afternoon. The closest-premium ₹150 NIFTY setting loses with the
  split (−115): its morning half earns only +53.
- **Not uniform in time.** For the live NIFTY file the split wins 2025 H1 (+18,896) and 2026 H1 (+23,047)
  and loses the other three half-years; SENSEX wins three of five. The study's own quarters showed the same
  concentration.
- All of it is seen data, as registered; the only unseen test would have been the forward track.

Lead, not a finding: a cheaper broker (the study's ₹40 a set) or a 1-lot owner who values the halved
drawdown over ₹40–90 a day of expected gain could still prefer the split; that is the owner's call, with
an `override:` here if Phase 2 is to run anyway.

## Result (2026-10-28, Phase 2)

434 pick days 2025-01-10 → 2026-10-27 after the 63-day warm-up; pools of 66 morning, 54 afternoon and
150 whole-day variants; list C's composite on each; per margin lot-day = book net ÷ 2. The 150 whole-day
re-simulations match the stored rotation results on all 75,150 variant-days (no gross differs by ₹1).
Full table: `research/bl182/out/phase2_summary.md` (git-ignored; `uv run python research/bl182/phase2.py
--analyse-only` rebuilds it from `results2/`).

| Book | Net / margin lot-day | Gross | Net at ₹5 an order | Days in profit | Max DD (net) |
|---|---|---|---|---|---|
| Top two whole-day Widesl (comparator) | +188 | +273 | +226 | 56 % | −16,987 |
| Top two morning alone | +64 | +149 | +102 | 60 % | −16,609 |
| Top two afternoon alone | +199 | +282 | +237 | 66 % | −15,775 |
| Split: two morning + two afternoon | +263 | +431 | +338 | 58 % | −13,978 |

Split − comparator per margin lot-day: **net +75 [−56, +205]**; gross +158 [+27, +288]; at ₹5 an order
+112 [−18, +243]. Max drawdown −13,978 vs −16,987. **FAIL** on the registered rule (the lower bound is
below zero; the drawdown condition is met).

| Period | Pick days | Split | Comparator | Difference [90 %] |
|---|---|---|---|---|
| T1 selection year (to 2025-10-08) | 184 | +255 | +77 | +178 [−28, +402] |
| The year after | 250 | +269 | +270 | −1 [−154, +156] |

What the numbers say:

- **Same shape as Phase 1, with Adaptive picking:** the split earns about ₹160 a day more gross per margin
  lot and clears zero before charges; after charges the edge is ₹75 and the interval runs through zero.
- **The edge is not stable in time.** With both indices it sits entirely in T1's selection year (+178) and
  is nil in the year after (−1). On NIFTY alone (an interim read before SENSEX finished) it was the
  reverse: level in the first year, +112 in the second. Two halves that disagree on which year carries it
  is the signature of noise, not of a rule.
- **The morning leg is the weak one** (₹64 a day net alone, the morning slots 09:17–09:47 picked most);
  the afternoon pair alone (₹199) beats two whole-day sets (₹188) with a shallower drawdown. The split's
  gain is the afternoon re-entry.
- **Against the real book:** Core Adaptive as traded (three picks, Dir allowed) makes ₹394 gross per
  lot-day over the same days, well above either Widesl-only book (273 / 431 gross per margin lot-day).
- Seen data throughout; the 12:00 / 13:02 times and the two-plus-two shape were chosen on these days.

Not adopted. Phase 3 (a forward track) is not opened on this result. The one lead worth keeping is the
afternoon-only Widesl pair, which would need its own pre-registration.

## Experiments

### E1 — the split's sets at a ₹2,000 overall stop (registered 2026-10-28, before the run)

- **Override:** `override: owner, 2026-10-28 — "for split lets put SL as 2k only"`: Phase 0 lists other
  stops under "will not run"; the owner asks for this one after reading Phase 2.
- **Change:** every morning and afternoon set carries `overall.stop_loss_inr: 2000` instead of its file's
  ₹2,500 (two sets, ₹4,000 a day at most); the whole-day comparator keeps ₹2,500. Nothing else moves.
- **Runs:** (a) Phase 2 again with the ₹2,000 half-day pools (`phase2.py --mtm 2000`: the 120 half-day
  variants re-simulated, the whole-day pool reused), same ranking, measure and interval; (b) the Phase 1
  fixed files `N_wide_0917` and `S_wide_0917` split at ₹2,000 against their stored whole-day results.
- **Rule:** the Phase 2 pass rule, read on (a). (b) is descriptive. This is a second look at the same seen
  days after a failed first look: a pass here is a lead for a forward track, never a result.
- **Will not run:** other stop levels, a stop on one half only, re-entry after the stop.

**Result (2026-10-28):** worse, not better. (a) Adaptive two-plus-two with ₹2,000 sets: split − comparator
**+₹82 [−61, +224]** net per margin lot-day (gross +165 [+22, +307]); max drawdown −18,470 against the
comparator's −16,987, so the split is now the deeper one; the gain again all in T1's selection year
(+222 [−18, +482]) and negative after (−22 [−177, +136]). **FAIL on both conditions.** (b) The fixed live
files split at ₹2,000: NIFTY +₹1 [−147, +149] net a day (was +39 at ₹2,500), SENSEX +₹37 [−121, +197]
(was +89); their drawdowns stay about halved. The tighter stop takes more from the two sets than it saves:
a ₹2,000 stop is hit more often in the afternoon's smaller premiums. Nothing more to try here without a
new registration. Full table: `research/bl182/out/phase2_mtm2000_summary.md` (git-ignored).


### E2 — the morning sets' overall stop, ₹500 → ₹4,000 (registered 2026-10-28, before the run)

- **Override:** `override: owner, 2026-10-28 — "what if we put some stop losses? ... only for morning and
  tell me any difference ... 500 750 1000 1250 1500 1750 2000 ... then 3000 4000 ... Do only morning
  now"`: a sweep over stop levels, listed under "will not run".
- **Change:** only the morning sets (09:17–11:47 → 12:00) carry `overall.stop_loss_inr` at each of
  ₹500, 750, 1,000, 1,250, 1,500, 1,750, 2,000, 3,000 and 4,000 in turn (the files' own ₹2,500 is the
  Phase 2 run); the afternoon sets and the whole-day comparator keep their files' ₹2,500. Each level is a
  full Phase 2 replay (`split_replay.Spec(mtm=level, mtm_halves=("am",))`, `research/bl182/stops.py`).
- **Read, descriptive (no pass rule; nine looks at the same seen days):** per level, Adaptive's morning
  book alone (net per margin lot-day, gross, days in profit, max drawdown, how often the stop is hit),
  the split with that morning against the comparator (mean and interval), and the fixed `N_wide_0917` /
  `S_wide_0917` morning half alone. A level "helps" if the morning book's net rises AND its drawdown is
  shallower than at ₹2,500, over the whole span and in both periods. Nothing is adopted from this; a
  level that helps is a lead for a registration of its own, and with nine levels the best one is
  expected to look good by chance.
- **Not now (owner: "maybe"):** a trailing overall MTM stop on the morning sets. The leg-wise engine's
  `overall` has `stop_loss_inr` and `target_inr` only (`legwise/schema.py`); a trailing or profit-locking
  overall stop would be an engine addition, registered on its own.
- **Will not run:** stops on the afternoon sets, other levels, a stop by family or index.

**Result (2026-10-28):** the morning Widesl wants a *looser* stop, not a tighter one; no level "helps" by
the registered definition because the morning book's drawdown deepens as its earnings rise. Adaptive's
morning book (two picks, per margin lot-day, 434 pick days; the split row is that morning plus the
unchanged afternoon against the ₹2,500 whole-day comparator); full table
`research/bl182/out/morning_stops_summary.md` (git-ignored; `uv run python research/bl182/stops.py
--analyse-only` rebuilds it).

| Morning stop | AM net | AM gross | AM days in profit | AM max DD | AM stop hit / day | Split − comparator net [90 %] | Split max DD |
|---|---|---|---|---|---|---|---|
| ₹500 | +46 | +131 | 46 % | −10,591 | 0.99 | +57 [−97, +207] | −21,754 |
| ₹750 | +37 | +122 | 49 % | −13,842 | 0.86 | +47 [−91, +190] | −20,452 |
| ₹1,000 | +39 | +124 | 54 % | −14,737 | 0.74 | +50 [−91, +181] | −16,928 |
| ₹1,250 | +53 | +138 | 55 % | −18,989 | 0.61 | +64 [−80, +203] | −19,388 |
| ₹1,500 | +75 | +160 | 56 % | −14,185 | 0.52 | +86 [−65, +232] | −15,818 |
| ₹1,750 | +61 | +145 | 57 % | −16,222 | 0.46 | +71 [−65, +201] | −16,940 |
| ₹2,000 | +75 | +160 | 57 % | −16,448 | 0.41 | +86 [−56, +224] | −18,112 |
| **₹2,500 (the files)** | +64 | +149 | 60 % | −16,609 | 0.30 | +75 [−56, +205] | −13,978 |
| ₹3,000 | +140 | +225 | 61 % | −17,048 | 0.20 | +151 [+13, +287] | −15,370 |
| ₹4,000 | +168 | +253 | 62 % | −21,872 | 0.09 | +178 [+34, +319] | −15,729 |

- **Tighter stops hurt.** Every level below ₹2,500 earns less than the files' stop (₹37–75 against ₹64)
  because the stop is hit on 41–99 % of pick-days (the Widesl's morning gamma); only ₹500 cuts the
  drawdown, at 46 % days in profit.
- **Looser stops earn more, in every half-year.** The morning book's net rises monotonically from ₹2,500
  to ₹3,000 to ₹4,000 (+64 → +140 → +168) and does so in each of the four half-years (2025 H1 3.3k →
  18.9k → 21.0k; 2025 H2 9.8k → 13.0k → 21.4k; 2026 H1 9.5k → 20.4k → 20.8k; 2026 H2 5.2k → 8.4k → 9.7k),
  while the stop is hit on 20 % and 9 % of pick-days instead of 30 %. The morning book's drawdown deepens
  (−17,048 and −21,872 against −16,609), so by the registered definition neither level "helps".
- **The split with a ₹3,000 or ₹4,000 morning stop clears zero on the whole span** (+151 [+13, +287], +178
  [+34, +319]) with a shallower drawdown than the comparator's −16,987: it would have passed Phase 2's
  rule. But it is one of nine levels read on seen data, and the gain is still mostly the first year
  (₹4,000: +334 [+111, +562] in T1's selection year, +64 [−115, +242] after; the same sign in both).
- The fixed 09:17 files barely move with the stop (`N_wide` morning half +141 → +149 → +165; `S_wide` +266
  → +265 → +257), so most of Adaptive's morning gain at the looser stops is in which slots it picks.

Reading: the ₹2,500 overall stop, right for a whole-day set, is too tight for a set that is closed at
12:00 with the day's gamma still in it. A morning Widesl stop of ₹3,000–4,000 is a lead: the one thing in
this item that moved in the same direction at every level and in every half-year. It is not adopted; it
needs a registration of its own with one level fixed in advance and a forward track.

### E3 — the morning sets' profit target and profit lock (registered 2026-10-28, before the run)

- **Override:** `override: owner, 2026-10-28 — "Let's add targets also to the morning pick 500, 750, 1250
  1500 1750 2000 2250 2500 ... when we reach a particular profit, let's say 3k or 4k, ... book the profit
  ... Once it reaches 4k, maybe lock the profit at 2k"`: a sweep, listed under "will not run".
- **Change, applied to the morning sets only (09:17–11:47 → 12:00) on top of their files' ₹2,500 stop;
  the afternoon sets and the whole-day comparator unchanged:**
  - a profit **target** at ₹500, 750, 1,000, 1,250, 1,500, 1,750, 2,000, 2,250, 2,500, 3,000 and 4,000:
    the set closes at the first minute its combined MTM at the bar's close is at or above the level;
  - a profit **lock** (arm, lock) at (2,000, 1,000), (3,000, 1,500), (3,000, 2,000), (4,000, 2,000) and
    (4,000, 3,000): once the MTM has reached *arm*, the set closes at the first later minute it is at or
    below *lock* (the portfolio stop's `lock:A,B`, BL-095, on one strategy).
- **Method:** the engine judges its overall stop and target on the combined MTM at each bar's close
  (`legwise/engine.py` `_mtm`), and records that series per day (`DayResult.mtm`). The morning variants
  are simulated once at the files' stop with the series kept (`research/common/split_replay.py`
  `simulate_paths`), and every target and lock is applied to the recorded series exactly as the engine
  would apply an overall target — the exit at that minute's close, the day's gross the MTM there — so
  no engine change and one simulation per family. A day that never reaches the level keeps its result.
  Charges are the base run's (the same legs close either way; a leg already stopped before the level is
  unchanged). Each overlay changes every variant's history, so Adaptive's morning ranking is re-run per
  overlay as in E2.
- **Read, descriptive (no pass rule; sixteen looks at the same seen days):** per overlay, Adaptive's
  morning book alone (net per margin lot-day, gross, days in profit, max drawdown, how often the level
  fires), the split with that morning against the comparator, and the fixed `N_wide_0917` /
  `S_wide_0917` morning half. An overlay "helps" if the morning book's net rises AND its drawdown is
  shallower than the plain ₹2,500 morning, over the whole span and in both periods. The owner asked for
  "the optimum number": none is chosen here; the best of sixteen on seen data is expected to look good by
  chance, and a level that helps is a lead for a registration with that one level fixed in advance.
- **Addition (owner, 2026-10-28, before the overlays were read: "Check lock and trail also. Like profit is
  3000, lock at 0, then 1:1"):** a lock-and-trail (arm, lock, step) at (2,000, 0), (3,000, 0) and
  (4,000, 0), each 1:1 in ₹100 steps: once the MTM has reached *arm*, the exit level starts at *lock* and
  rises ₹100 for every further ₹100 the peak MTM makes (the portfolio stop's `locktrail:A,B,100,100`).
  Nineteen overlays in all. The lock of ₹0 is run as ₹1 (breakeven): the portfolio stop's parser reads
  a 0 as no lock (found at the dry run, before any overlay was read).
- **Will not run:** targets or locks on the afternoon sets or the whole day, other levels or steps, a
  target by family or index.

**Result (2026-10-28):** profit targets hurt the morning Widesl at every level; profit locks are neutral
to mildly helpful, and the lock-and-trail armed at ₹3,000 is the one overlay that never hurts.
Adaptive's morning book (two picks, per margin lot-day, 434 pick days; the morning paths' last MTM
equals the day's gross on every day, so the overlays are exact); full table
`research/bl182/out/morning_overlays_summary.md` (git-ignored; `uv run python research/bl182/overlays.py
--analyse-only` rebuilds it).

| Morning overlay | AM net | AM max DD | Fired / day | Split − comparator net [90 %] | `N_wide` / `S_wide` 09:17 AM net |
|---|---|---|---|---|---|
| plain (₹2,500 stop) | +64 | −16,609 | 0.30 | +75 [−56, +205] | +141 / +266 |
| target ₹500 … ₹2,250 | −42 to +34 | −17,778 to −31,976 | 0.44–1.46 | −31 to +45 | −125 to −6 / −12 to +99 |
| target ₹2,500 / 3,000 / 4,000 | +26 / +44 / +45 | −19,921 / −14,512 / −17,607 | 0.41 / 0.39 / 0.34 | +37 / +54 / +55 | +1 / +27 / +76 ; +96 / +145 / +202 |
| lock at ₹2,000 → ₹1,000 | +54 | −18,577 | 0.34 | +64 [−73, +199] | +105 / +222 |
| lock at ₹3,000 → ₹1,500 | +82 | −14,902 | 0.30 | +93 [−51, +236] | +125 / +259 |
| lock at ₹3,000 → ₹2,000 | +64 | −20,197 | 0.32 | +75 [−69, +221] | +108 / +253 |
| lock at ₹4,000 → ₹2,000 | +61 | −15,112 | 0.30 | +72 [−69, +210] | +134 / +256 |
| lock at ₹4,000 → ₹3,000 | +64 | −17,901 | 0.30 | +75 [−63, +208] | +124 / +243 |
| lock-trail at ₹2,000, breakeven then 1:1 | +69 | −18,137 | 0.33 | +80 [−61, +219] | +121 / +226 |
| **lock-trail at ₹3,000, breakeven then 1:1** | **+91** | **−13,836** | 0.29 | +101 [−43, +241] | +122 / +255 |
| lock-trail at ₹4,000, breakeven then 1:1 | +80 | −15,426 | 0.30 | +91 [−45, +226] | +139 / +268 |

- **Targets cut the winners.** A morning Widesl earns by decay to 12:00; every target takes the good
  days off the top and keeps the bad ones whole. Below ₹2,250 the morning book loses money or near it,
  and the fixed 09:17 files turn negative on NIFTY.
- **Locks and lock-trails help where the plain morning was poor.** By period, the plain morning earned
  +17 a day in T1's selection year and +99 after; the lock-trail armed at ₹3,000 earned +79 and +99
  (drawdown −12,303 / −11,653 against −15,288 / −11,970), so it meets the "helps" definition except for a
  tie in the second year's net; the ₹3,000 → ₹1,500 lock +76 / +87; the ₹4,000 lock-trail +54 / +99.
  All three fire on about 30 % of pick-days, as the plain stop does: they replace losing exits, they do
  not add many.
- **The fixed files do not gain:** `N_wide` 09:17's morning half reads +122–139 under the locks against
  +141 plain, `S_wide` +243–268 against +266. The gain is in Adaptive's picks on its bad days, about ₹20–30
  a margin lot-day, not in the shape.
- Nineteen overlays on seen data; the one that stands out does so by not hurting anywhere.

Reading: no target on a morning Widesl. A lock-and-trail armed at ₹3,000 with a breakeven lock is a lead
worth one registration with that setting fixed, alongside the looser ₹3,000–4,000 morning stop from E2;
the two would be tested together, not chosen between on this data.

## Risks

- Fills at 12:00 and 13:00 on 1-minute bars with no spread; the afternoon set's smaller premiums.
- Two MTM budgets a day (₹5,000 at ₹2,500 a set) even if the drawdown reads shallower.
- The edge in the study sits in two quarters; a bootstrap over 500 days can still pass on them.
- All of Phase 1 is seen data; only Phase 3 is a test.

## Open questions

- None blocking Phase 1. For Phase 2: whether the afternoon pick is made at 09:16 (registered above)
  or at 12:55 with the morning known (a different rule; not registered).

## Log

- 2026-10-28 — created from the owner's discussion of the friend's study; Phase 0 registered and
  committed before any run.
- 2026-10-28 — Phase 1 run (`research/bl182/run.py`, 21 variants × 501 days per index): A reconciles with
  the study within 15 %; B +₹39 [−107, +187] and C +₹89 [−63, +241] net per lot-day, drawdown halved, both
  FAIL the registered rule (lower bound not above zero after charges); D descriptive. Not adopted; Phase 2
  not run. Findings: `research/options/strategies/widesl/session-split.md`, rows in `exit-time.md`,
  `entry-time.md` and the Widesl README.
- 2026-10-28 — correction (code review of PR 380): the study's split pays two sets of ₹40, so its
  before-cost figure is (222,681 + 510 × 80) / 510 = ₹517 a day, not the ₹477 registered (one set's costs
  added back). Ours is 502, 3 % off, still within the 15 % rule; the verdict is unchanged. The Phase 0 text
  keeps the registered number with this note.
- 2026-10-28 — post-hoc brokerage sensitivity (owner's question: Shoonya is ₹5 an order, Angel One ₹20 an
  order which is ₹10 a lot at two lots), the same stored results re-read with the brokerage swapped and
  the statutory charges unchanged; descriptive, the rule was registered at ₹13. Split − whole day, net
  per lot-day [90 %]:

  | Brokerage an order | Live NIFTY | Live SENSEX | `N_wide-t1s4` | `N_wide-t1s8` |
  |---|---|---|---|---|
  | ₹13 (registered) | +39 [−107, +187] | +89 [−63, +241] | +77 [−82, +237] | +84 [−36, +207] |
  | ₹5 (Shoonya) | +77 [−69, +225] | +126 [−25, +279] | +116 [−43, +275] | +122 [+1, +245] |
  | ₹10 (Angel One, 2 lots) | +53 [−92, +201] | +103 [−49, +255] | +92 [−67, +252] | +98 [−22, +221] |
  | ₹20 (Angel One, 1 lot) | +6 [−139, +154] | +56 [−96, +208] | +44 [−115, +204] | +51 [−69, +174] |

  Cheaper brokerage adds ₹14–38 a day to the split's edge; the interval is about ±150 wide at every rate,
  so neither live file clears zero even at ₹5, and only the T1 SL 60 % setting does, by ₹1. The verdict
  does not turn on the broker; it turns on the day-to-day noise of the difference.
- 2026-10-28 — `override: owner — accepts Phase 1's point estimate (+₹50–125 a lot-day on the owner's
  brokers, ~28 % more per lot on Shoonya) and the halved drawdown as reason to run Phase 2 although the
  registered rule failed.` Owner's choices for Phase 2: Core's six Widesl families (not T1's, which were
  tuned on this period), comparator = Core Adaptive's top two whole-day Widesl from the same families,
  both half-day picks at 09:16, afternoon grid to 15:02, exit 15:28. Phase 2 block registered above and
  committed before any run.
- 2026-10-28 — Phase 2 run (`research/bl182/phase2.py`, 216 variants × 501 days per index, then the
  replay): split − comparator +₹75 [−56, +205] net per margin lot-day, gross +₹158 [+27, +288], drawdown
  shallower; the gain entirely in the first year with both indices. **FAIL** on the registered rule; not
  adopted; Phase 3 not opened. Interim NIFTY-only read (before SENSEX finished): +₹65 [−58, +187], gain in
  the second year instead.
- 2026-10-28 — E1 registered (owner override: the split's sets at a ₹2,000 overall stop) before its run.
- 2026-10-28 — E1 run: Adaptive two-plus-two at ₹2,000 sets +₹82 [−61, +224], drawdown now deeper than the
  comparator's, FAIL; the fixed live files at ₹2,000 +₹1 (NIFTY) / +₹37 (SENSEX). Item closed: not adopted.
- 2026-10-28 — E2 registered (owner override: the morning sets' overall stop at nine levels ₹500 → ₹4,000,
  descriptive) before its run.
- 2026-10-28 — E2 run (`research/bl182/stops.py`, nine levels): tighter morning stops hurt; ₹3,000 / ₹4,000 raise
  the morning book to +140 / +168 (every half-year) and the split clears zero (+151 [+13, +287], +178 [+34, +319]);
  the morning drawdown deepens, so no level "helps" by the registered definition. Lead for its own registration.
- 2026-10-28 — post-hoc read (owner's question), net per pick (one lot) by the pick's own index's expiry day,
  descriptive: whole-day picks earn +511 on expiry days and **+10 on other days**; the afternoon picks +387 /
  +100; the morning picks +134 / +31 at ₹2,500 and +175 / +73 at ₹3,000. So the split's gain is all on
  non-expiry days (morning + afternoon +131 a pair against +10 whole-day; +173 with a ₹3,000 morning
  stop), and on expiry days the two are level (+521 against +511). A split only on non-expiry days would be
  a new, data-mined rule; recorded as a lead, not run.
- 2026-10-28 — E3 registered (owner override: profit targets at eleven levels and five profit locks on the
  morning sets, on the recorded MTM paths, descriptive) before its run.
- 2026-10-28 — E3 run (`research/bl182/overlays.py`, nineteen overlays on the recorded paths): targets hurt at every
  level; the lock-trail armed at ₹3,000 (breakeven, 1:1) reads +91 / −13,836 against the plain +64 / −16,609 and
  never hurts by period; the fixed files do not gain. Lead for a registration with the setting fixed.
- 2026-10-28 — E3 addition (owner, after the nineteen were read: "For widesl, lock at 0 when profit at 1500, and then
  1:1"): a twentieth overlay, lock-and-trail armed at ₹1,500 (breakeven ₹1, 1:1 in ₹100 steps), registered
  before its run; read as the others, descriptive.
- 2026-10-28 — E3 addition (owner, after the nineteen were read: "For widesl, lock at 0 when profit at 1500, and then
  1:1"): a twentieth overlay, lock-and-trail armed at ₹1,500 (breakeven ₹1, 1:1 in ₹100 steps), registered
  before its run; read as the others, descriptive.
- 2026-10-28 — E3 addition run (lock-and-trail armed at ₹1,500, breakeven, 1:1): morning book +75 a margin lot-day,
  max drawdown −17,527, fires on 0.37 pick-days; split − comparator +85 [−63, +228]; by period +90 / −17,527 in
  T1's selection year (plain +17 / −15,288) and +63 / −11,208 after (plain +99 / −11,970). It lifts the first
  year and gives up part of the second, and the fixed files lose (`N_wide` +99 against +141, `S_wide` +218
  against +266). Weaker than the ₹3,000 arm (+91 / −13,836); not a lead on its own.
