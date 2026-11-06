"""BL-215 folds (registered in backlog/BL-215 Phase 1 before any selection ran). NIFTY only.

A fold is (name, tune start, ranking half-boundary, tune end exclusive, test start, test end exclusive).
The ranking half is the first half of the tuning window and the confirming half the second, as T1's
selection (BL-104 daytype_lists, rule R1) uses them. LAST_DAY is the last stored session (2026-11-06).
"""

from __future__ import annotations

from datetime import date, timedelta

LAST_DAY = date(2026, 11, 6)
END = LAST_DAY + timedelta(days=1)
NEW_ERA = date(2024, 10, 9)  # first day of the original Stage 1 data; earlier tuning windows use bl215x

FOLDS_12M = [
    ("F1", date(2021, 11, 1), date(2022, 5, 1), date(2022, 11, 1), date(2022, 11, 1), date(2023, 11, 1)),
    ("F2", date(2022, 11, 1), date(2023, 5, 1), date(2023, 11, 1), date(2023, 11, 1), date(2024, 10, 9)),
    ("F3", date(2023, 11, 1), date(2024, 5, 1), date(2024, 10, 9), date(2024, 10, 9), date(2025, 10, 9)),
    ("F4", date(2024, 10, 9), date(2025, 4, 9), date(2025, 10, 9), date(2025, 10, 9), END),
]

_B = [date(2021, 11, 1), date(2022, 4, 9), date(2022, 10, 9), date(2023, 4, 9), date(2023, 10, 9),
      date(2024, 4, 9), date(2024, 10, 9), date(2025, 4, 9), date(2025, 10, 9), date(2026, 4, 9), END]


def _mid(a: date, b: date) -> date:
    return a + (b - a) // 2


FOLDS_6M = [
    (f"H{k}", _B[k - 1], _mid(_B[k - 1], _B[k]), _B[k], _B[k], _B[k + 1]) for k in range(1, len(_B) - 1)
]

ALL_FOLDS = {"12m": FOLDS_12M, "6m": FOLDS_6M}

if __name__ == "__main__":
    for kind, folds in ALL_FOLDS.items():
        for f in folds:
            print(kind, *[str(x) for x in f])
