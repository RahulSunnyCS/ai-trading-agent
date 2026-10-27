## What it is for

**Coverage** manages historical candles for the paused live engine: its two sections
fetch history (Backfill) and show which ranges can be replayed through that engine (Replay).

> [!NOTE]
> Options Lab and Momentum do **not** use this screen. Their data is collected by the scheduled
> jobs into the research database; its health is on the [Overview](app:/overview)'s Data card and
> the Today page. Coverage sits in the sidebar's **Archived engine** section, hidden by default
> (show it under [Settings](guide:operations/settings) › Navigation, or open `/coverage`). It reads
> the paused engine's server, so without that server running it shows an error. Most readers can
> skip this page.

## Backfill

Queue a historical data fetch from Fyers (it needs a valid [Fyers token](glossary:fyers-token)).
A status table shows the latest range per symbol and whether each fetch completed, is running,
or failed.

## Replay

Read-only. Explains how to re-run stored history through the live pipeline from a terminal, and
lists the completed ranges, each with a copyable command. A replay is deterministic: the same
input always gives the same result.
