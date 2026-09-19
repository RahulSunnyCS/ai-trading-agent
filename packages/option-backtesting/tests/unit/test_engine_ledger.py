from option_backtesting.engine.ledger import Fill, SessionLedger


def test_total_lots_sums_across_fills() -> None:
    ledger = SessionLedger()
    ledger.add(Fill(price=50.0, bar=0, lots=2, tag="entry"))
    ledger.add(Fill(price=55.0, bar=5, lots=1, tag="t1"))
    assert ledger.total_lots() == 3


def test_has_fired_checks_tag_presence() -> None:
    ledger = SessionLedger()
    ledger.add(Fill(price=50.0, bar=0, lots=2, tag="entry"))
    assert ledger.has_fired("entry")
    assert not ledger.has_fired("t1")


def test_earliest_bar_for_tags_returns_none_when_absent() -> None:
    ledger = SessionLedger()
    ledger.add(Fill(price=50.0, bar=0, lots=2, tag="entry"))
    assert ledger.earliest_bar_for_tags(frozenset({"t1", "t2"})) is None


def test_earliest_bar_for_tags_finds_the_minimum() -> None:
    ledger = SessionLedger()
    ledger.add(Fill(price=50.0, bar=0, lots=2, tag="entry"))
    ledger.add(Fill(price=55.0, bar=8, lots=1, tag="t1"))
    ledger.add(Fill(price=60.0, bar=3, lots=1, tag="t2"))
    assert ledger.earliest_bar_for_tags(frozenset({"t1", "t2"})) == 3
