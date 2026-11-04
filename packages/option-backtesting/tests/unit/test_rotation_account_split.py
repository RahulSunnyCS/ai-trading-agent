"""BL-209: T1 split across the two AlgoTest accounts. The odd pick trades on each account, the like
pair one per account at both accounts' lots; every pick and every account keeps its lots."""

from __future__ import annotations

from option_backtesting.rotation import account_split as s
from option_backtesting.rotation.live_lots import lots_for_day

DIR, DIR2 = "N_ditm1-t1s36_0947", "S_ditm1-t1s44_1217"
W1, W2, W3 = "N_wide-t1s8_0947", "S_p320_0947", "S_p285-t1s22_0932"
NORMAL = {"NIFTY": "2", "SENSEX": "4"}
EXPIRY = {"NIFTY": "3", "SENSEX": "0"}


def _never(name):
    return False


def _lots(core, dte, boost_shoonya=True, boost_angel=False):
    return {
        "finvasia": lots_for_day(core, dte, on=boost_shoonya),
        "angelone": lots_for_day(core, dte, on=boost_angel),
    }


def _totals(books):
    out: dict[str, int] = {}
    for book in books.values():
        for n, v in book.items():
            out[n] = out.get(n, 0) + v
    return out


def test_one_dir_two_widesl_on_an_expiry_day():
    core = [W1, DIR, W2]
    got = s.split(core, _lots(core, EXPIRY), reentry=_never)
    assert got == {"finvasia": {W1: 2, DIR: 1}, "angelone": {DIR: 1, W2: 2}}


def test_the_dir_x2_lot_stays_on_shoonya():
    core = [W1, DIR, W2]
    lots = _lots(core, NORMAL)
    got = s.split(core, lots, reentry=_never)
    assert got == {"finvasia": {W1: 2, DIR: 2}, "angelone": {DIR: 1, W2: 2}}
    assert _totals(got) == _totals(lots)
    assert {b: sum(v.values()) for b, v in got.items()} == {"finvasia": 4, "angelone": 3}


def test_three_widesl_the_third_trades_on_each():
    core = [W1, W2, W3]
    got = s.split(core, _lots(core, NORMAL), reentry=_never)
    assert got == {"finvasia": {W1: 2, W3: 1}, "angelone": {W2: 2, W3: 1}}


def test_the_re_entry_pair_member_goes_to_shoonya():
    core = [W1, DIR, W3]
    got = s.split(core, _lots(core, EXPIRY), reentry=lambda n: n == W3)
    assert got == {"finvasia": {DIR: 1, W3: 2}, "angelone": {W1: 2, DIR: 1}}
    both = s.split(core, _lots(core, EXPIRY), reentry=lambda n: True)
    assert both["finvasia"] == {W1: 2, DIR: 1}  # both re-enter: pick order


def test_two_dirs_the_doubled_one_stays_with_its_lot_whatever_re_enters():
    core = [DIR, W1, DIR2]
    lots = _lots(core, NORMAL)  # the first Dir is the doubled one
    got = s.split(core, lots, reentry=lambda n: n == DIR2)
    assert got == {"finvasia": {DIR: 3, W1: 1}, "angelone": {W1: 1, DIR2: 2}}
    angel_boost = _lots(core, NORMAL, boost_shoonya=False, boost_angel=True)
    got = s.split(core, angel_boost, reentry=_never)
    assert got == {"finvasia": {W1: 1, DIR2: 2}, "angelone": {DIR: 3, W1: 1}}
    assert {b: sum(v.values()) for b, v in got.items()} == {"finvasia": 3, "angelone": 4}


def test_days_the_split_leaves_alone():
    two = [W1, DIR]
    assert s.split(two, _lots(two, NORMAL)) == _lots(two, NORMAL)
    dirs = [DIR, DIR2, "N_dir_0917"]
    assert s.split(dirs, _lots(dirs, EXPIRY)) == _lots(dirs, EXPIRY)
    core = [W1, DIR, W2]
    one = {"finvasia": lots_for_day(core, NORMAL)}
    assert s.split(core, one) == one
    no_lead = {"angelone": {n: 1 for n in core}, "x": {n: 1 for n in core}}
    assert s.split(core, no_lead) == no_lead


def test_angel_one_can_lead():
    core = [W1, DIR, W2]
    got = s.split(core, _lots(core, EXPIRY), lead="angelone", reentry=_never)
    assert list(got) == ["angelone", "finvasia"]
    assert got == {"angelone": {W1: 2, DIR: 1}, "finvasia": {DIR: 1, W2: 2}}


def test_has_reentry_reads_the_strategy_file():
    assert s.has_reentry(W3) and not s.has_reentry(W1)
    assert not s.has_reentry("N_nosuch_0917")
