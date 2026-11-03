# BL-204 — T1's fifth and sixth lot, and a fourth on expiry days: where each extra lot goes as capital grows

| | |
|---|---|
| **Priority** | P2 — the owner trades T1 with real money on two accounts and the capital may grow from ₹9 lakh to ₹12–13 lakh, later more |
| **Status** | Done — informative: on normal days the Dir takes every extra lot (Dir ×3 at 5 lots, Dir ×4 at 6); on a one-index expiry day a fourth lot earns (+₹770 a day) but no placement beats an even spread, the Dir ×2 and the top Widesl ×2 are equal and adding a strategy is worst; a fifth expiry lot likewise (Dir ×2 + W1 ×2 or Dir ×3) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-03 |
| **Depends on** | BL-133 (fourth lot: the Dir; expiry days stay 3 of the expiring index), BL-183 (Dir ×2 live), BL-194 (book stop on 4-lot days), BL-122 (expiring-index rule), BL-192 (SL150% cap) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-11-03): "currently I have 9 lakh rupees. So this would be mostly sufficient for 3 lots of Nifty
expiry or Sensex expiry trades, and 4 lots of non-expiry trades. But let's say my capital moves to 12 lakh or
13 lakh. So there's a possibility that I can do 4 lot on expiry and maybe 5 lot on non-expiry days. It can be
also 6 lot if it is 30 lakh. So I need you to find out which is the best configuration to run the T1. Like for
now, if there is a 4 lot, we will be running the best directional one and the 2 widesl. So what if we have a 5
lot? ... or 4 lot in expiry and 5 lot or 6 lot in non-directional. So what would be the best approach?"

What is live (T1, one account): on a non-expiry day the picked Dir at 2 lots and the two Widesl at 1 (BL-183),
on an expiry day the expiring index's three picks at 1 lot each (BL-122, BL-133 Amendment 3), under a book stop
of ₹9,000 plus the extra lot's own MTM SL (BL-194). BL-133 read the fourth lot only ("Will not run: 5+ lots");
nothing has read a fifth or sixth lot, or a fourth on an expiry day.

