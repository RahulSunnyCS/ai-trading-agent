## What it is for

**Commodity Lab** is the workbench for options on MCX commodities: the gold, silver, crude oil and natural gas **mini** contracts. It is a research area like Options Lab. It places no orders, and the only experiments running in it are paper tests.

> [!NOTE]
> The Lab is new and small on purpose: four screens that report what the earlier research found and what is running now. What to build on top of them (a builder, a heatmap, a live board) is the owner's call.

## The four screens

| Screen | What it answers |
|---|---|
| [Overview](app:/commoditylab/overview) | What is on the desk today: each mini's next expiry, whether its data is up to date, and the headline of each forward test. |
| [Forward tests](app:/commoditylab/forward) | Are the two paper tests earning: gold Dir in its expiry week, and silver Dir in the week before expiry? [Guide](guide:commodity/forward-tests) |
| [Sweep verdict](app:/commoditylab/sweep) | Which commodity strategies worked in the two-year sweep, and which did not. [Guide](guide:commodity/sweep-verdict) |
| [Contracts & data](app:/commoditylab/data) | The option bars collected so far, and the expiry calendar. |

## Reading the Overview

- **The four cards** are Gold mini (GOLDM), Silver mini (SILVERM), Crude oil mini (CRUDEOILM) and Natural gas mini (NATGASMINI). Each shows the next option expiry and how many weekdays away it is, the day the collector last stored, how many days are held, and the future the option settles on (the future is the "spot" the engine uses, because commodities have no index).
- **Collected** means the last stored day is today's or the previous weekday's. **Weekdays behind** means the nightly collection missed one or more sessions. Expired contracts cannot be fetched later, so a missed night is a permanent hole.
- **Only gold's calendar is kept current.** The forward test extends it. For the other three the card says where its calendar ends (October 2026) instead of guessing a next expiry.

## Contracts & data

The first table lists, per root, the first and last collected day, the days held and the days in the last 30 calendar days. The second lists each root's next expiry, the future it settles on and the expiries after it.

## Numbers and units

One point of the option price is worth ₹10 on a gold or crude lot, ₹5 on silver and ₹250 on natural gas. The MCX session runs 09:00 to 23:30 or 23:55 depending on US daylight saving, so the evening is a trading session here, not after hours.
