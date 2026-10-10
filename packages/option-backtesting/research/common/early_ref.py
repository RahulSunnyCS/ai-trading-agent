"""Reference data that also answers for days before the reference CSVs start.

`lot_sizes.csv` starts 2024-10-03, so a legwise run on a 2022-24 day raises MissingReferenceData
inside the engine even with `lot_sizing: current` (the contract's own lot is looked up to compare
with the symbol master). This wrapper answers lot size and strike step for such days with the
2024-10-03 rows. With `lot_sizing: current` the quantity is today's lot either way, so the fallback
changes nothing a result depends on. Same wrapper as `research/bl083/simulate.py::_ref()`, moved
here so later items do not import across item folders.
"""

from __future__ import annotations

from datetime import date

FALLBACK = date(2024, 10, 3)


def early_reference():
    from option_backtesting.data.reference.loader import (
        MissingReferenceData,
        default_reference_data,
    )

    class Early:
        def __init__(self, ref):
            self._ref = ref

        def __getattr__(self, name):
            return getattr(self._ref, name)

        def _early(self, call, underlying, when):
            try:
                return call(underlying, when)
            except MissingReferenceData:
                return call(underlying, FALLBACK)

        def lot_size(self, underlying, expiry):
            return self._early(self._ref.lot_size, underlying, expiry)

        def strike_step(self, underlying, as_of):
            return self._early(self._ref.strike_step, underlying, as_of)

    return Early(default_reference_data())