Margin, from BL-133 Amendment 3's reading of Angel One's calculator (≈ ₹2.0–2.08 lakh a lot on a normal day,
≈ ₹2.6 lakh on the expiring index's expiry day; estimates, not measured since):

| Capital | Normal day | Expiry day |
|---|---|---|
| ₹9 lakh | 4 lots (≈ ₹8.3 lakh) | 3 lots (≈ ₹7.8 lakh) |
| ₹12–13 lakh | 5 lots (≈ ₹10.4 lakh); 6 (≈ ₹12.5 lakh) only at ₹13 lakh with no buffer | 4 lots (≈ ₹10.5 lakh) |
| ₹30 lakh | 6 lots (≈ ₹12.5 lakh) | 6 lots (≈ ₹15.7 lakh) |

## Goal

For T1, the result, drawdown and worst day of each way of placing a fifth and a sixth lot on non-expiry days
and a fourth (and fifth) on one-index expiry days, against the lots live today and against the same lots
spread evenly over the picks. Nothing live changes.

## Out of scope

Core-298; Buy; the lot ladder as a function of capital inside a day; margin measured (the table above is
taken as given); any change to a list, an export or a setting.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** the Dir is the best home for the fifth lot too (Dir ×3), and on an expiry day the expiring
  index's Dir at 2 lots beats adding a strategy; the sixth lot is where the reading is least sure.
- **Book:** T1, list C (registered weights and lookbacks) reconstructed day by day from the stored results
  (`daylog.reconstruction` over Core-298 + the T1 variants, `pick._rank`), as BL-194: the expiring-index rule
  (`expiry.filter_picks`) and the SL150% cap (`sl150_cap.cap_picks`) applied as if live throughout; core picks
  only, Buy left out. Day d's composite is built from results before d only.
- **Picks named:** D = the core Dir pick, or on a three-Widesl day the best unpicked Dir (added, as BL-133);
  W1 / W2 = the Widesl picks by composite (ties by name; a three-Widesl day's third Widesl is a third 1-lot
  member in every arm); D+ = the best-ranked unpicked Dir other than D; W+ = the best-ranked unpicked Widesl;
  R+ = whichever of D+ / W+ has the higher composite. On a one-index expiry day every runner-up comes from the
  expiring index (`expiry.filtered_runners_up`'s rule); O+ = the other index's best-ranked non-Buy variant by
  the unrestricted composite.
- **Day types:** *normal* = neither index expires and both labels known; *expiry* = exactly one index expires
  (`expiry.expiring_index`); a both-expiry or unknown-label day trades 3 lots in every arm, as live
  (`live_lots.lots_for_day`), and is counted.
- **Arms, normal days** (the base **N4** = D ×2, W1, W2, live today):
  - 5 lots: **N5-D3** D ×3; **N5-W1** D ×2, W1 ×2; **N5-W2** D ×2, W2 ×2; **N5+D** D ×2 + D+; **N5+W** D ×2 + W+;
    **N5+R** D ×2 + R+. Comparator **B5** = the 3-lot book × 5/3.
  - 6 lots: **N6-all2** D ×2, W1 ×2, W2 ×2; **N6-D3W1** D ×3, W1 ×2; **N6-D4** D ×4; **N6+D+W** D ×2 + D+ + W+;
    **N6+D2** D ×2 + D+ ×2; **N6-D3+D** D ×3 + D+; **N6-W1+D** D ×2, W1 ×2 + D+. Comparator **B6** = the 3-lot
    book × 2.
- **Arms, one-index expiry days** (the base **E3** = the expiring index's picks ×1, live today):
  - 4 lots: **E4-D2** the Dir ×2 (no Dir: the expiring index's best unpicked Dir added); **E4-W1** W1 ×2; **E4+D**
    + D+; **E4+W** + W+; **E4+O** + O+ at 1 lot. Comparator **B4e** = E3 × 4/3.
  - 5 lots: **E5-D2W1** Dir ×2, W1 ×2; **E5-D3** Dir ×3; **E5+D** Dir ×2 + D+; **E5+O** Dir ×2 + O+. Comparator
    **B5e** = E3 × 5/3.
- **Book stop:** ₹9,000 plus, for every lot beyond the three base lots, that lot's strategy's own
  `overall.stop_loss_inr` (₹4,000 if none), replayed per minute with `rotation/portfolio.apply_book` over
  `one_lot_path` (a k-lot member = k × its one-lot path, the per-lot stop scaling the owner confirmed); an even
  spread's stop is ₹9,000 × k/3 and its paths the 3-lot paths × k/3. A day whose path cannot be replayed is
  skipped and listed.
- **Money:** gross from the replayed paths × lots under the stop; brokerage = 2 orders × the stored `n_trades`
  × ₹20 × 1.18 once per strategy placed (lots of one strategy share orders); net = gross − brokerage; turnover
  charges scale with lots and are left out alike. Slippage not modelled (every arm alike).
- **Measures (net):** per day over the day type's days and per lot-day; annualised (× 250); max drawdown;
  worst day; worst 5-day week; share of losing days; return ÷ |max drawdown|; drawdown per lot; book-stop
  days; peak lots open at once. Intervals: 90 % circular block bootstrap, 5-day blocks, 2,000 resamples, seed
  20261103, of arm − base and arm − even spread over the day type's days in date order; head to head, the
  best arm of each lot count against the second best (by net per day). For the best arm of each lot count:
  arm − even spread with the 5 and 10 best days removed and their share of the excess. **Whole book:** every
  normal arm paired with E3 on expiry days and every expiry arm paired with N4 on normal days, plus the best
  normal and best expiry arm together, over all days: per day, max drawdown, worst day, R/DD, drawdown per
  lot.
- **Windows:** 2025-01-10 → 2026-10-30 (BL-194's days) and the last year 2025-11-03 → 2026-10-30.
- **Reading:** an arm "earns its lot" if arm − even spread is above zero; one arm "beats" another if their
  difference is above zero; drawdown and worst day reported, not judged. Descriptive and in-sample: T1's
  universe was selected on part of these days, and BL-133's Dir reading came from them. With 22 arm cells,
  one or two intervals clearing zero by chance are expected; nothing is adopted here. A live change needs
  BL-135's forward rule (60 scored days, interval above zero, drawdown per lot no deeper).
- **Look-ahead check:** day d's ranking uses results before d; the expiring index and the labels are known
  before the day; the stop level is the strategy files' own.
- **Hold-out:** none (descriptive, in-sample, as BL-133 / BL-194).
- **Will not run:** 7+ lots; mixes of both indices on an expiry day beyond O+; any day after 2026-10-30;
  Core-298; Buy.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl204/lot_ladder.py`; JSON beside it; Log.
- **Done when:** the Log has every arm and comparator for both day types, both windows, and the whole-book
  pairings.

## Risks

In-sample and the T1 universe's selection window overlaps; a stop fills at the minute's close with no
slippage; runner-ups are rebuilt from the stored composites, not journal entries; the margin table is an
estimate from one reading.

## Open questions

None before the run; the owner's choice of lots per capital level comes after reading the result.

## Log

- 2026-11-03 — Created; Phase 0 registered before any run (the owner's question, the arms chosen here).
- 2026-11-03 — **Run as registered** (`research/bl204/lot_ladder.py`; `lot_ladder_2026-11-03.json`). 437 T1 days
  replayed (2025-01-10 → 2026-10-30), none skipped: 251 normal days (218 with a Dir pick, 33 three-Widesl days with
  the best unpicked Dir as D), 185 one-index expiry days, 1 other (2026-09-30, SENSEX label unknown). Every arm could be
  built on every day. The book stop on Dir ×3 days was ₹15,000 (88 days) or ₹17,000 (163); the D was a Dir ITM1 on
  211 of 251 normal days. Net per day after brokerage, under the book stop; "vs base" = the arm minus the live lots
  (N4 on normal days, E3 on expiry days), "vs even" = minus the 3-lot book scaled to the same lots; 90 % intervals.

  **Normal days, 251 (last year 136 in brackets)**

  | Arm | Net / day | Per lot-day | vs N4 (90 %) | vs even (90 %) | Max DD | DD per lot | Worst day | Worst week | R/DD |
  |---|---|---|---|---|---|---|---|---|---|
  | N4 Dir ×2 (live) | +1,458 [+1,999] | +365 [+500] | | +185 [−20, +398] / [+294 [+77, +520]] | −49,379 [−34,977] | −12,345 [−8,744] | −13,941 [−12,456] | −40,105 | 7.4 [14.3] |
  | **N5-D3 Dir ×3** | **+2,075 [+2,821]** | **+415 [+564]** | **+617 [+374, +879]** / [**+822 [+520, +1,143]**] | **+405 [+3, +818]** / [**+608 [+175, +1,056]**] | −55,017 [−48,538] | −11,003 [−9,708] | −17,994 [−14,874] | −51,465 | 9.4 [14.5] |
  | N5-W1 Dir ×2, W1 ×2 | +1,773 [+2,403] | +355 [+481] | +315 [+113, +513] / [+404 [+131, +664]] | +103 [−73, +281] / [+189 [+5, +379]] | −65,328 [−38,645] | −13,066 [−7,729] | −18,056 | −49,026 | 6.8 [15.5] |
  | N5-W2 Dir ×2, W2 ×2 | +1,731 [+2,403] | +346 [+481] | +272 [+108, +428] / [+404 [+203, +608]] | +61 [−113, +230] / [+189 [+18, +369]] | −61,733 [−38,047] | −12,347 [−7,609] | −17,846 | −46,453 | 7.0 [15.8] |
  | N5+D Dir ×2 + a Dir | +1,855 [+2,400] | +371 [+480] | +397 [+174, +608] / [+401 [+128, +676]] | +185 [−148, +536] / [+187 [−233, +579]] | −56,359 [−45,598] | −11,272 [−9,120] | −16,568 | −41,925 | 8.2 [13.2] |
  | N5+W Dir ×2 + a Widesl | +1,532 [+2,024] | +306 [+405] | +74 [−124, +264] / [+25 [−233, +282]] | −138 [−343, +71] / [−189 [−430, +34]] | −55,436 | −11,087 | −17,484 | −34,636 | 6.9 [13.2] |
  | N5+R Dir ×2 + next best | +1,785 [+2,199] | +357 [+440] | +326 [+85, +550] / [+199 [−106, +508]] | +115 [−198, +437] / [−15 [−414, +370]] | −51,122 | −10,224 | −17,484 | −39,378 | 8.7 [12.8] |
  | N6-all2 all ×2 | +2,045 [+2,806] | +341 [+468] | +587 [+268, +905] / [+806 [+418, +1,210]] | −26 [−158, +101] / [+84 [−10, +186]] | −77,818 [−41,715] | −12,970 [−6,953] | −21,654 | −55,185 | 6.6 [16.8] |
  | N6-D3W1 Dir ×3, W1 ×2 | +2,380 [+3,207] | +397 [+535] | +922 [+577, +1,276] / [+1,208 [+734, +1,682]] | +309 [−36, +663] / [+486 [+115, +872]] | −73,534 [−52,746] | −12,256 [−8,791] | −21,665 | −61,172 | 8.1 [15.2] |
  | **N6-D4 Dir ×4** | **+2,688 [+3,637]** | **+448 [+606]** | **+1,230 [+742, +1,752]** / [**+1,638 [+1,036, +2,282]**] | **+617 [+18, +1,234]** / [**+915 [+265, +1,589]**] | −62,826 [−62,639] | −10,471 [−10,440] | −22,047 [−19,083] | −62,826 | 10.7 [14.5] |
  | N6+D+W Dir ×2 + a Dir + a Widesl | +1,907 [+2,425] | +318 [+404] | +449 [+138, +725] / [+425 [+31, +822]] | −163 [−503, +177] / [−297 [−710, +105]] | −62,467 | −10,411 | −19,914 | −46,653 | 7.6 [12.4] |
  | N6+D2 Dir ×2 + a Dir ×2 | +2,366 [+2,936] | +394 [+489] | +908 [+466, +1,328] / [+937 [+389, +1,481]] | +295 [−244, +834] / [+214 [−505, +883]] | −62,874 [−54,756] | −10,479 [−9,126] | −20,290 | −52,302 | 9.4 [13.4] |
  | N6-D3+D Dir ×3 + a Dir | +2,470 [+3,220] | +412 [+537] | +1,011 [+620, +1,415] / [+1,221 [+728, +1,727]] | +399 [−99, +915] / [+499 [−87, +1,075]] | −63,581 [−59,159] | −10,597 [−9,860] | −20,485 | −53,009 | 9.7 [13.6] |
  | N6-W1+D Dir ×2, W1 ×2 + a Dir | +2,188 [+2,803] | +365 [+467] | +730 [+392, +1,055] / [+804 [+393, +1,199]] | +117 [−182, +427] / [+82 [−288, +447]] | −75,002 [−49,267] | −12,500 [−8,211] | −20,741 | −52,273 | 7.3 [14.2] |
  | B4 / B5 / B6 even | +1,274 / +1,670 / +2,071 | +318 / +334 / +345 | | | −57,766 / −71,560 / −84,201 | −14,442 / −14,312 / −14,033 | −16,368 / −21,818 / −26,115 | | 5.5 / 5.8 / 6.1 |

  - **Head to head:** Dir ×3 − the next best (N5+D) +220 [−32, +488]; last year Dir ×3 − N5-W2 +418 [+60, +794].
    Dir ×4 − Dir ×3 + a Dir +218 [−35, +485]; last year +417 [+103, +762]. Each extra Dir lot earns about the same
    as the one before it (the fourth lot +617 over N4, the fifth +613 over Dir ×3).
  - **Few days, as BL-133:** Dir ×3 − even without its 5 best days +193 [−241, +606] (those 5 carry 53 % of the
    excess), without 10 +24 [−440, +467] (94 %); Dir ×4 +299 [−334, +912] (53 %) / +44 [−647, +707] (93 %). The 5
    best days are 2026-02-02, 2025-02-28, 2025-05-21, 2026-05-29 and 2025-05-12 (+₹10–12k each over the even
    spread); the worst 2025-01-22 (−₹18.5k) and 2025-05-09 (−₹15.2k).
  - All lots are open at the same minute on nearly every normal day in every arm (the margin is for the full count).

  **One-index expiry days, 185 (last year 101)**

  | Arm | Net / day | Per lot-day | vs E3 (90 %) | vs even (90 %) | Max DD | DD per lot | Worst day | R/DD |
  |---|---|---|---|---|---|---|---|---|
  | E3 expiring index ×1 (live) | +2,767 [+2,510] | +922 [+837] | | | −25,721 [−18,011] | −8,574 [−6,004] | −10,249 | 26.9 [34.8] |
  | **E4-D2 Dir ×2** | +3,540 [+3,247] | +885 [+812] | +773 [+406, +1,146] / [+737 [+231, +1,233]] | −282 [−581, +31] / [−237 [−670, +195]] | −29,516 [−29,516] | −7,379 [−7,379] | −13,678 | 30.0 [27.5] |
  | E4-W1 W1 ×2 | +3,557 [+3,169] | +889 [+792] | +790 [+419, +1,151] / [+659 [+156, +1,144]] | −264 [−537, +2] / [−315 [−708, +58]] | −30,005 [−26,230] | −7,501 [−6,558] | −14,806 | 29.6 [30.2] |
  | E4+D + a Dir | +3,242 [+2,783] | +810 [+696] | +475 [+126, +811] / [+273 [−126, +693]] | −580 [−926, −241] / [−702 [−1,242, −195]] | −34,387 | −8,597 | −14,680 | 23.6 [28.3] |
  | E4+W + a Widesl | +3,190 [+3,061] | +797 [+765] | +423 [+98, +740] / [+551 [+86, +1,038]] | −632 [−971, −293] / [−423 [−866, +25]] | −35,111 | −8,778 | −14,125 | 22.7 [32.1] |
  | E4+O + the other index's top pick | +3,157 [+2,987] | +789 [+747] | +390 [+40, +740] / [+477 [+51, +990]] | −664 [−1,053, −276] / [−497 [−1,072, +74]] | −27,652 | −6,913 | −13,906 | 28.5 [27.0] |
  | E5-D2W1 Dir ×2, W1 ×2 | +4,327 [+3,907] | +865 [+781] | +1,559 [+1,014, +2,098] / [+1,397 [+704, +2,065]] | −550 [−810, −302] / [−549 [−947, −205]] | −33,107 | −6,621 | −16,987 | 32.7 [29.5] |
  | E5-D3 Dir ×3 | +4,423 [+4,053] | +885 [+811] | +1,656 [+913, +2,393] / [+1,543 [+527, +2,540]] | −453 [−1,061, +167] / [−403 [−1,276, +469]] | −42,984 | −8,597 | −17,539 | 25.7 [23.6] |
  | E5+D Dir ×2 + a Dir | +4,045 [+3,530] | +809 [+706] | +1,278 [+647, +1,907] | −832 [−1,401, −258] | −37,741 | −7,548 | −17,600 | 26.8 [24.5] |
  | E5+O Dir ×2 + the other index's top pick | +3,928 [+3,715] | +786 [+743] | +1,161 [+529, +1,786] | −949 [−1,552, −350] | −33,929 | −6,786 | −17,104 | 28.9 [27.4] |
  | B4 / B5 / B6 even | +3,822 / +4,877 / +5,932 | +955 / +975 / +989 | | | −31,840 / −37,959 / −44,078 | −7,960 / −7,592 / −7,346 | −13,556 / −16,862 / −20,168 | 30.0 / 32.1 / 33.6 |

  - **Head to head:** E4-W1 − E4-D2 +18 [−502, +521] (last year E4-D2 ahead, +78 [−618, +811]): equal. E5-D3 −
    E5-D2W1 +97 [−412, +622] / +146 [−571, +890]: equal. Removing the best days makes every expiry placement worse
    against the even spread (E4-W1 without its 5 best −409 [−663, −152]), so the shortfall is in the ordinary days.

  **Whole book (every day; the pairs the capital levels allow)**

  | Lots normal / expiry | Arms | Net / day | Per lot-day | Max DD | DD per lot | Worst day | Worst week | R/DD | Stop days |
  |---|---|---|---|---|---|---|---|---|---|
  | 4 / 3 (live) | N4 + E3 | +2,009 [+2,207] | +562 [+618] | −36,145 [−27,347] | −10,112 [−7,657] | −13,941 [−12,456] | −26,618 | 13.9 [20.2] | 12 |
  | 4 / 4 | N4 + E4-D2 | +2,336 [+2,520] | +584 [+631] | −35,480 [−35,480] | −8,875 [−8,879] | −13,941 | −27,282 | 16.5 [17.8] | 9 |
  | **5 / 4** | **N5-D3 + E4-D2** | **+2,690 [+2,989]** | **+588 [+655]** | −41,801 [−38,773] | −9,143 [−8,489] | −17,994 [−14,874] | −31,959 | 16.1 [19.3] | 8 |
  | 5 / 4 | N5+D + E4-D2 | +2,564 [+2,749] | +561 [+602] | −39,275 [−35,265] | −8,590 [−7,721] | −16,568 | −34,220 | 16.3 [19.5] | 6 |
  | 5 / 4 | N5-W2 + E4-D2 | +2,492 [+2,750] | +545 [+602] | −35,559 [−35,559] | −7,777 [−7,786] | −17,846 | −28,192 | 17.5 [19.3] | 10 |
  | 6 / 4 | N6-D4 + E4-D2 | +3,042 [+3,456] | +591 [+672] | −53,570 [−42,319] | −10,409 [−8,235] | −22,047 [−19,083] | −37,701 | 14.2 [20.4] | 9 |
  | 6 / 4 | N6-D3+D + E4-D2 | +2,917 [+3,218] | +567 [+626] | −45,904 [−39,676] | −8,920 [−7,721] | −20,485 | −39,962 | 15.9 [20.3] | 6 |
  | **6 / 5** | **N6-D4 + E5-D2W1** | **+3,375 [+3,736]** | **+606 [+672]** | −53,915 [−45,093] | −9,680 [−8,106] | −22,047 [−19,083] | −40,554 | 15.7 [20.7] | 10 |
  | 6 / 5 | N6-D4 + E5-D3 | +3,416 [+3,798] | +613 [+683] | −51,191 [−51,191] | −9,191 [−9,202] | −22,047 | −41,543 | 16.7 [18.5] | 8 |
  | 6 / 5 | N6-D3+D + E5-D2W1 | +3,250 [+3,498] | +583 [+629] | −48,757 [−43,949] | −8,754 [−7,900] | −20,485 | −42,815 | 16.7 [19.9] | 7 |

  **Read under the rule (descriptive, in-sample).** On normal days the Dir is the home of every extra lot, as the
  hypothesis said: Dir ×3 earns its fifth lot against the even spread in both windows (+₹405 [+3, +818] / +₹608
  [+175, +1,056]) and Dir ×4 its sixth (+₹617 [+18, +1,234] / +₹915 [+265, +1,589]); no other 5- or 6-lot
  placement clears zero against the even spread over the whole window, and the Widesl placements and added
  strategies sit at or below it. Dir ×3 beats the next best only on the last year; over the whole window the
  difference includes zero, and as in BL-133 the edge over the even spread is carried by a handful of days (5 days
  = 53 %, 10 days = 94 %). The price is the day: Dir ×3's worst day is −₹18.0k (−₹13.9k live), Dir ×4's −₹22.0k,
  and the worst week −₹51k / −₹63k, though drawdown per lot stays near or under the live book's. On expiry days
  the hypothesis fails: a fourth lot earns (+₹770 a day over 3 lots, in both windows) but no placement beats
  spreading it evenly, the Dir ×2 and the top Widesl ×2 are indistinguishable (the Dir ×2 has the smaller
  drawdown per lot, −₹7,379, and the higher last-year figure), and adding a strategy, of either index, is clearly
  below the even spread (−₹580 to −₹664). A fifth expiry lot is the same story: Dir ×2 + W1 ×2 and Dir ×3 are
  equal (+₹1,560 / +₹1,660 over 3 lots), both below the even spread, Dir ×3 with a −₹43k drawdown against
  −₹33k. Weaknesses: in-sample (T1's universe was selected on part of these days; the Dir reading comes from the
  days BL-133 read); fills at the stop minute's close with no slippage, which matters most for a 3- or 4-lot Dir
  on the day its stop fires; brokerage from the stored trade counts even on stopped days; the margin table is one
  reading. Nothing adopted: a live change follows BL-135's forward rule.
