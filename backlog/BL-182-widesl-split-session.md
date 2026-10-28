# BL-182 — Widesl split session: 09:17–12:00 plus 13:00–15:28 against the whole day

| | |
|---|---|
| **Priority** | P1 — the owner trades Widesl with real money on Core and T1; a friend's study says the split earns ₹160 a day more per lot with half the drawdown |
| **Status** | Done 2026-10-28: not adopted. Phase 1 killed on its rule (+₹39 NIFTY / +₹89 SENSEX a day net, intervals include zero); Phase 2 (owner override: Adaptive two morning + two afternoon Widesl vs its top two whole-day, Core's six families) also failed its rule: +₹75 [−56, +205] net per margin lot-day, gross +₹158 [+27, +288], drawdown shallower, the gain confined to one of the two years |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-058 (the Core-298 files and stored results), BL-113 (the T1 settings), BL-063 (the charge model, `ruletest/charges.py`) |
| **TODO.md row** | §3.10.46 |

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
