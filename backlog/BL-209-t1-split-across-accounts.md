# BL-209 — T1 split across the two AlgoTest accounts: the like pair one per account at 2 lots, the odd pick 1 lot each, uploaded and activated by the tool

| | |
|---|---|
| **Priority** | P1 — real money every trading day: about ₹134 a day more after brokerage on the owner's two live T1 accounts (exploratory replay), the same lots and margin per account, built mostly from pieces that already run |
| **Status** | In progress (Phase 2 built; Phase 3 next) |
| **Type** | feature (with an exploratory replay behind it) |
| **Area** | options / broker-login / scheduler / dashboard |
| **Created** | 2026-11-04 |
| **Depends on** | BL-137 (AlgoTest upload), BL-197 Phase 2 (08:11 morning activation, PR 415), BL-183 (Dir ×2), BL-140 (Settings › Automation), BL-205 (margin block), BL-143 (09:25 deploy check) |
| **TODO.md row** | 3.10.61 |

## Context

Owner (2026-11-04): T1 trades on both AlgoTest accounts, Shoonya (Finvasia) and Angel One, and each
account trades every pick. "Instead, let's unify this": on a day of one Dir and two Widesl, each
account takes the Dir, and the two Widesl go one per account at 2 lots. On a three-Widesl day two of
them go one per account at 2 lots and the third trades 1 lot on each. "If the loss is like ₹200, then
it is not a benefit." Brokerage: Shoonya ₹5 an order, Angel One ₹20 an order.

**The replay** (`packages/option-backtesting/research/bl209/two_accounts.py`; exploratory, in-sample,
paper, before slippage; T1's journal picks from 19 Oct 2026, re-derived before; 440 days from
10 Jan 2025; each account under its own book stop of ₹9,000 plus the MTM SL of every lot beyond
three, the live T1 rule):

| Layout | Total, both accounts | Per day | Max drawdown | Worst day | Last 12 months |
|---|---|---|---|---|---|
| Today | ₹15,60,762 | ₹3,547 | −₹56,312 | −₹23,188 | ₹9,07,479 |
| Split | ₹16,19,741 | ₹3,681 | −₹58,691 | −₹23,089 | ₹9,38,327 |

- Split minus today: **+₹134 a day**, 90 % interval +₹96 to +₹173 (5-day block bootstrap).
- Of that, brokerage saved: about ₹103 a day on Angel One and ₹26 on Shoonya. A 2-lot leg is one
  order, so the like pair costs half the orders. This part is arithmetic, not a fit.
- The book stops net about +₹6 a day. Account stops fire more often (59 against 34) because each
  account now holds two lots of one Widesl. They were better on 22 days (+₹27,474) and worse on 17
  (−₹24,982). The costliest day was 28 Jul 2025: −₹19,613 against −₹15,888.
- Day shapes: 1 Dir + 2 Widesl on 370 days, 3 Widesl on 70.
- **Lots per account do not change.** On a normal day each account still trades three lots (four on
  Shoonya when the Dir is doubled). So the margin each account needs is about the same as today, and
  the ₹9,000 + extra-lot stop rule carries over.

**What the automation does today:**

