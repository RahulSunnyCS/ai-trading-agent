# BL-236 — Momentum lots: rebalance by the backtest's equal split, not toward the sleeve's end weights

| | |
|---|---|
| **Priority** | P1 — real money from 2026-10-19 trades by this rule, and the rule is not the one the backtest tested |
| **Status** | In progress — built and live for 20 Nov; Phase 4 (watch two Fridays) open |
| **Type** | improvement |
| **Area** | momentum |
| **Created** | 2026-11-19 |
| **Depends on** | BL-142 (the lots and `plan_lots`, Done); touches BL-136 Phase 1b (premium rule for Broad atomics, open) |
| **TODO.md row** | 3.50 |

## Context

The owner's question on 2026-11-19, looking at Friday 20 Nov's tentative orders for lot 1 of the
headline group (Four-Strategy Mix, BSE Tags): why are the buys unequal (LAURUSLABS ₹9.2k,
SOUTHBANK ₹5.9k, the new names ₹1.7–2k) when the ₹25k released should be split equally across
tomorrow's names, as the backtest does?

**What the backtest does** (`engine.py`, portfolio rule `buffer` with `entry="make_room"`): each
week it sells what fell out of the top N, splits the sale proceeds **equally** across the top N
(top-ups for names held, buys for the rest; the top category's pick at 1.5× from
`broad_top_sector_weight`), stops a name at `max_position` 25% (group cap 30%), and lets everything
else drift. It never aims at a stored weight.

**What a rebalancing lot does** (BL-142, `lots.plan_lots`): it takes the sleeve's end-of-week
`target_weights` (the model book *including its drift*), values the lot (its shares at live prices
plus its cash budget) and orders the difference to those weights, in whole shares, skipping a change
to a held name under ₹10k. A lot bought from nothing is the exception: since 2026-11-05 it buys the
current picks in equal weights. That rebalance-to-end-weights rule was a BL-142 design choice, written
on 2026-10-19 so that a lot would follow whatever the model holds. No backtest ever ran it.

**Why it bites on 20 Nov.** The model sleeve is an old book of 12 names; lot 1 holds 4 (ACMESOLAR,
CUPID, GRWRHITECH, NAZARA; bought 23 Oct, ₹53.5k, about 25% each). The model's 23 Oct rotation
(replay of sleeve `3057fa8f…`, read-only) sold NAVINFLUOR#2, WABAG, AVALON, AZAD and HONASA, bought
ABDL, SOUTHBANK, NYKAA, ENGINERSIN and TBOTEK at 4.62% each and topped up NAZARA, LAURUSLABS and
Nasdaq 100. Lot 1 took none of that, and ACMESOLAR was never in the model's book that week. So the
tentative plan for 20 Nov (₹24.5k sold, ₹26.3k bought, LAURUSLABS 4 shares, SOUTHBANK 99, charges
₹89) is the lot catching up on weeks it missed, not the model's swap. Had 23 Oct been a fresh
₹50k lot (9 equal picks, CUPID 1.5×), 20 Nov would have been one swap: sell the five names the
model drops (about ₹29k), buy about ₹2.35k of each of ten names (ATHERENERG ₹3.5k) and nothing
else. By hand, approximate (prices derived from replay returns, whole shares applied roughly).

## Goal

A due lot trades what the backtest's sleeve trades that week, scaled to the lot, so a lot built
from the model's picks stays close to the model instead of being pulled toward a drifted book.
Measured by the tracking gap (Phase 1), against the same lots under today's rule.

## Out of scope

- A new lot (already equal-weight since 2026-11-05) and a lot that is not due (BL-142: sells only
  what its sleeve marks SELL).
- The strategy, its ranks, caps and cadence: the backtest is not touched.
- Placing orders: the owner still places them on Kite.
- Re-syncing lot 1's off-model holdings by any rule other than the sleeve's own exits (Question 2).

## Plan

