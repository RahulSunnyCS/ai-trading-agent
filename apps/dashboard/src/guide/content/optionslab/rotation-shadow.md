## What it is for

Some ideas won on the last two years of data and lost on the two before. The rule for those is to
keep watching them on days nobody has seen, and to judge them against what they would have
replaced. This is where that happens. It shows the ideas kept for forward observation, each one
as a difference: the idea minus a comparator, in gross rupees. A profit with no comparator is
never shown, because an attractive trigger can look useful even when keeping the original pick
would have done better.

Nothing here changes a list, a weight or a pick. It only reads what the nightly jobs stored.

## The banner

One sentence: how many forward sessions have been scored, how many of them had a trigger event,
and the session count at which the ideas are judged (60). Beside it, whether the journal's chain
is intact, and how many late journal entries were left out.

A forward session is a trading day from 12 October 2026. Earlier days were inside the research and
are not counted here, even when the nightly job has scored them.

## Triggers against their placebo

Four triggers watch the index between 10:30 and 14:00. The first firing of each, per index per
day, is an event.

| Trigger | Fires when |
|---|---|
| T1, Pivot cross with trend | Spot crosses yesterday's pivot, R1 or S1 for the first time today, with the move since the open (in units of recent daily range) agreeing with the cross by at least 0.3. |
| T2, VIX turn | VIX is up 2% or more on the open and has fallen 1% or more in the last 30 minutes. |
| T3, Straddle turn, range stabilising | The morning ATM straddle was up 5% on its 10:00 value, is now 3% below that high, and the last half hour's range is below its usual. |
| T4, RSI exhaustion | The 5-minute RSI completes a block back below 70 or back above 30. |

For each trigger and each template (Widesl, Dir, Buy) the template is simulated from the minute
after the event. The placebo is the same template at the same minute on the 20 earlier days
with no event of that trigger. The table shows:

| Column | What it says |
|---|---|
| Event days | Days on which the trigger fired on either index, and were scored. Both indices on one day count once. |
| Event avg, Placebo avg | The template's mean result per lot on event days, and on the matching placebo days. |
| Difference | Event minus placebo, per lot, gross. This is the figure to read. |
| t | The difference over its day-to-day noise. Shown only from 5 event days; below that the row says n < 5 and shows none. |
| Research columns | The same difference found in the research, over the last two years and over 2022 to 2024. T3 is quoted by its bound, because it showed no edge in any template. |

Highlighted rows with the Candidate badge are Dir after T1 and Dir after T4, the two ideas the
override below follows.

## The override against the pick it displaces

The idea: when a pivot-cross or RSI-exhaustion event happens, fire a Dir right then, and let it
replace the next pick of the morning's list that has not started yet.

For each forward day with such an event the page takes the earliest one (either index), finds the
list's next core pick that starts at least 15 minutes later, and reports:

| Column | What it says |
|---|---|
| Event | Which trigger fired, on which index, at which minute the Dir would have entered. |
| Displaced pick | The pick the Dir replaces, with its start time. |
| Dir, Pick | One lot of each, gross, from the same exit time. |
| Difference | The Dir minus the displaced pick, per lot and on the list's lots (two per strategy). |
| Placebo Dir minus pick | The same Dir at the same minute on ordinary days, minus the same pick. |
| Status | Scored, Pending, Not applied, Late entry or No entry. |

An event is not applied when no core pick starts 15 minutes or more later, or when replacing the
pick would leave fewer than two Widesl strategies. A day whose displaced pick has no stored result
yet is pending: it is never a zero, and it is not on the chart. A late journal entry is not a
forward entry and is left out of every total.

The chart is the running total of the difference, with the placebo line dashed. The gap between
the two lines is what the trigger's timing adds. What is left above or below zero is "a Dir in
place of that pick on that day", which may have nothing to do with the trigger.

Switch lists with the control above: all four are shown, and B and REF are marked as candidates
because those were the two the research found above both of its controls.

> [!NOTE]
> The research also compared the override with a Dir entered at a random minute. That control is
> not recorded forward, so it is not shown. The placebo is a different comparator: the same
> minute, not a random one.

## What the research found

The same override in the research, for all four lists: the gain over the plain list, and the 90th
percentile of 200 random draws for each of its two controls. On the last two years, lists B and
REF beat both controls (+₹79,389 and +₹54,556). On 2022 to 2024 B lost (−₹26,749) and REF gained
a little (+₹16,268), below its controls. The forward column puts the running total so far next to
those; it is much shorter than two years and means nothing until the judgement point.

## Candidates with no scoring yet

Two small versions from the hourly-checkpoint study passed every control on the last two years and
lost about ₹10,000 on 2022 to 2024: list A dropping a pending pick when the VIX state says it
will lose, and list C swapping pending picks by VIX and the running Widesl's result. They are
kept for observation, but nothing scores them each night yet. They are shown with their
definitions and marked Not scored; no number here is theirs.

## What it does not tell you

That an idea works. The leads were picked from twelve cells in the same two years they are
judged on, in one regime. A few forward days will mostly show noise: judge at the count in the
banner, and by whether the sign and the controls agree, not by the first good week. Nothing on
this page is advice to change a list.
