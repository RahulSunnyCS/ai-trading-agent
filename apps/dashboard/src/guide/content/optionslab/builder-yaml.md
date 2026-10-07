## What it is for

The **YAML mode** of the Builder is the older of Options Lab's two engines. A strategy is
written as text in a small strategy language instead of being built in a form. It runs on a
cache of AlgoTest bars rather than the daily Fyers collection, and supports conditions the
form does not (for example, entering when a feature such as the straddle's run-up crosses a
level).

Most people never need it: use the [Form mode](guide:optionslab/builder-form).

## The controls

| Control | What it does |
|---|---|
| Presets | Example strategies. Loading one replaces the editor's text. |
| Strategy editor | The YAML text, checked as you type. Errors point at the line. |
| Run | Runs the strategy over the cached days. |

## Reading the results

Net, gross, win days and worst day as in the form, plus **Net per lot-day**,
**Sum of peak losses** and **[Return on peak margin](glossary:margin)**: net profit divided by
the most margin the strategy needed at once, a fairer way to compare strategies that tie up
very different amounts of money.

## What it does not tell you

Results from the two engines are not directly comparable: they read different data and make
slightly different fill assumptions.
