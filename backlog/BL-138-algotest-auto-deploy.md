# BL-138 — Deploy the rotation picks in AlgoTest automatically: paper first, live gated

| | |
|---|---|
| **Priority** | P1 — the owner trades the T1 picks with real money and asked for the deploy to be automatic (2026-10-19); a wrong or duplicate deploy costs money, so it is planned with its own gates |
| **Status** | Planned |
| **Type** | feature |
| **Area** | broker-login (AlgoTest automation), options (picks), infra (scheduler) |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 (export, upload, ledger, the AlgoTest discovery); BL-058 / BL-113 (the 09:16 journal) |
| **TODO.md row** | — (filled in when started) |

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
  - **Evening:** undeploy every tool strategy before BL-137's delete.
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

