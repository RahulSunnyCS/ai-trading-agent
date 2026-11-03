# BL-142 — Momentum on Zerodha Kite: weekly lots, read from Kite each Friday, each rebalanced on its own calendar

| | |
|---|---|
| **Priority** | P0 — real money is already in (first ₹50k bought Mon 2026-10-19); the month's goal is Momentum the owner trusts with money (`overview.md`) |
| **Status** | Done |
| **Type** | feature |
| **Area** | momentum / broker / dashboard / scheduler |
| **Created** | 2026-10-19 |
| **Depends on** | BL-051 Phase 3 (holdings snapshots, holding rules, orders engine, the Fri 14:15 `momentum-orders` job), BL-087 (sleeves, one per Friday) |
| **TODO.md row** | 3.34 |

## Context

The owner (2026-10-19) moves the Momentum money from Fyers to **Zerodha Kite**, for Kite's zero
delivery brokerage. The plan for the money:

- About **₹50k a week into the chosen strategy, up to ₹2 lakh** (four weeks). Then hold and
  watch for 2–4 months before adding more. The first ₹50k was bought on Mon 2026-10-19 (signal
  Fri 2026-10-16, the paper start in `data/paper_start.json`).
- The owner **buys on Mondays**, from the Friday signal.
- **Each week's buy is a lot, rebalanced on its own calendar.** On a strategy that rebalances
  every K weeks, the names bought K weeks back are the ones rebalanced this Friday, and **free
  cash in Kite can go into that rebalance**. K = 2 rebalances every 2 weeks; K = 4 every 4.
- **LIQUIDBEES and sovereign gold bonds stay in Kite as options margin.** They are never part
  of the strategy. Everything else in the Kite account belongs to the strategy.
- **Which strategy is not decided.** The owner picks it once this is built, so nothing here may
  assume a cadence or a favourite.

**What Kite can and cannot give** (to check against the docs in Phase 1):
- Kite Connect returns **today's** orders and trades only. Past trades are only in Console's
  tradebook (download by hand, no API).
- Holdings give quantity, T1 quantity and average price per symbol, **not** when each was bought,
  and one combined line when two lots hold the same stock.
- So the lots must be **built by us**: a Kite holdings snapshot every Friday, and the change since
  the previous Friday becomes that week's trades.
- The access token lasts until about 06:00 IST the next day, like Fyers. The login is Kite's own
  page (user ID, password, TOTP), then an API-secret exchange. It is always done by hand: Zerodha
  does not allow automating it (decided 2026-10-19, see Open questions). The Kite Connect Personal plan (orders, holdings, margins; no market data)
  should be enough; confirm at signup.

**What already exists (reuse, do not rebuild):**
- `momentum_holdings` snapshots carry a `source` column: add `kite` beside `fyers` / `paper`.
- `momentum_holding_rules` with treatment `exclude`: LIQUIDBEES and each SGB get it.
- `orders.plan()`: holdings in shares → orders, whole shares, minimum trade, costs.
- The Fri 14:15 `momentum-orders` job and its Telegram summary.
- BL-087's sleeves (one per calendar phase).

**What changes from today.** For a favourite group, the Rebalance preview and Your orders today
blend every sleeve's target into one account against all holdings (`api.py`, group preview).
The owner's way is per lot: only the due lot's names are touched, sized on that lot's value
plus free cash.

### The design in brief

- **A lot's calendar.** A lot takes its signal Friday's phase: (weeks since the paper start)
  mod K. With K = 2 and four weekly lots, lots 1 and 3 share a calendar, and so do 2 and 4. On
  their first shared rebalance they get the same target, so from then on lots on one calendar
  are **one sleeve**. The sleeves are BL-087's with unequal capital, built from real buys.
- **Attribution rule.** Every change in Kite holdings between two Friday snapshots belongs to the
  lot bought that week (ramp-up), or to the sleeve that was due that week. That holds as long as
  the owner trades only what the Friday orders said. A change on a name that week's orders did
  not mention (a split, a bonus, a hand trade) is not guessed: it is flagged and the owner
  says which sleeve it belongs to.
