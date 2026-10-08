Every number in this dashboard comes from a model of the past. This page lists what that model
leaves out, so you can judge how much weight a result deserves.

## A backtest is not a forecast

A [backtest](glossary:backtest) replays a rule over history. Markets change; a rule that
worked from 2016 to 2026 can stop working. The longer and more varied the history a rule has
worked over, the more it means, but it never proves the future.

## Trying many variations finds luck

If you try fifty settings and keep the best, the best is partly luck: this is
[overfitting](glossary:overfitting). Signs a result is overfitted:

- it only wins in one period, or with one exact setting, and loses with the neighbouring ones;
- the improvement is small compared with how much the result swings from year to year;
- it was found by trying many things, not predicted in advance.

The owner's validation work re-tests the Momentum defaults over many overlapping three-year
stretches and only trusts a change that wins in most of them. Until a strategy's validation has
passed, treat its numbers as research, not as a track record.

## Costs, slippage and tax are assumptions

- **Momentum** charges a flat 0.10% per buy and per sell by default, or an itemised Indian cost
  model if you choose it. Tax is off by default; switching it on lowers the result a lot,
  because most holdings are sold within a year (short-term gains).
- **Options Lab** charges what you enter as [slippage](glossary:slippage) and cost per order.
  Both default to zero. A strategy that only works with zero costs does not work.

## Fills are idealised

- Momentum assumes you can trade at Friday's closing price (or Monday's open, if chosen).
  Real fills differ a little, and ETFs can trade above or below their value
  ([TER and tracking](glossary:ter)).
- Options Lab decides stops and targets from each minute's high and low. Inside a minute, the
  real order of prices is unknown; when a minute touches both the stop and the target, the stop
  is assumed (the cautious choice). Thin strikes can have no trade in a minute at all.

## Data has gaps and limits

- Option contracts vanish after expiry, so option history exists only for days that were
  collected (or bought from a data vendor). Short histories mean wide uncertainty.
- Momentum's stock data is [survivorship](glossary:survivorship)-aware, but prices are adjusted
  for [corporate actions](glossary:corporate-action) by rules that can occasionally be wrong; the
  [Weekly signal](guide:momentum/this-week) screen asks a person to confirm suspicious moves.

## The forward record is the real test

The [Journal](guide:momentum/journal) records each Friday's signal when it is made and never
edits it. Over months it becomes an honest record of what the strategy actually said in real
time, which no backtest can be.

## Sharing signals

The weekly signal is shared with a few friends for information only. Recommending trades to
other people, especially for a fee, can fall under SEBI's rules for research analysts and
advisers. That needs checking before it ever goes wider.
