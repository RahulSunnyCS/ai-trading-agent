# Research findings, by strategy and variable

What we already know about each variable of each strategy: what was tested, over which data, what
it found, and where the evidence is. One page per variable.

- [`options/`](options/README.md): Widesl, Directional, Buy (range breakout) and the side studies.
- [`momentum/`](momentum/README.md): the weekly rotation strategies (ETF, Broad, Custom Index, Stock)
  and every engine parameter. This replaced `docs/momentum-parameters-reference.md` and its
  plain-English twin on 2026-10-14.

These are **findings notes, not the record.** Each verdict summarises a backlog item's Result or Log
and cites it (a number worked out for the page from an item's result files says so, and names the
file); the item (`backlog/BL-NNN-*.md`) stays the record, with its pre-registration. Code and
result files stay where they are:

| What | Where |
|---|---|
| Options research scripts | `packages/option-backtesting/research/blNNN/` (generated output git-ignored) |
| Options strategy files | `packages/option-backtesting/strategies/legwise/`, `strategies/rotation*/` |
| Momentum criteria and results | `packages/momentum-backtesting/search_spaces/` (committed JSON / TOML) |

## Status words

| Status | Meaning |
|---|---|
| **Tested** | A pre-registered comparison was run and has a verdict (passed, killed, inconclusive) |
| **Descriptive** | Numbers were tabulated (a breakdown, a sweep ranked in-sample) but no rule was tested |
| **Not tested** | An idea, defined here so it is not lost; no numbers yet |

A descriptive pattern is a lead, never a finding. Say so on the page.

## Page template

```markdown
# <Strategy>: <variable>

**Status:** Tested | Descriptive | Not tested · **Last updated:** YYYY-MM-DD

## What it is
One paragraph, plus the YAML / config field that sets it.

## Live value
What the live or rotation strategy uses today (file and value).

## Tested
| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|

## What we know
- 2–4 bullets, each with its caveat (descriptive or registered, before or after charges, which index).

## Not yet tested
- Open questions.

## Related
- The same variable in other strategies, `common/` pages.
```

If a cited CSV is git-ignored, the page says so ("regenerate with …").

## Keeping it current

Closing a research item updates the page of every variable it tested, in the same commit, and a new
variable gets a page (and a row in the strategy matrix) the first time it is tested or proposed.
