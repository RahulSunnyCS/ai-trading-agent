"""BL-226: the F&O universe gate — a stock is in the universe in week W when it was on the F&O
list on the last listed session on or before W."""

from datetime import date

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from momentum_backtesting.categories import fno


def _members(root, rows):
    path = fno.members_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"date": [r[0] for r in rows], "symbol": [r[1] for r in rows]}), path)


def test_gate_follows_the_last_listed_session_and_years_are_supersets(tmp_path):
    _members(tmp_path, [
        (date(2020, 1, 1), "AAA"), (date(2020, 1, 3), "AAA"), (date(2020, 1, 3), "BBB"),
        (date(2020, 1, 10), "BBB"), (date(2021, 1, 4), "CCC"),
    ])  # fmt: skip
    weeks = pd.DatetimeIndex(["2019-12-27", "2020-01-03", "2020-01-10", "2021-01-08"])
    g = fno.gate(weeks, ["AAA", "BBB", "CCC", "ZZZ"], tmp_path)
    assert not g.loc["2019-12-27"].any()  # before the first listed session
    assert g.loc["2020-01-03"].to_dict() == {"AAA": True, "BBB": True, "CCC": False, "ZZZ": False}
    assert g.loc["2020-01-10"].to_dict() == {"AAA": False, "BBB": True, "CCC": False, "ZZZ": False}
    assert g.loc["2021-01-08"].to_dict() == {"AAA": False, "BBB": False, "CCC": True, "ZZZ": False}
    assert fno.members_by_year(tmp_path) == {2020: {"AAA", "BBB"}, 2021: {"CCC"}}
