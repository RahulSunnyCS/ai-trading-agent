# BL-171 — Finvasia's capital read automatically for the Trade book

| | |
|---|---|
| **Priority** | P3 — the typed figure works; this saves typing it whenever the account's money changes |
| **Status** | Idea |
| **Type** | improvement |
| **Area** | contract-notes / broker-login / scheduler |
| **Created** | 2026-10-27 |
| **Depends on** | BL-168 (`manual/<day>.json`'s `capital`, `realised/capital.py`); BL-152 (a free-margin read without AlgoTest or Shoonya's login) or BL-143's 09:05 margin check |
| **TODO.md row** | — (filled in when started) |

## Context

The Trade book's capital is the money an account had on the session's morning (owner,
2026-10-26). Angel One's is read after each close by `obt realised capital` (scheduler
`contract-notes-capital`, 15:50) and written as the next session's capital. Finvasia's is
not read: its only source today is AlgoTest's figure, which AlgoTest refreshes at the morning
broker login, and a 15:50 AlgoTest login would collide with the 15:40 / 15:55 live capture and
the Quantiply disable. Shoonya's own API is never logged in to (BL-143).

So the owner types it. On 2026-10-27 the owner gave a figure, stored from that session
(`manual/2026-10-27.json`, in the store, not here: the repo is public); it carries forward
until a new figure is typed.

## Goal

Finvasia's capital lands in `manual/<day>.json` every session without typing, from a read
that logs in to nothing extra.

## Out of scope

- Logging in to Shoonya's own API.
- Any AlgoTest login outside the morning one.

## Plan

### Phase 1 — Pick the source
- **Tasks:** compare the candidates:
  1. BL-143's trade monitor already reads AlgoTest's `GET /brokers` at 09:05 when
     `MARGIN_CHECK=on`, after the morning login. That is the session's morning money, exactly
     the capital's definition: record it as the session's `capital.finvasia` (source
     `algotest-0905`), and only when AlgoTest's figure is from today.
  2. Whatever BL-152 settles on, if it reads Finvasia without AlgoTest.
  3. The contract note's or ledger e-mail's closing balance, if Finvasia sends one.
- **Done when:** the source is chosen with the owner and recorded here.

### Phase 2 — Record it
- **Tasks:** write through `realised.capital.write_manual` (its lock, durable write); never
  overwrite a figure the owner typed for that session; the Trade book shows the source.
- **Done when:** a week of sessions has Finvasia's capital without typing, each equal to the
  account's morning funds.

## Risks

- AlgoTest's figure may be stale (its broker login did not run): skip the day rather than
  record yesterday's money.

## Open questions

1. Is the 09:05 figure (after the morning login, before any trade) the right "morning money"
   for Finvasia, given its 50:50 cash rule?
2. Should a read figure replace a typed one on a later session, or only fill days with none?

## Log

- 2026-10-27 — created at the owner's request; Finvasia's capital typed by hand meanwhile.
