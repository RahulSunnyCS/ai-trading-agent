"""Realised results from the brokers' contract notes (BL-168 Phase 4).

`packages/contract-notes` stores each session's notes under `TRADING_DATA_ROOT/contract-notes/`
(`days/`, `ledger/`, `manual/`). This package reads that store, never writes it except the 15:50
capital reading (`capital.py`), and computes what the Trade book page shows: the owner's sheet's
ratios by its own formulas (`ratios.py`), round trips (`trips.py`), where each trip came from
(`sources.py`), and the lake's view of each trip and day (`context.py`). Nothing computed is
stored: every figure is rebuilt on read.
"""
