## What it is for

The sweep tried the Options Lab's families on commodity options over two years: **Dir** and **Widesl** (selling a call and a put in the evening session) and **Buy** (a range breakout and a timed buy, morning and evening), on the four minis, in the **expiry week** and the **week before**. Nothing here is recomputed: it is the recorded verdict, copied from the research item.

## How it was run

- **Fit year** (Nov 2024 to Oct 2025) to find the best setting of each family; **test year** (Nov 2025 to Oct 2026) read only after the finalists were fixed.
- One lot, after MCX charges and **1% slippage on every fill**, with the result at 0.5% and 0% beside it.
- **Lower bound**: the 5th percentile of ₹ a session over resampled whole expiries, so one lucky expiry cannot carry a setting.

## The verdict

One setting passed all five rules: **gold Dir in the expiry week**. The other seven finalists failed at least one: they lost money in the test year, depended on one expiry, or had a cohort too likely to be overfit. Crude oil was killed on the fit year alone.

## Why the sellers mostly lose

Dir and Widesl made money **before charges** on every root. A flat ₹20 an order plus GST and CTT does not fit a lot that earns a few hundred rupees a session (crude, gas). Gold's ₹10 a point on a ₹1.2 lakh underlying earns enough to carry them.

## Read with care

Both years were a gold bull run; the test year leans on January to March 2026. There are only about 60 sessions a year, the real bid-ask spread was not measured, and one pass among eight finalists from 48 cohorts is what luck alone could produce. It is a lead for the [forward test](guide:commodity/gold-forward-test), not for live money.
