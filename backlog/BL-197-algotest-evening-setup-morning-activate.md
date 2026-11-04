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
- Seen 2026-11-03: Activate opens a "Select Broker for <name>" sheet listing both brokers (LOGGED IN), nothing
  ticked; its button reads "Activate on n Brokers"; nothing to confirm after it; one RUNNING card per broker.
  The deployer now ticks every broker whose AlgoTest row uploads the list and checks the count (first step of
  this phase, used by the 09:16 job until the after-login run exists).
- Built 2026-11-04 (PR pending): `strategy-deploy.ts --morning` activates the export `latest-t1.json` points at
  (the evening's `--next` export for today; a recorded export is refused, so a catch-up never trades the
  09:16 list) through `planDeploy` and the proven broker-sheet path; the add-on
  follows the settings as read at 08:11 (`algotestAddon`, `morningPicks`: on 2026-11-04 the owner switched it
  off at 18:47, after the 16:40 export had set it up; the other way round, an add-on switched on overnight is
  not in AlgoTest, and the message says to upload it by hand). Scheduler job `algotest-activate` (08:11, `quantiply`
  group, so after the login; no retries; caught up until about 12:40, the last entry) replaces `algotest-deploy` (09:16) and
  `algotest-topup` (09:18), which are gone: nothing re-exports today's AlgoTest folder after 09:16, so the
  trade monitor's 09:25 deploy check (`DEPLOY_CHECK=on`) compares /live with the evening list (said in its
  note) under the same add-on rule. The stop hold, the pause and the monitor's job list follow the new id.
- **Done when:** one morning activated by the tool, read back on /live, with the owner watching.

## Log

- 2026-11-02 — created from the owner's request; decisions recorded above. Phase 1 built and run on
  the 2026-11-03 picks (all three "Ready to deploy", Candle Close). For 2026-11-03 the owner activates by
  hand; the 09:16 auto-deploy should be off (Automated deployment) so it does not act on a 09:16 change.
- 2026-11-03 — the owner activated `T1 · N_p80_0947` by hand on both brokers (Angel One + Finvasia, the
  owner's choice: both AlgoTest rows upload T1) while Claude read the broker sheet. The owner then asked the
  tool to do the other two: the deployer learned the broker sheet (probed live: both ticked, "Activate on 2
  Brokers", Cancel), and the 09:16 `algotest-deploy` activates them, Automated deployment on.
- 2026-11-04 — the owner activated by hand again (two evening strategies seen deployed at 09:16; the tool's
  ledger has no deploy). The 09:16 pick had changed (N_wide_0917 out, S_p320_0947 and a 12:17 add-on in): the
  09:16 run exited 1 on the new SENSEX pick, the 09:18 top-up uploaded it, and the add-on the evening had set
  up was off in settings v10 (18:47 the day before). Phase 2 built the same day (above): the after-login
  activation, the two 09:16 jobs retired, the 09:25 check on the evening list. First live morning: the next
  trading day, owner watching; the owner activates by hand if no Telegram message has come by 08:30.