### Phase 1 — Measure the gap (read-only, no code in the planner)
- **Tasks:** for every past lot rebalance on the headline group (lot 1 on 23 Oct, the new lots of
  30 Oct and 6 Nov, anything due since) replay the sleeve's rotation for that week through the API
  (`POST /api/backtest/jobs` with the sleeve's saved config and `end` set to the week; the rotation
  record has `ins`, `outs`, `top_up`, ranks and the book after). Per week compute, before looking at
  results: the model's trade list; what the planner ordered; what Kite filled; and the tracking gap
  = half the sum of absolute weight differences between the lot (at close) and the model book.
  Then produce 20 Nov both ways with the tentative run's prices: today's plan, and the equal-split plan.
- **Deliverables:** a table in this file's Log and a small script under
  `packages/momentum-backtesting/scripts/` (read-only, never touches `data/`).
- **Done when:** both versions of 20 Nov's orders sit side by side with ₹ sold, ₹ bought, names,
  charges and the tracking gap of each, and the owner has read them.

### Phase 2 — Design the equal-split planner
- **Tasks:**
  - The due week's trade list comes from the sleeve's rotation for that week: `outs` the lot holds
    are sold in full; the proceeds plus the lot's free-cash budget are split equally across the
    sleeve's top N by the same loop as the engine (top-category 1.5×, 25% position cap, 30% group
    cap, the excess spread to names with room); a name the lot already holds is topped up, not
    trimmed, except a cap trim past the 5-point band.
  - Whole shares; `orders.use_leftover` buys skipped names in rank order, one share each, as for new lots.
  - The ₹10k minimum applies to an adjustment of a held name as today; decide whether it applies to
    an equal slice (Question 3).
  - Every name the lot holds is checked against the sleeve's exit rule on the due Friday (owner,
    2026-11-19): within the exit rank, keep it (no trim, no top-up beyond its slice); past it, or no
    longer ranked or eligible, sell it in full. That is the engine's buffer rule (this sleeve:
    `broad_category_exit_rank` 19, `broad_pool_exit_rank` 340, top 9 categories). It covers a name the
    model never held, like ACMESOLAR, which has no rank in the model's rows for 20 Nov, so it sells.
  - Interaction with the premium rule (BL-136 Phase 1b) and `blocked` names: a blocked name's slice
    goes to the others, as in the engine.
- **Deliverables:** a short design note in this file; no code yet.
- **Done when:** the owner has answered Questions 1–5 and the rule fits on one screen of text.

### Phase 3 — Build behind a switch
- **Tasks:** `plan_lots` gets the rule as a per-group setting (`target` today, `equal`), default
  `target` until the owner flips it; `tests/test_lot_orders.py` covers a lot that holds the model's
  names, a lot that holds off-model names, a capped name, a blocked name, a skipped share and the
  leftover buy; the Thursday 18:30 tentative message and This week's Lots panel say which rule made
  the orders; Guide page and `apps/dashboard/CLAUDE.md` updated in the same change.
- **Deliverables:** merged PR with CI green and `/code-review` run on it.
- **Done when:** the tentative run for a real Friday produces the Phase 1 equal-split orders under
  `equal`, identical to today's under `target`, and the tests pass.