- `obt rotation algotest-export --from-settings` (`rotation/algtst_export.py`) writes one `.algtst` per pick,
  named `T1 · <variant>`. One export serves every AlgoTest account. The evening job `algotest-evening`
  (16:40) uploads it with `strategy-upload.ts` and sets up each pick's execution (`strategy-deploy.ts
  --setup`: multiplier checked at 1, Trade monitoring on Candle Close).
- The 08:11 `algotest-activate` (`strategy-deploy.ts --morning`) activates each pick once on /live. The
  broker sheet then has every broker ticked whose AlgoTest row uploads T1 (`algotestDeployBrokers`), so
  each pick runs on both accounts. It refuses a Quantity Multiplier other than 1 and never sets one.
- BL-183's Dir ×2 is built into the export: the Dir's legs at 2 lots, its overall MTM SL kept at the
  1-lot figure because AlgoTest scales it by the leg lots itself. It applies only when **every** row
  uploading the list has it on (`automation_settings.dir_boost_wanted`). Settings v10 (3 Nov) has
  it on for Shoonya and off for Angel One. So the export the tool uploads keeps the Dir at 1 lot on
  both accounts, and the replay's "today" assumes a Shoonya Dir ×2 the tool does not upload (open
  question 1).
- Nothing in the repo sets AlgoTest's broker-level MTM SL, so neither account's book stop is
  automated on AlgoTest (2026-11-03).
- Readers of each account's lots: the margin block (`rotation/margin_lines.py` `tomorrow_lots`), the
  messages (`rotation/messages.py`, `result.py`), the lot plans, the live board, the 09:25 deploy check
  (`monitor-plan.ts` `checkAlgoTest`: each pick once per row that holds it, multiplier 1),
  `live-capture.ts` and `obt rotation live-compare` (copies are lots), and the stop button
  (`NAME_PREFIXES`, the upload ledger).

## Goal

With a Settings › Automation switch on, the evening export, upload and setup and the 08:11
activation put T1 on the two AlgoTest accounts in the split layout. Every pick trades the same
lots across both accounts as without the switch. Every reader of an account's lots agrees with what
was activated. With the switch off, every file, upload and activation is exactly what it is today.

Measured after switch-on: over the first 20 trading days, the contract notes' brokerage per day on
each account falls by about the replay's figure (Angel One about ₹100, Shoonya about ₹25), with no
day on which a pick traded on the wrong account or at the wrong lots.

## Out of scope

- Core (Adaptive): no account trades it now (settings v9 / v10).
- Quantiply. Both Quantiply rows are off; the same split there would need `quantiply-export` and the
  Quantiply deployer, a later phase if the owner moves T1 back.
- Any change to the ranking, the picks, the lot ladder (BL-204) or the Dir ×2 rule itself.
- More than two accounts.

## Plan

The design keeps two safety properties the tool has today: the Quantity Multiplier is always 1
(lots live in the uploaded file, as Dir ×2 does), and the activation never moves a strategy to a
broker the plan did not give it.

### Phase 1 — The split rule, in one place

- **Tasks:**
  - `rotation/account_split.py`, pure: `split(core, dte, rows) -> {broker: {variant: lots}}` for
    the day's core picks and the AlgoTest rows that upload T1. Rules as replayed:
    - The odd pick (the Dir on a 1 Dir + 2 Widesl day; the third Widesl on a 3-Widesl day; the
      Widesl on a 2 Dir + 1 Widesl day) trades 1 lot on each account.
    - The like pair goes one per account, each at both accounts' lots (2). Shoonya (the lead, ₹5
      an order) takes the pair member with a re-entry, since a re-entry is more orders; with none
      or both, the first in pick order (owner, 2026-11-04).
    - The Dir ×2 extra lot stays on the account whose row has Dir ×2 on.
    - Any other shape, or anything but exactly two rows uploading T1, returns today's layout.
    - The Buy add-on, when on, goes to Shoonya only.
  - Settings › Automation: one switch, "Split T1 across the AlgoTest accounts" (default off).
    The lead account is Shoonya (`account_split.LEAD`), not a setting. Written by
    `apps/scheduler/src/automation.ts`, read by `rotation/automation_settings.py` (`split_t1`);
    the TypeScript jobs read the export's manifest, not the switch. Saved freely; it changes the
    export only while both AlgoTest rows upload T1, and the page says so.
  - Move the replay onto the module, so the research script and the live rule are one function.
    Re-run it and record the figures in the Log.
  - Guide page for Settings › Automation.
- **Deliverables:** the module and its tests; the setting end to end; the replay on the module.
- **Done when:** the replay reproduces its figures through `account_split.split`, and the tests
  cover each shape, expiry days, Dir ×2 on and off, and one row uploading.

### Phase 2 — The evening export, upload and setup

- **Tasks:**
  - `algotest-export --from-settings` under the switch writes one strategy per distinct
    (variant, lots): `T1 · <variant>` at 1 lot, `T1 · <variant> · ×2` at 2 lots, through
    `live_lots.scaled(..., overall_per_lot=True)` as Dir ×2 does. On a normal day that is the
    Dir at 1 lot, the Dir at 2 lots on a Dir ×2 day, and each Widesl ×2. It also keeps today's
    1-lot copies of the pair and today's Shoonya Dir copy, for the fallback when one account is not
    logged in (Phase 3). That is up to six saved strategies; only four are activated.
  - The manifest gains `accounts: {finvasia: [names], angelone: [names]}`. That block is the one
    record every later step reads; no step re-derives the split.
  - `strategy-upload.ts` uploads and deletes every strategy in the export as today (ledger by id).
    `--setup` sets up each one. Check the new name suffix against `NAME_PREFIXES`, `TOOL_PREFIXES`
    and the stop button's `toolMatcher` (append-only lists).
  - AlgoTest's /live 6-strategy limit: the split needs 4 deploys a day (2 on each account) against
    today's 6, so it uses fewer slots. Check how /live counts a deploy on two brokers.
- **Deliverables:** export, upload and setup under the switch, each tested on a fixture day per shape.
- **Done when:** a `--from-settings --next` dry run on a real evening writes the expected files and
  manifest. A supervised evening run uploads and sets them up, and each is read back identical.

### Phase 3 — The morning activation and the checks

- **Tasks:**
  - `strategy-deploy.ts --morning` reads `accounts`. Each strategy is activated with only its own
    account ticked on the broker sheet (`checkBrokerSheet` with one broker), multiplier still checked
    at 1. A strategy for both accounts (the 1-lot odd pick) keeps today's two-broker activation.
  - An account not logged in by 08:11 (owner, 2026-11-04): treat it as absent. The logged-in
    account trades all of T1 in today's layout (every pick at its own row's lots, the 1-lot copies),
    so its margin and stop are what they are without the split. The 08:11 message says so.
  - The 09:25 deploy check (`checkAlgoTest`) and the 15:35 `--check` read `accounts`: each strategy
    on exactly its accounts at multiplier 1.
  - `live-capture` and `live-compare`: map `· ×2` names to their variant at 2 lots, so "copies are
    lots" still holds and paper-per-lot is unchanged.
- **Deliverables:** the activation, the checks and the live comparison under the switch; tests on
  stand-in pages as for BL-197.
- **Done when:** one morning is activated by the tool in the split layout with the owner watching,
  and the 09:25 check and the evening's live-vs-paper lines agree with it.

### Phase 4 — Messages, margin and the Trade book

- **Tasks:**
  - The 16:00 margin block (`margin_lines.tomorrow_lots`) and the 09:05 margin check take each
    account's lots from the split. On a normal day the totals stay the same; on a Dir ×2 day they
    differ by account.
  - The evening "tomorrow" lines and the 09:16 lines say each account's picks under the switch, for
    example `Shoonya: Dir ATM 1 · Widesl OTM1 ×2`.
  - The per-account book stop for the day, ₹9,000 plus the MTM SL of each lot beyond three, from
    the split's lots, in the 16:00 and 08:11 messages (set by Phase 4b).
  - The Trade book's realised figures by source (`obt realised trips`) recognise the `· ×2` names.
  - Guide pages for the screens and messages that change.
- **Deliverables:** the lines, the margin figures and the attribution under the switch.
- **Done when:** a fixture day's 16:00 message shows each account's picks, lots, margin need and
  book stop, and the Trade book attributes a `· ×2` fill to T1.

### Phase 4b — Each account's book stop set on AlgoTest

Owner (2026-11-04): "stops also should be automated". Nothing in the repo sets AlgoTest's
broker-level MTM SL today, on either account, with or without the split.

- **Tasks:**
  - Find the call: read the /live page's public JavaScript for the broker-level SL save and read
    calls, as BL-143 Phase 4 did for square-off. Then read the owner's current setting back with
    the read call only. Record the contract in `docs/algotest-execution.md`. The first write is
    done with the owner watching.
  - `broker-login/src/algotest-book-stop.ts`: after the 08:11 activation, set each account's stop
    from the day's layout (split, fallback or today's), then read it back. A difference is an alert
    and never a retry loop. Behind its own `.env` switch (`ALGOTEST_BOOK_STOP=on`), off by default.
  - The same figure in the 08:11 message and the 09:25 check.
- **Deliverables:** the call documented, the setter and its tests, one supervised morning.
- **Done when:** both accounts' broker-level stops are set by the tool and read back equal on one
  supervised morning.

### Phase 5 — Switch-on and the forward check

- **Tasks:**
  - The owner turns the switch on. Restart the scheduler, since jobs read the settings at their run
    and `.env` at start.
  - For 20 trading days, `research/bl209/forward.py` compares each account's brokerage per day
    (contract notes, BL-168) with the 20 trading days before. It also compares live-vs-paper slippage
    per lot, and the account stops that fired against what the replay predicts for those days.
- **Deliverables:** the forward read-out in the Log.
- **Done when:** 20 trading days are read.
  - **Keep** if brokerage per day fell on both accounts and no day traded the wrong layout.
  - **Revisit** if the per-account stops cost more than the brokerage saved over those days.

## Risks

- **One account fails to log in.** The other then trades all of T1 in today's layout (Phase 3), so
  only that account's half of each pick is missed, as today. The 1-lot copies must already be
  uploaded and set up in the evening for this to work at 08:11.
- **Concentration per account.** Each account's day now rides on two lots of one Widesl, so account
  stops fire more often (59 against 34 in the replay) and the drawdown across both is about ₹2.4k
  deeper. The worst day was no worse in the replay. A day like 28 Jul 2025 costs about ₹3.7k more.
- **A wrong lot is wrong in rupees.** The ×2 copies must never reach an account the plan did not
  give them. Hence the manifest's `accounts` block as the single record, the one-broker tick, the
  read-back and the 09:25 check.
- **Names.** A new `· ×2` suffix touches everything that matches on names: the upload and deploy
  ledgers, live capture, the stop button and the Trade book. Those lists are append-only, and each
  needs a test.
- **In-sample replay.** The brokerage saving is mechanical, but the stop effect (+₹6 a day) is noise.
  The forward check measures the saving on the contract notes, not the replay.

## Owner's answers (2026-11-04)

1. **Shoonya's Dir ×2:** doubled by hand on /live today. Until Phase 2 the tool's export stays at
   1 lot for both accounts (mixed rows), so a hand double is needed on every non-expiry day with a
   Dir. Under the split the extra lot goes to Shoonya's copy alone.
2. **An account not logged in:** treat it as absent; the logged-in account trades all of T1.
3. **Pair order:** Shoonya first is fine; the pair member with a re-entry goes to Shoonya, as its
   brokerage is lower.
4. **Brokerage:** Angel One ₹20 an order, Shoonya ₹5.
5. **Book stops:** to be automated by the tool (Phase 4b).
6. **Buy add-on:** if switched on, Shoonya takes it.

## Log

- 2026-11-04 — created from the owner's two-account idea. Exploratory replay: split +₹134 a day after
  brokerage (90 % +₹96 to +₹173), of which ₹103 Angel One and ₹26 Shoonya brokerage, stops about
  +₹6; script `research/bl209/two_accounts.py`.
- 2026-11-04 — started. Owner's six answers recorded above; the plan now has the logged-in-account
  fallback, the re-entry pair member on Shoonya, the add-on on Shoonya and Phase 4b (the book stops
  set by the tool). Phase 1: `rotation/account_split.py` and its tests; the replay now runs on it.
  Re-run, 440 days: the split by pick order +₹134 a day against today (90 % +₹96 to +₹173), the
  re-entry rule +₹131 (+₹92 to +₹171). The re-entry rule moved a pick on 79 days, saved ₹2 a day
  more brokerage (re-entries fire only after a stop) and cost ₹5 a day in the book stops, which is
  noise (re-entry minus pick order −₹3 a day, 90 % −₹22 to +₹10). Kept as the owner's rule: its
  brokerage saving is certain, its stop effect is not.
- 2026-11-05 — Phase 1 done: the `splitT1` switch in Settings › Automation (scheduler validation, an
  older dashboard keeps the current value, the card with its note, Guide), `split_t1` in the Python
  reader. Phase 2 built: `algotest-export --from-settings` writes the split copies and each
  account's trade-alone copies, `· ×N` names and `<variant>-xN.algtst` files, the manifest's
  `split`, `accounts` and `alone`; `live-capture` records a copy's `lots` from its name and
  `live-compare` counts it. `strategy-deploy.ts --morning` / `--check` refuse a split manifest
  (Telegram on the morning run) until Phase 3. Dry runs from the live settings v10 with the switch
  on: 4 Nov (normal day) six copies, Shoonya `S_ditm1-t1s44_0917 ×2 · N_wide-t1s8_0947 ×2`, Angel
  One `S_ditm1-t1s44_0917 · S_p320_0947 ×2`, as the replay; 5 Nov (SENSEX expiry) five copies.
  Not verified: a supervised evening upload and setup of the copies, and whether set-up copies
  count toward /live's 6-strategy limit (six on a normal day, seven with the add-on). The 09:25
  deploy check and the 09:05 margin check (both off) do not read the split yet (Phases 3 and 4).
