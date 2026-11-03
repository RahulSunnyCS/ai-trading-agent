# BL-203 — Rotation live board: today's picks on Angel One's prices, every 5 minutes

| | |
|---|---|
| **Priority** | P1 — real money trades T1 every day and there is no way to see how the picks stand before the 16:00 message |
| **Status** | In progress |
| **Type** | feature |
| **Area** | options / dashboard / scheduler |
| **Created** | 2026-11-03 |
| **Depends on** | BL-058 (journal), BL-113 (T1 track), BL-079 (Angel One client and login guard), BL-183 / BL-140 (lots per account) |
| **TODO.md row** | 3.10.57 |

## Context

On Tue 3 Nov the owner asked mid-session how Core and T1 Adaptive stood "as per backtest", not as
AlgoTest shows them. The paper result only exists after the 15:45 evening run. A one-off answer was
worked out by collecting the day from Fyers into a scratch data root and running the four picked
strategies there. The owner then asked to build it as a live view ("update every 5 min and update
clicking on button"), with Angel One as the source ("lets do it with angelone").

## Goal

The Rotation page (Options Lab › Today) shows a Live board above Today's baskets: both Adaptive
books' picks run through the backtest engine on Angel One's 1-minute bars so far, every pick's
state (waiting, open, closed), each leg's entry and its exit or current price, and each book's
total. It is refreshed every 5 minutes on trading days from 09:18 to 15:31 and on a Refresh
button.

## Owner's answers (2026-11-03)

1. **Placement:** Rotation › Today, above Today's baskets.
2. **Lots:** both views with a switch: a lot each (the 16:00 message's basis) and your lots (each
   Settings › Automation account's list, multiplier, Dir ×2 and add-on).
3. **Telegram:** none. The trade monitor already alerts on the real MTM.
4. **Source:** Angel One, not AlgoTest's figures.

## Out of scope

- Writing anything to the lake or the catalog: the evening collection stays the record.
- Any order, alert or message.
- The platform's book stop (Core ₹8k / T1 ₹9k): the evening result does not model it either.

## Plan

### Phase 1 — Board, loop, button
- **Tasks:** `rotation/live_board.py` (bars to `DayData`, `simulate_day` per pick, open legs
  marked at the last complete bar, a 0.5% slippage copy, lots per account); the Angel client's
  light `bars()` call (no OI); `check.held()` (the guard's lock without a login); `obt rotation
  live-board run | refresh | show`; `GET /legwise/rotation/live-board` and `POST …/refresh`
  (+ Fastify proxy); scheduler job `rotation-live-board` 09:18; the dashboard card, its guide
  page and the Jobs guide row.
- **Deliverables:** merged PR.
- **Done when:** a full trading day runs on the loop with one Angel One login, the card refreshes
  every 5 minutes and on the button, and the board's last figures match the evening result for
  both books (to the rupee when the Angel One and Fyers bars agree).

## Risks

- **Angel One's rate limit is erratic.** SmartAPI refuses getCandleData with HTTP 403 "exceeding
  access rate" well below its published limits (forum reports; seen here on 2026-11-03 after about
  140 calls in 90 s, then on the first call a few minutes later). Mitigations: a pick's strike band
  (about 25 strikes × 2) is read once, at the first refresh after its entry; later refreshes read
  only its own contracts (about 15 calls). A throttled index or held contract drops the refresh and
  keeps the last snapshot; a partly read band leaves the pick unfixed so the next refresh reads it
  again.
- **Angel One's intraday candles may run a few minutes behind.** On 2026-11-03 two refreshes at
  15:15 and 15:18 both ended at the 15:14 bar. The card says "Prices to HH:MM".
- **Strike choice at the band's edge** could differ from the evening run's full chain: noted on
  the card.

## Log

- 2026-11-03 — created and started; owner's answers recorded. Phase 1 built: first live refresh at
  15:15 matched the earlier Fyers run (Classic +₹1,072, Tuned +₹3,182 a lot each before slippage);
  the second read 6 contracts in 24 calls.