### Phase 4 — Switch on and watch
- **Tasks:** flip the setting (owner), run two Fridays, and compare each lot's tracking gap with
  Phase 1's; check that `mbt journal score`'s fill reconciliation and the lot ledger still book the
  new orders (an order for a name outside the lot's target is the case to watch).
- **Done when:** two Fridays booked cleanly and the tracking gap is no worse than under `target`.

## Risks

- An off-model holding (ACMESOLAR) that the model never sold is never trimmed by an equal-split
  rule and could stay for months; the sleeve's own exits are the only thing that sells it.
- The lot never re-syncs to the model, so a lot that began off-model stays off-model. That is what
  following the backtest means; it is also the case for choosing `target`.
- A ₹50k lot cannot hold 12 names at whole-share sizes for stocks above ₹1,700 a share; the slices
  skip or round and leftover cash piles up. Equal split does not cure that (Question 4).
- Free cash: a rebalancing lot's budget is its share of Kite's free cash (BL-142's deferred cap).
  The slice size scales with it.

## Open questions

1. ~~Rebalancing lots only, or the whole planner?~~ Answered 2026-11-19: rebalancing lots only.
2. ~~How are off-model holdings handled?~~ Answered 2026-11-19: on a due Friday check each held name
   against the exit rank; keep it if within, sell it if not (Phase 2). Still to confirm with the
   owner: that "within the exit rank" means the sleeve's own `exit_rank` setting, not a number picked
   by hand (the 10th position was an example).
3. ~~Does the ₹10k minimum apply to an equal slice?~~ Answered 2026-11-19 (owner: "as per your
   recommendation"): no. A slice is ₹2–3k on a ₹50k lot, so a ₹10k minimum would block every one of
   them. The minimum applies only to a cap trim of a held name, as today.
4. ~~Is ₹50k the right lot size for a 12-name sleeve?~~ Answered 2026-11-19: keep ₹50k and the model's
   names; Phase 1 reports the whole-share leftover and skipped names per rebalance, and the lot size
   is revisited only if that is large (a separate decision, not part of this item).
5. ~~Is 20 Nov decided by the current rule?~~ Answered 2026-11-19: yes by default. No planner code
   changes before Friday 14:15. Phase 1 produces the equal-split orders for 20 Nov beside the current
   plan before then, and the owner places whichever one by hand if they prefer the other.

## Log

- 2026-11-19 — created from the owner's request after the 20 Nov tentative orders: the owner wants
  rebalancing lots to divide equally like the backtest. Evidence gathered in conversation (replay of
  sleeve `3057fa8f2cb44b3bb42d24304c6a34ee`, read-only; lot 1's ledger; `plan_lots`). Priority P1:
  real money; no code changed. 20 Nov is still planned by the current rule.
- 2026-11-19 — Owner answered Questions 1 and 2: the rule applies to rebalancing lots only, and each
  held stock is checked against the sleeve's exit rank on the due Friday (keep within, sell beyond).
- 2026-11-19 — Owner: "as per your recommendation" for Questions 3–5; answers recorded above (no ₹10k
  minimum on equal slices; keep ₹50k; 20 Nov stays on the current rule, with the equal-split orders
  produced beside it). Started: TODO.md 3.50, status In progress, Phase 1 begun.
- 2026-11-19 — Phase 1 so far: the replay API stops at the last stored week (13 Nov), so the model's
  20 Nov rotation (its `ins`, ranks, top-ups) needs the in-process sentinel run
  (`api._broad_sentinel_run(ahead=True)` via `_orders_signal`); the script must be read-only and avoid
  the catalog lock the live API holds. Provisional 20 Nov for lot 1 by hand, taking the names the
  tentative plan buys as the ins (ATHERENERG 1.5×, ENTERO, LAURUSLABS, PVRINOX, SAILIFE, SOUTHBANK,
  WABAG, SANSERA) and the exit-rank rule: sell ACMESOLAR (₹14.3k), add ₹5.3k cash, about ₹2.1k a name
  (ATHERENERG ₹3.1k): ATHERENERG 1, ENTERO 1, LAURUSLABS 1, PVRINOX 1, SAILIFE 1, SOUTHBANK 34,
  WABAG 1 (₹13.6k), SANSERA skipped, about ₹6k left for the leftover rule; NAZARA, CUPID and
  GRWRHITECH untouched (today's plan trims NAZARA ₹10.2k and buys LAURUSLABS 4, SOUTHBANK 99).
  Unverified until the sentinel run gives the real ins and top-ups.
- 2026-11-19 — Phase 1 script built: `packages/momentum-backtesting/scripts/bl236_equal_split.py`
  (read-only; saved config from the running API, the pending week from `_broad_sentinel_run(ahead=True)`,
  prices and the lot's holdings from the saved `tentative_orders.json`). The model's real 20 Nov trades
  (equal split, slice = 0.6385 each, ATHERENERG 1.5×): sells NASDAQ 100, ABDL, NYKAA, ENGINERSIN, TBOTEK
  (₹4.6 in sleeve units) and trims CUPID (above the 25% cap); buys PVRINOX, SAILIFE, ATHERENERG, SANSERA,
  WABAG and tops up SOUTHBANK, ENTERO, LAURUSLABS. That corrects the by-hand figures above (the model
  also tops up SOUTHBANK / ENTERO / LAURUSLABS, which the lot does not hold, and buys SANSERA).
  Lot 1 under the equal split with the exit-rank check: keeps CUPID, GRWRHITECH, NAZARA (all in the
  model's book), sells ACMESOLAR only (₹14.3k). Slices over the 8 buy names:
  - proceeds only (₹14.3k): ATHERENERG 1 + SOUTHBANK 28 = ₹3.6k; the other six slices (₹1.7k each)
    buy less than one share and are skipped; ₹10.7k left.
  - proceeds + free cash (₹29.6k): ATHERENERG 2, SOUTHBANK 58, PVRINOX 2, SAILIFE 1, ENTERO 1,
    LAURUSLABS 1, WABAG 1 = ₹18.7k, SANSERA skipped (₹4.7k a share); ₹10.9k left.
  Today's plan (sell ACMESOLAR ₹14.3k, trim NAZARA ₹9.8k, buy ₹31.5k) ends 12.5% from the model's end
  book; the equal split ends 27.9% (with cash) or 37.8% (proceeds only) from it; the lot is 55.6% from it
  now. So the gap to the END book favours `target` for a lot that began off-model, by construction: the
  equal split never closes a gap the lot already has. It also leaves 20–35% of the lot in cash at ₹50k
  because slices are below a share price (Question 4 is live, not hypothetical). Not yet done: the table
  of past rebalances (23 Oct lot 1, the 30 Oct and 6 Nov new lots) and a gap measured against a model
  the lot followed from the start; the right comparison for the owner's goal is "trades what the backtest
  trades", not "ends at its book". Needs the owner's read before Phase 2.
- 2026-11-19 — Owner, after the Phase 1 numbers: "Equal split. Make the change in ui too." Phases 2–3
  built the same evening, with one change to the plan: the switch is `MOMENTUM_LOT_RULE` in `.env`
  (`equal`, the default, or `target` for the BL-142 rule), not a per-group setting, so no migration.
  - `orders.plan_equal_split` (sells every held name outside `keep`, trims a name past
    `max_position + cap_band` to `max_position` under the ₹10k minimum, splits proceeds + trims + the lot's
    cash by the sleeve's own slice weights, water-filled under the cap, whole shares, no minimum on a
    slice, charges counted in the budget), then `orders.use_leftover` in rank order.
  - `lots.Lot.slices / keep / max_position / cap_band`; `plan_lots` takes the equal path for a due lot
    that holds shares (a new lot keeps the fresh-equal rule, a lot not due its forced exits); each lot's
    result carries `rule` (`equal | target | fresh | null`).
  - `api._equal_split_recipe` reads the engine's own week: slices = the BUY / ADD trade values (the top
    category's 1.5× is already in them), keep = the book after the week plus any name ranked inside
    `broad_category_exit_rank`; added to the sleeve signal only for the orders (`with_slices=True`), so
    journals, goldens and the weekly message are unchanged. The premium gate drops a gated name's slice.
  - UI: the orders list shows how a rebalancing lot was planned, the Lots panel's last-orders line
    says it, the Telegram lot header says "what the strategy trades this week, split equally", Guide page
    `momentum/this-week.md` updated.
  - Verified: 2081 Python tests pass (new `tests/test_equal_split.py`), dashboard vitest for
    `src/components/momentum` and `momentumLots` pass, dashboard typecheck shows only the two
    pre-existing `tailwindClasses.test.ts` errors. On the real 20 Nov data (live Fyers prices) lot 1:
    sell ACMESOLAR 35 (₹14.3k), buy ATHERENERG 2, ENTERO 1, LAURUSLABS 1, PVRINOX 2, SAILIFE 1,
    SOUTHBANK 58, WABAG 1, and SANSERA 1 from the leftover; ₹23.4k bought, ₹6.2k cash left. The Friday
    14:15 run recomputes it from Friday's data. Thursday's saved tentative file was regenerated.
  - Open: Phase 4 (two Fridays, check the ledger books the new orders, tracking gap vs `target`); the
    past-rebalance table; the post-trade target column of a leftover buy shows 0%. Not committed.

