# BL-197 — AlgoTest: Setup Execution every evening, Activate right after the morning broker login

| | |
|---|---|
| **Priority** | P1 — T1 trades on AlgoTest from 2026-11-03 and the 09:16 auto-deploy has never deployed |
| **Status** | In progress |
| **Type** | feature |
| **Area** | broker-login, scheduler |
| **Created** | 2026-11-02 |
| **Depends on** | BL-137 (upload), BL-138 (deployer), BL-140 (settings), BL-156 / BL-196 (why Candle Close) |
| **TODO.md row** | 3.30.6 |

## Context

2026-11-02: the owner moved T1 from Quantiply to AlgoTest (Settings › Automation v9: both AlgoTest rows
upload T1, both Quantiply rows off), because AlgoTest's "Trade monitoring: on Candle Close" checks the
overall MTM stop at each minute's close, as the backtest does, with leg stops still on LTP (BL-156's
combination ③; BL-196). The 09:16 deployer (BL-138) had never deployed: on 26–27 Oct it timed out on
`getByText('Strategy Deployed')`, a header /live no longer shows.

## Owner's decisions (2026-11-02)

- "Let's do setup execution every day evening. Activate can be done at morning after 8 am."
- **Who activates:** the tool, "after broker login itself, don't wait for 8:20".
- **When the 09:16 pick differs from the evening's list** (about 3% of days, BL-180): **the evening
  list trades**; the 09:16 difference is ignored on AlgoTest.

## Plan

### Phase 1 — Evening setup (2026-11-02)

- `strategy-deploy.ts --setup`: each evening pick's sheet checked (multiplier 1, NRML, no day ticked,
  execution time = entry) and saved with Trade monitoring on Candle Close; the row must turn "Ready to
  deploy". Gated by `ALGOTEST_UPLOAD=on` and an AlgoTest row uploading the list; deploys nothing.
- The last step of `algotest-evening` (16:40).
- Fixes found on the way: /live's header (`Deployed Strategies`, no "n/6 Strategy Deployed" any more:
  no slot limit is invented when the count is gone) and the sheet's title ("Select execution for" at
  1440 px).
- **Done when:** run on the 2026-11-03 picks: all three "Ready to deploy" (done 2026-11-02 19:5x).

### Phase 2 — Activate after the morning login

- Observe the owner's first Activate by hand (2026-11-03, after the 08:02 login, in the browser pane):
  what it opens with two brokers logged in.
- Then: the deployer activates the evening list (the export for today, `source: preview`), in the
  `quantiply` job group right behind `broker-login`; the 09:16 run and the 09:18 top-up stop deploying
  or uploading for AlgoTest (the evening list trades).
- **Done when:** one morning activated by the tool, read back on /live, with the owner watching.

## Log

- 2026-11-02 — created from the owner's request; decisions recorded above. Phase 1 built and run on
  the 2026-11-03 picks (all three "Ready to deploy", Candle Close). For 2026-11-03 the owner activates by
  hand; the 09:16 auto-deploy should be off (Automated deployment) so it does not act on a 09:16 change.
