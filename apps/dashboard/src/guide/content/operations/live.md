## What it is for

**Live** shows one index, NIFTY or SENSEX, minute by minute: the spot price, India VIX, the at-the-money (ATM) strike and two straddles. It is the place to watch what the options market is doing on a day, and to replay a past day to see how it unfolded.

> [!NOTE]
> **There is no live feed yet.** The page currently replays a day the evening run has already collected, and says so at the top ("Replay of Fri 16 Oct 2026"). Live capture is planned. When it exists, the same page shows the day so far and the Replay badge becomes Live. Nothing on this page places an order.

## The two straddles

Both are a call plus a put on the nearest weekly expiry, added up from each minute's closing prices.

- **Rolling ATM straddle**: uses the ATM strike of each minute's spot, so it moves to a new strike as the index moves. It shows how expensive a straddle is *right now*.
- **09:15 straddle, held**: uses the strike that was ATM at the 09:15 open and keeps it all day. This is what someone who sold the morning straddle is still holding. Its change since 09:15 is the closest thing on this page to how that trade is doing.

The change shown under each figure is against the straddle at the 09:15 open. It is not coloured green or red: spot, VIX and a straddle moving up or down is not your profit or loss.

## Reading the page

- **Headline strip**: spot and VIX with their change since 09:15, the ATM strike with the expiry and how many weekdays away it is, and the two straddles. The straddle note also gives it as a percent of spot, which is roughly the move the market is pricing in until expiry.
- **Charts**: spot, the two straddles, and VIX, all on the same time axis from 09:15 to 15:30 IST. While a day is part-way through its replay the axis still runs to the close, so you can see how far along it is.
- **A gap in a line** means there was no bar for that minute: the leg had not traded yet, did not trade in that minute, or that strike was not collected (the same holds for spot and VIX). The page never fills it with an earlier price, so a held strike that stops trading shows a gap, not its last price.
- **The legs at this minute**: strike, call, put and their sum for each straddle, at the minute you are viewing.
- **Range so far** is the high minus the low since the open, compared with the median full-session range of the last 20 sessions. It is a description of the day, not a signal.

## Replay

- Pick the **day** from the list (the last 60 collected sessions).
- **Play** runs the day forward; the speed (1×, 10×, 60×) is minutes of the day per real second. Drag the slider to jump to any minute; it pauses the replay.
- The page opens a day at its end, so the whole session is drawn.
- The index and day are in the address (`?ix=SENSEX&d=2026-10-16`), so a copied link shows the same session.

> [!TIP]
> Replaying a day from the day log or Today page tells you what the strategies did that day; this page shows the market they did it in.

## Limits

- Prices are 1-minute bars, the same data the backtests use. A real fill happens on a tick inside that minute; how far real fills differ is something a planned paper desk is meant to measure.
- Only the nearest weekly expiry is shown, and only strikes the evening collector fetched.