- **The due sleeve's rebalance.** Value = its shares at live prices + Kite's free equity cash
  (+ the week's new money during the ramp) → `orders.plan()` to the strategy's current target.
  Excluded symbols never appear.

## Goal

- Every Friday, a Kite holdings snapshot is stored (source `kite`), with LIQUIDBEES and SGBs left out.
- A lot ledger shows each sleeve's names, shares and cost, and it adds up to Kite's holdings
  minus the excluded symbols, to the share.
- The Friday orders job tells the owner which sleeve is due and gives its orders (sells, trims,
  buys), sized on that sleeve plus free cash. It works for any followed strategy and any K.
- The owner gets a Telegram reminder whenever the Kite login is needed and missing.

## Out of scope

- Placing orders on Kite. This repo places none (`business.md`); Kite access is read-only
  (holdings, margins, today's trades).
- Market data from Kite: prices stay Fyers / the existing sources.
- Choosing the strategy (the owner's call; BL-030 is the research side).
- Tax-lot (FIFO) accounting for capital-gains tax; the ledger is per sleeve, not per purchase.

## Plan

### Phase 1 — Kite access, read-only
- **Tasks:**
  - Kite Connect app (the owner creates it); `.env` keys `KITE_API_KEY` and `KITE_API_SECRET`
    only (the owner adds them). No password or TOTP secret is stored: the login is manual.
  - ~~Spike: can the login run unattended?~~ Dropped 2026-10-19: Zerodha does not allow
    automating the login (exchange regulations), so it is not tried.
  - A Kite **Login** button on Broker logins (an OAuth callback like Fyers'), and a **Friday
    13:30 Telegram reminder** when no valid Kite token exists. The 14:15 job then alerts if it
    still cannot read Kite.
  - `kite.holdings()` (holdings + T1 quantity + today's CNC positions) and `kite.margins()` (free
    equity cash), read-only; store the snapshot with source `kite`; `holdings_source = kite`.
  - Exclude rules for LIQUIDBEES and every SGB symbol, preferably a pattern (`SGB*`) so a new
    tranche needs no hand rule.
- **Deliverables:** Kite client + tests on recorded responses; the Login button;
  reminder job; snapshot stored on the real account.
- **Done when:** on Fri 2026-10-23 a Kite snapshot is stored for the owner's account, it holds
  this week's buy, and LIQUIDBEES and SGBs are not in it.

### Phase 2 — The lot ledger
- **Tasks:**
  - Migration in `trading-data`: lots (owner, favourite, lot id, signal Friday, buy week, phase,
    money in) and sleeve positions (owner, sleeve, symbol, shares, cost, as of).
  - The first Kite snapshot after the paper start seeds lot 1 (signal 2026-10-16, bought
    2026-10-19). Each later Friday's diff goes to that week's lot or due sleeve (the
    attribution rule above). Unexplained changes are flagged, and the owner assigns them.
  - Lots on one calendar merge into one sleeve at their first shared rebalance.
  - `mbt lots show` and `mbt lots assign <symbol> <sleeve>`; a check that the ledger equals Kite
    minus the excluded symbols.
- **Deliverables:** migration, ledger code + tests (ramp-up, shared stock across sleeves, a
  sale of a shared stock, a split, a hand trade), CLI.
- **Done when:** after the four ramp-up Fridays the ledger has four lots, and it matches Kite to
  the share.

### Phase 3 — Per-sleeve orders on Friday
- **Tasks:**
  - The followed strategy is an owner setting, any favourite or group, any K. Each Friday's
    due sleeve(s) come from it.
  - Orders for the due sleeve only: its shares + free Kite cash (+ the week's new money during
    the ramp) to the current target. When two sleeves are due together, split the cash by their
    value. The 14:15 job stores and Telegrams them: "Due: sleeve 1 of 2 · ₹X held + ₹Y cash ·
    sell …, buy …".
  - A Friday with no due sleeve and no new money sends "nothing due, next due Fri DD Mon".
- **Deliverables:** orders path + tests against hand-worked examples for K = 1, 2, 4; job
  change; Telegram text.
- **Done when:** on the first due Friday the orders match a hand check of the sleeve's holdings,
  the free cash and the strategy's target.

### Phase 4 — Dashboard, Guide and project files
- **Tasks:** a Lots panel on Momentum › This week (each sleeve: names, value, last and next
  rebalance, which is due); Your orders shows the due sleeve's orders with Kite as the source;
  the Guide page for both; `business.md` (Kite read-only holdings and margins, no orders);
  `technical.md` (the `KITE_*` env vars, `mbt lots`).
- **Done when:** the panel shows the same numbers as `mbt lots show` and the Friday Telegram.

## Risks

- **The owner's Monday trades differ from Friday's orders** (a price moved, a name skipped). The
  attribution rule still holds while only the due sleeve trades. A hand trade outside it is
  flagged, never guessed.
- **Corporate actions** change quantity with no trade. The flag catches them. The existing
  split classifier (`blocked` in `orders.plan`) holds such a name until it is classified.
- **A missed Friday login** means no Kite read at 14:15. The 13:30 reminder and the 14:15 alert
  cover it; a login any time from 06:00 that Friday is enough.
- **Free cash meant for something else** would be swept into a rebalance. The cash used is
  shown in every order message and can be capped in settings.
- **T+1:** a Thursday buy shows as T1 quantity, not holdings. The snapshot must count both.

## Open questions

Answered by the owner on 2026-10-19 (the item was started):

1. **Strategy and K:** **Four Sectors Monthly, No Tilt · all Fridays** (owner, 2026-10-20): K = 4,
   so its four sleeves (Friday 1 to 4 of 4) are the owner's four weekly ₹50k lots, one sleeve
   per lot, no pairing logic. Nothing in the build may assume K = 4 (the choice can change).
2. **Kite login:** a Login button and a Friday 13:30 reminder. **Reversed 2026-10-28 (owner):
   automated** on Fridays and trading Mondays inside the 08:02 morning login (`mbt kite
   auto-login`, off until `KITE_AUTO_LOGIN=on`; TODO 3.34.5), with the reminders kept as the
   fallback. The owner accepts the risk below. Was: **manual only (owner, 2026-10-19):** the
   planned test of an unattended TOTP login is dropped. A Zerodha
   representative states on the Kite developer forum that automating the login is not allowed
   under exchange regulations (https://kite.trade/forum/discussion/comment/19966/), and it would
   mean keeping the Kite password and TOTP secret in `.env`. The account ID Kite returns at login
   is kept with the day's token and shown on the card; it is not used to log in.
3. **Free cash:** all of Kite's free equity cash goes to the due sleeve. The amount is the
   margins endpoint's `net` minus `available.collateral`, never below 0: the margin pledged
   holdings give is not cash (the PR #270 review). LIQUIDBEES and SGBs are untouched, so options margin stays. Every message shows the
   cash used.
4. **After ₹2 lakh:** new money is just free cash for the next due sleeve. No new lots after
   the ramp.
5. **Exclusions:** LIQUIDBEES and every symbol starting with `SGB` are excluded automatically.
   Others can still be added with the existing exclude rule.

Kite facts checked on 2026-10-19 ([portfolio](https://kite.trade/docs/connect/v3/portfolio/),
[user](https://kite.trade/docs/connect/v3/user/)):
- Holdings give `quantity` (T+2), `t1_quantity`, `average_price` and `isin`, with no dates.
- The access token ends at 06:00 the next day.
- Login is `kite.zerodha.com/connect/login?v=3&api_key=…` → `request_token` on the registered
  redirect URL → `POST /session/token` with `sha256(api_key + request_token + api_secret)`.
- The free Personal plan (since March 2025) covers holdings and funds, not market data.

## Log

- 2026-10-19 — created from the owner's request. Answers given at creation: lots are rebalanced
  on the strategy's cadence (K weeks after their buy) and may use free Kite cash; Kite
  credentials go in `.env`, and the login is automated if possible, otherwise a Friday
  notification and a manual login; the owner buys on Mondays; the strategy is chosen once this is built.
- 2026-10-19 — started; the owner answered the open questions (recorded above). Phase 1 begun.
- 2026-10-19 — Phase 1 built (not yet run against the real account). Kite client `kite.py` (read-only:
  session, holdings + T1, equity margins `net`, profile), token cached 0600, 06:00 IST expiry;
  Momentum API `/api/kite/status | login | start | callback`. The redirect URL given to the owner
  for the Kite app is `http://127.0.0.1:8765/api/kite/callback`. Other pieces:
  - trading-data migration 013: `kite` as a snapshot and holdings source, `momentum_cash`; the
    holdings key gains `source`.
  - `holdings_sync.sync`, shared by the orders job, `mbt kite sync`, the callback and the page's
    Sync button.
  - LIQUIDBEES and `SGB*` excluded by default (`holdings_store.treatment`, an owner rule still wins).
  - Your orders counts a Kite snapshot's free cash and reads only its own source's snapshots.
    The tests found that two sources syncing in the same second mixed their rows; now fixed.
  - `mbt kite status | login | sync | remind`; scheduler job `kite-login-reminder`, Fri 13:30.
  - Broker logins Kite card, the Kite option in Your orders settings, Guide pages, docs.

  Still open in Phase 1:
  - switching the owner's holdings source to `kite`;
  - the first real snapshot, due Fri 2026-10-23.
- 2026-10-19 — The owner chose to drop the unattended Kite login: Zerodha does not allow
  automating it. The Login button and the Friday 13:30 reminder stay, and no Kite password or
  TOTP secret goes in `.env`. Review fixes on PR #270:
  - free cash leaves out pledged collateral;
  - LIQUIDBEES / `SGB*` are always excluded;
  - Kite timeouts are handled;
  - the callback never fails after a good login.
- 2026-10-20 — First live read. The owner logged in on Broker logins (account ID shown on the card)
  and the callback stored a Kite snapshot at 12:25: five names, all still T1 (bought Mon 19 Oct,
  so `quantity` 0 and `t1_quantity` counted, as the client does), free cash ₹4,509 with no pledged
  collateral. Kite lists the five on **BSE** (20MICRONS, CUPID, GRWRHITECH, NAZARA, RATEGAIN):
  Your orders maps holdings by symbol, so check on Fri 23 Oct that each maps to its strategy
  name (an unmapped one is left alone and its target name would be bought again). This account
  holds no LIQUIDBEES or SGB, so the options-margin exclusion was not exercised. The first
  restart of the research stack lost a login in progress (login states are in memory).
- 2026-10-20 — Strategy chosen: Four Sectors Monthly, No Tilt · all Fridays (K = 4, four sleeves = the
  four weekly lots). The owner says Monday's first ₹50k (the five names bought 19 Oct) is from this
  strategy. Its status was set to Invested (still the headline) and Trio Fortnightly to Watching.
  Still to check on Fri 23 Oct: that the five BSE-listed holdings map to this strategy's names.
- 2026-10-21 — Phases 2 and 3 built (before the first lot-by-lot Friday, 23 Oct). Design as built:
  - a lot is a sleeve of the group, keyed by the saved-run id (the page's "Friday n of 4" is
    renumbered from the paper start, so the engine's "Friday 4 of 4" is Lot 1, decided 16 Oct,
    next due 13 Nov);
  - the ledger books changes to the pending lot (the lot due on the last Friday the orders ran) and
    refuses to guess: a purchase the lot cannot hold is *unexplained* until `mbt lots assign`;
  - a new lot is funded with `lot_size_rs` (₹50,000) or all free cash when that is more, and the
    message says what to add to Kite; a rebalancing lot gets its shares plus the free cash;
  - **a lot that is not due never sells a difference from the model.** The first rehearsal (on a
    copy of the live catalog) told the owner to sell the 1 GRWRHITECH in lot 1, because lot 1's
    model target still held Nasdaq 100 and GRWRHITECH is the owner's swap for it. It now sells only
    what the sleeve marks SELL. The swap is otherwise sold at the lot's next rebalance like any
    holding the new target lacks (13 Nov for lot 1);
  - the premium rule for Broad atomics (BL-136 Phase 1b) is not built: lots whose model holds a
    blocked Nasdaq 100 still need the owner's swap by hand (the fallback is that week's rank-5
    name; only five candidates exist for this strategy).
  Rehearsal (a copy of the live catalog, Friday 23 Oct pinned, live prices): lot 1 not due, Lot 2
  new ₹50,000: ACMESOLAR 30, CUPID 37, GRWRHITECH 1, NAZARA 30, add ₹45,491 to Kite.
- 2026-10-21 — Review fixes on PR #278 (Opus review: two high, three medium):
  - the ledger books a change against what each lot was *told to trade* (stored with the pending
    lot), so a forced exit in a lot that is not due is not booked to the due lot, and the one net
    order a stock gets (lot 2 buys 73 while lot 1 sells 20: BUY 53) books every lot as planned;
  - Kite symbols that are not strategy names today are never booked as sold (a name can drop out
    of the strategy's data for a day), and assigning a stock outside the strategy no longer gets
    undone by the next run;
  - the pending lot and the plan move only on a run on the Friday with a snapshot read that day,
    and a run on an old snapshot says Kite was not read;
  - a lot is *new* only if it never held a share: one that sold out is rebalanced (no deposit
    after the ramp);
  - the message states the free cash the plan used, and lists what was booked since the last run.
- 2026-10-28 — Phase 4 built and the item closed (Done). Built:
  - **Lots panel** on Momentum › This week (`LotsPanel.tsx`, `lib/momentumLots.ts`), above Your
    orders and left out when the headline is not followed lot by lot. One row per lot: the shares
    booked to it, their value at the last stored close (never a quote), its last and next
    rebalance, *Due* for this Friday's lot, *last orders were for it* on the pending lot, and the
    last Friday orders' line for it. Under it, **Kite minus the lots** beside what those orders told
    each lot to buy, with any difference marked.
  - `GET /api/lots` (`api.lots_view`, proxied at `/api/momentum/lots`): built on `lots_status`, so
    it is the same ledger as `mbt lots show`. Read-only: every catalog open is read-only, no Kite
    read, no quote, no booking (`tests/test_lot_orders.py` compares every table and state file
    before and after, and refuses a sync or a quote).
  - Your orders already showed the due lot's orders with Kite as the source (Phase 3); its status
    words now come from the same place as the panel's.
  - Guide (`momentum/this-week.md`, a *Your lots* section), `business.md` (Kite: holdings and
    margins, never an order), `technical.md` (`/api/lots`; the `KITE_*` variables and `mbt lots`
    were already there).
  Checked on the live ledger (the worktree's `mbt serve` and dashboard on spare ports, the
  owner's :8765 / :5190 untouched): every lot's shares and the Kite-minus-the-lots rows are the
  same as `mbt lots show`, the per-lot lines are the 23 Oct 14:25 Telegram's, Lot 3 is due Fri
  30 Oct, and the page load made GET requests only (the ledger, the pending lot and the Kite
  snapshot were unchanged afterwards). One stock in Kite differs by a share from what the orders
  said; the 30 Oct run books it under the attribution rule.
  Not built, recorded here instead of a new item:
  - **Dropped:** a separate "nothing due, next due Fri DD Mon" message. With one lot per Friday a
    lot is always due, and when none is, the message's per-lot lines already say *not due · next …*.
  - **Deferred:** a cap on the free cash a rebalance may use (Risks). Every message and the panel
    show the cash used; add the setting if cash kept on Kite for something else is ever swept in.
  - **Deferred to BL-136 Phase 1b:** the premium rule for Broad atomics (lots whose model holds
    Nasdaq 100 still need the owner's swap by hand).
  - **Not yet verifiable:** Phase 2's "four lots matching Kite to the share" and Phase 3's "first
    due Friday" hand check of a rebalancing lot. The ramp-up runs to Fri 6 Nov and Lot 1's first
    rebalance is Fri 13 Nov; the panel and `mbt lots show` are where to check them.
- 2026-10-28 — The owner reversed open question 2: Kite now logs in by itself on Fridays and
  trading Mondays, in the 08:02 morning login, its result in the same 08:10 message
  (`kite_login.py`, `mbt kite auto-login`; `local-login.ts` starts it). Told first that Zerodha
  says automating the login is not allowed and that it puts the Kite account (the Momentum money)
  at risk; chose it anyway. Built to log in only as a person would on Kite's own page: no
  undocumented endpoints, nothing that hides the scripted browser, a stop at any captcha, no retry
  of a refused password and a hold until the credentials change. Off until `KITE_AUTO_LOGIN=on`;
  needs `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET` in `.env`. Not yet run against Kite.
