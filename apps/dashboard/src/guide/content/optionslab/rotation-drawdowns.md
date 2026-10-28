## What it is for

A list's maximum drawdown is one number for its worst fall. It does not say how many times the
list fell, how long each fall took to come back, what the fixed base did on the same days, or what
the list was holding. This card lists every fall of a size you choose, so a bad stretch can be told
apart from a bad day, and so a fall that is still open is visible while it is open.

It describes. It never changes a list, a weight or the journal.

## The chart

Underwater: how far below its running peak the list was at the end of each scored session, in
rupees per lot. The peak starts at zero, as in the read-out. The dashed line is the fixed base on
the same days, drawn from its own peak of zero; it breaks where the base has no result. Shaded and
numbered stretches are the falls of at least the chosen size.

With a **portfolio stop** applied (the Adaptive Classic row's stop button, ₹8,000 by default), the
same days are also replayed through it, at 1 lot a strategy, and drawn as a second line. Three figures sit above the chart: the worst fall
without the stop, the worst fall with it, and on how many days the stop closed the book. The
episode table and the drivers stay on the registered figures; only the chart, those three figures
and the reading line below it show the stopped series.

## The controls

| Control | What it does |
|---|---|
| Window | **P1** and **P2** are the research periods, re-scored. **Last 63** is the latest 63 scored sessions, recorded and re-scored together. **Forward** is only the on-time recorded entries. |
| Smallest fall | A fall counts as an episode when it reached at least this many rupees per lot below the peak. The default is ₹500. Smaller ones are counted and said, not hidden silently. |
| List | Adaptive, the list the page shows. |

## The episodes

| Column | What it is |
|---|---|
| Peak | The last day the list was at its running peak before the fall. "start" means it began the window underwater. |
| Trough | The deepest day of the fall. |
| Back | The first day the list was back at the peak, or **open** when it never got back. |
| Depth / lot, Basket | The fall at the trough, per lot and for the page's lots (1 a strategy). |
| Length | Sessions from the peak to the trough, and from the trough to the way back. |
| Base, same days | The fixed base's per-lot P&L over the same peak-to-trough days. A day the base has no result for is counted, not treated as zero. |
| Stops | Strategies stopped out on those days. |

Choose a row to see **what drove** that fall: its loss split by family and start band, per lot.
The bars add up to the episode's depth.

> [!NOTE]
> The drivers describe what was held. They are not a cause: the same picks also made money on other
> days. Read them as "this is what the list was in during the fall".

## Things to know

- **Per lot-day.** The page counts 1 lot a strategy (3 lots a day, or 4 with the Buy add-on; the journal
  records 2), so the Basket column is in those lots. Rupee totals would still reward holding more, so per
  lot is the unit the lists and the base are compared in.
- **Recorded and re-scored are counted apart.** Days before the journal began are what the rule
  would have picked, scored with the same code as the 09:16 job. The weights were chosen on that
  history, so those falls are a description, not a test.
- **A day that is late, waiting for results, or has no entry is left out** of the series and counted
  in the line above the chart. It neither extends nor ends a fall.
- **A stopped series is a replay.** It is re-simulated from the strategy files at the minute
  close, over the same history the weights were chosen on, so it describes what a stop would have
  done to these falls. A day that cannot be replayed keeps its registered figure and is counted.
- **Gross.** The stored costs are zero today.
