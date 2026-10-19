# BL-142 — Momentum on Zerodha Kite: weekly lots, read from Kite each Friday, each rebalanced on its own calendar

| | |
|---|---|
| **Priority** | P0 — real money is already in (first ₹50k bought Mon 2026-10-19); the month's goal is Momentum the owner trusts with money (`overview.md`) |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum / broker / dashboard / scheduler |
| **Created** | 2026-10-19 |
| **Depends on** | BL-051 Phase 3 (holdings snapshots, holding rules, orders engine, the Fri 14:15 `momentum-orders` job), BL-087 (sleeves, one per Friday) |
| **TODO.md row** | — (filled in when started) |

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
  page (user ID, password, TOTP), then an API-secret exchange. Whether it can run unattended
  is Phase 1's spike. The Kite Connect Personal plan (orders, holdings, margins; no market data)
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
  - Kite Connect app (the owner creates it); `.env` keys `KITE_API_KEY`, `KITE_API_SECRET`,
    `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET` (the owner adds them).
  - Spike: can the login run unattended? Try the TOTP login the AlgoTest logins already do
    (`packages/broker-login`, `@trading/broker-identity`'s `generateTotp`). If Kite shows a human
    check, as Fyers' page does, drop it.
  - Fallback either way: a Kite **Login** button on Broker logins (an OAuth callback like
    Fyers'), and a **Friday 13:30 Telegram reminder** when no valid Kite token exists. The
    14:15 job then alerts if it still cannot read Kite.
  - `kite.holdings()` (holdings + T1 quantity + today's CNC positions) and `kite.margins()` (free
    equity cash), read-only; store the snapshot with source `kite`; `holdings_source = kite`.
  - Exclude rules for LIQUIDBEES and every SGB symbol, preferably a pattern (`SGB*`) so a new
    tranche needs no hand rule.
- **Deliverables:** Kite client + tests on recorded responses; login (automatic or button);
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
- **Automated Kite login** may break on a page change or fall outside Zerodha's terms. The
  button + reminder fallback works without it.
- **Free cash meant for something else** would be swept into a rebalance. The cash used is
  shown in every order message and can be capped in settings.
- **T+1:** a Thursday buy shows as T1 quantity, not holdings. The snapshot must count both.

## Open questions

Put to the owner when started:

1. Which strategy, and so which K? (Owner: decided once this is built.)
2. Is all free equity cash in Kite fair game for the due sleeve, or should a reserve stay?
3. After ₹2 lakh, does new money go to the due sleeve or to a new lot?
4. The full list of SGB / margin symbols to exclude, if a pattern is not enough.

## Log

- 2026-10-19 — created from the owner's request. Answers given at creation: lots are rebalanced
  on the strategy's cadence (K weeks after their buy) and may use free Kite cash; Kite
  credentials go in `.env`, and the login is automated if possible, otherwise a Friday
  notification and a manual login; the owner buys on Mondays; the strategy is chosen once this is built.
