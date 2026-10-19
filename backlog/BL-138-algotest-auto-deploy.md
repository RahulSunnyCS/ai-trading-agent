# BL-138 — Deploy the rotation picks in AlgoTest automatically: paper first, live gated

| | |
|---|---|
| **Priority** | P1 — the owner trades the T1 picks with real money and asked for the deploy to be automatic (2026-10-19); a wrong or duplicate deploy costs money, so it is planned with its own gates |
| **Status** | In progress: built ready but switched off; the owner decides later whether to use it |
| **Type** | feature |
| **Area** | broker-login (AlgoTest automation), options (picks), infra (scheduler) |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 (export, upload, ledger, the AlgoTest discovery); BL-058 / BL-113 (the 09:16 journal) |
| **TODO.md row** | §3.31 |

## Context

The owner's day, as described on 2026-10-19:

- **08:00** — logins: AlgoTest with Finvasia and Angel One, Quantiply through Angel One, and the
  Angel One SmartAPI check.
- **09:16** — the final picks, with the VIX from Fyers, or Angel One as the fallback.
- **16:00** — the result and tomorrow's expected picks on Telegram.
- **Evening** — the old strategies are replaced in AlgoTest by tomorrow's.

BL-137 covers the uploads. Deploying (starting a strategy so AlgoTest trades it on the owner's broker)
was left as a human click. The owner now wants the tool to deploy too.

This changes three things the repo says today, all of which must be rewritten when Phase 4 code lands:

- `overview.md` / `business.md`: "It does not place orders" and "this repo places no orders".
- BL-118 (order adapter, on the BL-115 research branches): "Out of scope: automating AlgoTest or
  Quantiply (the interim stays manual)". This item replaces that line for AlgoTest.
- `docs/algotest-execution.md` §6: AlgoTest's documented execution API (Signals, custom positions)
  was declined on cost (₹1,299 a month), with "Revisit if Playwright upkeep exceeds it".

Known constraints:

- SEBI's retail algo framework (April 2026) requires an exchange Algo-ID on algo orders. Quantiply
  paused its algo services for it (BL-118 Context). AlgoTest places the orders from its own platform.
  Our part only triggers the deploy. Whether that needs anything more is checked in Phase 0. This is
  a note, not legal advice.
- A 09:17 pick is known at about 09:16:20, so it leaves well under a minute to deploy. BL-118
  counted 64 such days in 243.
- `BROKER_LOGIN_ONLY=finvasia` is set at present, so only Finvasia is logged into AlgoTest each
  morning.

## Goal

On each trading day, the strategies AlgoTest runs on the owner's account are exactly that day's
recorded picks: no more, no fewer, none twice, 1 lot each. They run first in AlgoTest's paper mode
(Forward Test), then live once the owner says so on record. Any doubt (no journal entry, a late
entry, a failed check) means **no deploy and an alert**, never a guess and never a late entry.

## Out of scope

- Deploying anything that is not in that day's recorded journal entry: a preview, a hand-built
  strategy, a friend's account.
- Core-298 until T1 has run clean (BL-137 Q7).
- Our own order placement through a broker (BL-118).
- Changing what AlgoTest does once a strategy is deployed: its stops, trail and exits.

## Plan

### Phase 0 — Decisions and checks (owner + Claude, before any code)

- **Tasks:**
  - Read AlgoTest's terms on automating the website. If they forbid it, the route is the paid Signals
    API (Q1).
  - Ask AlgoTest (or check its docs) whether a deploy triggered from outside, on their platform,
    needs anything under the April 2026 algo framework.
  - The owner answers the open questions below. The answers and this decision go in the Log and in
    `TODO.md`.
- **Done when:** a route is chosen (web app, or the Signals API) with the reason logged, and nothing
  found in the terms or the framework stops it.

### Phase 1 — Discovery of the deploy flow (paper only, owner present)

Run together with BL-137 Phase 2, the same way: the owner's code logs in, and nothing is typed by
Claude.

- **Tasks:** record, for a saved strategy:
  - the requests for a Forward Test (paper) deploy and for a live deploy, with the broker, the
    multiplier (lots) and any confirmation step;
  - what a deployed strategy does the next day (runs daily until stopped, or once);
  - whether a deploy after the entry time enters late or waits a day;
  - how to stop or undeploy, and what happens to an open position;
  - where to read the deployed list, the strategy status, orders and positions;
  - how AlgoTest shows that a broker is not logged in.

  Nothing live is clicked in this phase.
- **Deliverables:** `docs/algotest-execution.md` §8, "Deploy contract".
- **Done when:** a paper deploy, its read-back and its stop are each done once by hand and documented.

### Phase 2 — The deployer, paper only

- **Tasks:** a `deploy` command in `packages/broker-login` (it shares the uploader's login and
  ledger):
  - **Input:** today's recorded journal entry only, with its hash checked against the chain (`obt
    rotation verify --track t1`). No entry, a late entry or a broken chain means no deploy and an
    alert.
  - **Order of checks:**
    1. the strategy is uploaded (BL-137 ledger) with today's content hash;
    2. the broker is logged in on AlgoTest (for live);
    3. the pick is not already deployed (ledger plus AlgoTest's own list);
    4. there is still time before entry (Q3).

    Then deploy at 1 lot and read the deployed list back. Any mismatch stops the run and alerts.
  - **Limits, checked before any send:** at most the day's pick count (3 core + 1 Buy add-on), 1 lot
    each, only names with the `T1 · ` prefix, only `paper` until Phase 4 switches it.
  - **Kill switch:** `ALGOTEST_DEPLOY=off` (read at start) and a Telegram button "Stop all today",
    which undeploys every deployed tool strategy (callback data, never a URL; `@trading/notify`).
  - A ledger row before every send; one attempt; never a blind retry.
  - **Deploy window:** AlgoTest deploys only between 08:00 and 15:40 IST ("Strategies can only be deployed
    during 08:00 IST to 15:40 IST", seen 2026-10-19 at night). Because an activation repeats on its weekdays,
    every tool-activated strategy is **deactivated at 15:30–15:39, after the 15:28 exit**, so each day starts
    with nothing active. The 09:16 run then activates only that day's picks. This avoids yesterday's 09:17
    pick trading at 09:17 before a morning deactivation could run. If the 15:30 deactivation fails, the owner
    is alerted at once, while there is still time to do it by hand. Whether deactivating is also limited to
    the window is checked in Phase 1.
  - **Evening:** BL-137's delete and upload run after 16:00 and need no deploy window; only activation does.
  - **Scheduler:** right after the 09:16 entry is recorded (inside `pick --with-t1`, or a job
    triggered by it), never on a fixed clock that could run before the entry.
  - **The 09:17 budget:** the entry is recorded at about 09:16:20, leaving about 40 s. So at 09:14 the
    deployer logs in, checks the broker and reads the deployed list. At 09:16 only the deploy calls
    remain, sent for the 09:17 picks first. Over HTTP a call should take about a second. Through the
    website (Playwright) each deploy is several seconds of page work, which is tight for two or more
    09:17 picks. Phase 1 times both.
  - The 09:16 message gets a line: "AlgoTest (paper): deployed 3/3 at 09:16:31" or what failed.
- **Deliverables:** the deployer, tests against a recorded fake of AlgoTest, the Telegram button.
- **Done when:** a supervised paper day deploys exactly the recorded picks, and re-running the job
  changes nothing.

### Phase 3 — Paper run (unattended)

- **Tasks:** 10 trading days in Forward Test. Each evening compare:
  - deployed = picks;
  - AlgoTest's paper trades for each pick against our stored one-lot result (strike, entries, stops,
    exit), with the difference in rupees.
- **Done when:** 10 days with no missing, extra or duplicate deploy, and every rupee difference
  explained. Differences in AlgoTest's own fills go to BL-009.

### Phase 4 — Live (gated: Phase 3 passed **and** the owner's go on record)

- **Tasks:**
  - Switch to live on the broker the owner names (Q4), 1 lot each.
  - Check the broker's login state on AlgoTest before every deploy. If it is logged out, nothing is
    deployed and the owner is alerted (the 08:00 login can fail).
  - At 15:35, reconcile AlgoTest's positions and orders with the picks. The next day, reconcile
    with the contract note (`packages/contract-notes`).
  - In the same commit, rewrite the "places no orders" lines in `overview.md` / `business.md` and
    note the decision in `docs/algotest-execution.md` §6.
- **Done when:** 10 live days with every deploy reconciled, no position the picks do not explain,
  and the kill switch tested once on a live day.

## Risks

- **AlgoTest's terms or an account block** for automating the website: Phase 0 checks the terms
  first; the Signals API is the sanctioned route.
- **A dropped pick still deployed:** it trades money the owner did not mean to. The deployer only
  ever deploys the recorded entry, and the evening stops everything the tool deployed.
- **A missed deploy** (laptop asleep, login failed, AlgoTest slow): no trade, and the owner is
  alerted; never deployed late. The trading day's result then differs from the journal's.
- **The 09:17 race:** a deploy can miss 09:17 on some days, most likely through the website rather
  than HTTP. Phase 1 measures how long a deploy takes, and whether AlgoTest needs a strategy deployed
  some seconds before its entry minute. Q3 sets the cut-off. Not chosen: deploying the evening's
  expected 09:17 picks at 09:15 and undeploying a dropped one at 09:16. It is faster, but if the
  undeploy fails, a strategy the picks dropped trades real money.
- **The broker session expires mid-day**, so AlgoTest cannot exit a position. AlgoTest's own
  handling applies; it is checked in Phase 1, and the 15:35 reconciliation catches it.
- **Undocumented endpoints change.** The read-back after every deploy catches a silent change.
- **Duplicates across books:** when Core is added, the same strategy picked in both books is one
  2-lot deploy, not two (memory of 2026-10-18); handled before Core is enabled.

## Open questions

1. **Route:** automate AlgoTest's website, or pay for the Signals API? The Signals API is
   documented: our scheduler would send each strategy at its entry time with an exit time, and there
   would be no daily upload or delete. Whether its payload carries trail, re-entry, range breakout
   and the overall MTM stop is unknown.
2. **Paper days before live:** 10?
3. **09:17 cut-off:** if a 09:17 pick cannot be deployed by 09:16:50, skip it (no trade), or deploy
   anyway and let AlgoTest enter late if it does?
4. **Which broker account** for live T1: Finvasia (the only one logged in at 08:00 today) or Angel One?
5. **Approval:** fully automatic, or a one-tap Telegram approval of tomorrow's preview at 16:00 (with
   09:16 changes then deployed automatically)?
6. **A daily loss cap** for the book (stop everything at -₹X), on top of each strategy's own MTM
   stop?

## Log

- 2026-10-19 — created at the owner's request ("I want the tool to deploy the strategies in AlgoTest
  as well"). Plan only; nothing built or run.
- 2026-10-19 — Phase 0, terms read (algotest.in/tnc, "Terms of Use", no date shown; read from the
  page's script because the page is drawn by JavaScript). What it says that bears on this item:
  - **No clause forbids automating actions on your own account**, and nothing says "no bots". The
    08:00 broker login has automated the website through Playwright for weeks.
  - **Data gathering:** the user shall not exploit content "not submitted or provided by the user",
    including by "automated data gathering or extraction tools, programs, scripts, deep links",
    without prior written consent. Reading back our own strategies and deploys is our own content,
    but the clause shows AlgoTest wants consent for scripted access.
  - **Reverse engineering:** the user shall not "reverse engineer ... any information, software,
    products or services obtained through the Platform". Calling the web app's internal requests,
    found by watching its network traffic, is the route closest to this. It weighs against BL-137's
    "HTTP if possible" for anything beyond the documented login.
  - **Responsibility:** the user is "solely responsible for all the activities in his / her / its
    account", and rapid clicks can place multiple orders. The company "can refuse access ... or
    terminate access for an existing user without providing reasons".

  The **Signals API** is AlgoTest's documented route (official SDK `Algo-Test/algotest-api-trading`:
  login, contracts, a strategy payload with legs, lots, SL / target, then a start call). AlgoTest's
  blog gives 1,299 credits for 28 days or 4,999 for 168 days, and elsewhere 999 with unlimited live
  trades and forward tests; the current price is to be confirmed. Ranked by risk under the terms:
  Signals API (sanctioned), then the website through Playwright (acts as the user), then internal
  HTTP (reverse-engineering clause). Next: ask AlgoTest support in writing whether automating
  deploys of one's own saved strategies is allowed, and the current Signals price.
- 2026-10-19 — the owner emailed AlgoTest support (automation allowed? Signals price and payload). The route is chosen on the reply.
- 2026-10-19 — AlgoTest support, by phone to the owner: automating his own account this way is fine. Verbal, not in writing; which route (website or internal requests) it covers is being confirmed with the owner.
- 2026-10-19 — Phase 1, first look (no activation): Forward Test is `/forward-test`. Its "Activation" table
  lists every saved strategy with Status ("Setup Pending"), Instances ("0 Deployed") and Execution On
  (M T W Th F Sa Su); a row offers "Select Setup" and "Activate". The page header shows "No Slots Available",
  "Manage Plan", "Auto Activation" and "Auto restart paused executions". **An activation repeats on the
  chosen weekdays until stopped, not once**: a dropped pick must be deactivated, not merely left out.
  Activating needs a slot, i.e. credits (197 on the account); stopped there for the owner's go.
- 2026-10-19 — the owner deploys on **`/live`** (Algo Trade), not Forward Test. `/live` has the same
  Activation table; a selected row offers "Setup Execution" and "Activate". The header shows "0/6 Strategy
  Deployed" (the plan's live limit, exactly 3 Core + 3 T1, so a Buy add-on day needs a slot freed first) and
  "Broker Login 0/0". Forward Test has no slots, so Phase 3's paper run becomes a **dry run on `/live`**: the
  deployer does everything up to Setup Execution, records what it would set, and never clicks Activate, while
  the owner deploys by hand, for 10 days. Claude's own clicks on `/live` controls are refused by the session's
  safety check (a real-money action), so the Setup Execution dialog is recorded by the owner (screenshot, or
  the `record-strategies` script).
- 2026-10-19 — AlgoTest refuses deploys outside 08:00–15:40 IST (the owner's recorder run at about 02:30
  showed it). Phase 2: deactivate everything at 15:30–15:39 each day and activate only the recorded picks
  after 09:16; the Setup Execution dialog is recorded after 08:00.
- 2026-10-19 — **Dropped by the owner**: "stop deploying, do all other things as discussed". Deploying stays the owner's click in AlgoTest's `/live`; BL-137 (export, evening delete-and-upload, 09:16 top-up) continues. The findings above (the `/live` table, the 6-strategy limit, the 08:00–15:40 window, activations repeating on weekdays) are kept for a revival.
- 2026-10-19 — **Reopened by the owner** the same night: build the deploy function so it is ready, off by default; it may never be used. The Setup Execution discovery happens at 08:06 (the owner clicks it on /live; Claude reads the screen and records the fields).
- 2026-10-19 09:18 — first live deploy seen (the owner deployed `T1 · N_p150-t1s11_0917` by hand), read from
  /live without clicking:
  - **Deployed Strategies** card: "Deployed on 19 OCT 26 · Intraday · <name> · NIFTY · Open Pos: 2 · RUNNING ·
    ₹ 81.25 · Finvasia - Shiny" with "Switch to manual", "Square Off", "View Trades"; the section header has
    "Switch all to manual" and "Square off all".
  - **Activation** row after setup: status "Ready to deploy", "1 Deployed", the button "Edit Execution" in place
    of "Setup Execution", and the weekday columns still "-": the owner's deploy did **not** set repeating
    days. So an activation can be for the day only, which corrects the earlier reading that activations always
    repeat. The 15:30 deactivate-all stays as a safety net.
  - The Setup Execution dialog itself is still to be read (the owner will pause on it for the 09:47 deploy).
  - The 09:16 T1 entry matched the evening preview exactly (3 of 3), so the morning top-up had nothing to add.
- 2026-10-19 ~09:30 — Setup Execution sheet read (owner opened it on `Nifty_Widesl_917_OTM1`, then cancelled):
  fields in `docs/algotest-execution.md` §7 (multiplier 1, NRML legs, MIS needs exit before 15:24, Candle Close
  monitoring, limit orders watched 50 s, no execution day ticked by default). Deployer built:
  `src/deploy-plan.ts` (pure: 08:00–15:40 window, at least one broker logged in, strategy limit, entry still
  ahead, only `T1 · ` / `Core · ` names; parses /live's text; 8 tests on the page captured at 09:18) and
  `src/strategy-deploy.ts` (checks the sheet's defaults rather than changing them, "Setup Execution Settings",
  then "Activate"; stops at any pop-up it has not seen; a ledger `deploy-ledger.jsonl`; one Telegram message).
  Because a deploy with no day ticked runs that day only, the 15:30 deactivate-all became a 15:35 check that no
  tool strategy has a day ticked. Jobs `algotest-deploy` (09:16, waits up to 120 s for the entry, no retries)
  and `algotest-deploy-check` (15:35) registered, both doing nothing until `ALGOTEST_DEPLOY=on`. Not run against
  AlgoTest; the first `--apply` must be watched by the owner.
- 2026-10-19 — code review fixes: the sheet's default checks (multiplier, NRML, no day ticked) read only inside the
  "Edit execution for" sheet, not the whole page (page toggles like "Auto restart paused executions" no longer
  count); `parseLive` accepts rows without the ticker line; the entry time is checked again, to the second, just
  before each Activate (at least 30 s left, else TOO LATE); locators in `src/selectors.ts` (`livePage`).
