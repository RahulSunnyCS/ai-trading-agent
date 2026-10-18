"""Self-explaining strategy labels for the Telegram messages (BL-125).

A rotation variant is stored under an id like `N_wide_1117` or `N_p150-t1s11_0917`. The id is for
the journal and never changes; it says little about what the strategy does. `label(name)` reads the
strategy's own YAML (the Core-298 file or the T1 track's, `variants.strategy_path`) and returns

    head    `{N|S}_{dir|widesl|buy}_{strike}`        N_widesl_OTM1, N_dir_ITM1, N_widesl_p150
    params  the settings that decide the day's P&L   SL115% · TSL15%/10% · REnone · MTMSL2500

so a message line reads on its own. Message text only: nothing here feeds a pick, a score or the
journal. A name with no readable file falls back to the raw id (`fallback`), because a message
must always go out.

Params, in order, each from the YAML (a leg setting that differs between the CE and the PE is
joined: `SL114%/115%`):

    SL<x>%|<x>pt        stop loss per leg
    TSL<a>%/<b>%        trail (percent), `TSL<a>pt/<b>pt` (points), or `TSLnone`
    RECOST<n>|REASAP<n> re-entry after a stop (mode cost | asap), or `REnone`
    RB<entry>-<until>-<side>[-underlying][+<gap>%][-><valid_until>]
                        range breakout (Buy). It takes the re-entry slot; `RE...` is shown before
                        it only when the strategy also has a re-entry
    TP<x>%|<x>pt, ROLL<decay>   only when set (no Core or T1 file uses them today)
    MTMSL<amount>|MTMSLnone     the overall stop loss in rupees; `MTMTP<amount>` if a target is set
"""

from __future__ import annotations

from functools import lru_cache
from typing import NamedTuple

from ..legwise.schema import Amount, Leg, LegwiseStrategy, load_legwise
from .variants import is_buy, is_dir, is_wide, parts, strategy_path


class Label(NamedTuple):
    head: str
    params: str


def _num(value: float) -> str:
    return f"{value:g}"


def _amount(a: Amount | None) -> str | None:
    if a is None:
        return None
    return f"{_num(a.percent)}%" if a.percent is not None else f"{_num(a.points)}pt"


def _kind(name: str) -> str | None:
    if is_buy(name):
        return "buy"
    if is_dir(name):
        return "dir"
    if is_wide(name):
        return "widesl"
    return None


def _strike(leg: Leg) -> str:
    if leg.strike.closest_premium is not None:
        return f"p{_num(leg.strike.closest_premium)}"
    return str(leg.strike.strike_type)


def _across(legs: list[Leg], per_leg, sep: str) -> str:
    """One value when both legs agree, otherwise the legs' values joined (CE first)."""
    values = [per_leg(leg) for leg in sorted(legs, key=lambda leg: leg.option_type)]
    return values[0] if len(set(values)) == 1 else sep.join(values)


def _trail(leg: Leg) -> str:
    t = leg.trail_sl
    if t is None:
        return "none"
    unit, pair = ("%", t.percent) if t.percent is not None else ("pt", t.points)
    return f"{_num(pair[0])}{unit}/{_num(pair[1])}{unit}"


def _reentry(leg: Leg) -> str | None:
    r = leg.reentry_on_sl
    return None if r is None else f"RE{r.mode.upper()}{r.count}"


def _range_breakout(strategy: LegwiseStrategy, leg: Leg) -> str | None:
    r = leg.range_breakout
    if r is None:
        return None
    text = f"RB{strategy.entry_time}-{r.until}-{r.side}"
    if r.source == "underlying":
        text += "-underlying"
    if r.gap_percent:
        text += f"+{_num(r.gap_percent)}%"
    if r.valid_until:
        text += f"->{r.valid_until}"
    return text


def _params(strategy: LegwiseStrategy) -> str:
    legs = strategy.legs
    tokens = [f"SL{_across(legs, lambda leg: _amount(leg.stop_loss) or 'none', '/')}"]
    tokens.append(f"TSL{_across(legs, _trail, '|')}")
    reentry = _across(legs, lambda leg: _reentry(leg) or "", "|")
    breakout = _across(legs, lambda leg: _range_breakout(strategy, leg) or "", "|")
    if reentry:
        tokens.append(reentry)
    elif not breakout:
        tokens.append("REnone")
    if breakout:
        tokens.append(breakout)
    target = _across(legs, lambda leg: _amount(leg.target) or "", "|")
    if target:
        tokens.append(f"TP{target}")
    roll = _across(legs, lambda leg: "" if leg.roll is None else _num(leg.roll.decay), "|")
    if roll:
        tokens.append(f"ROLL{roll}")
    overall = strategy.overall
    tokens.append(
        "MTMSLnone" if overall.stop_loss_inr is None else f"MTMSL{_num(overall.stop_loss_inr)}"
    )
    if overall.target_inr is not None:
        tokens.append(f"MTMTP{_num(overall.target_inr)}")
    return " · ".join(tokens)


def fallback(name: str) -> Label:
    """What a message shows for a variant whose strategy file cannot be read."""
    return Label(name, "")


@lru_cache(maxsize=1024)
def _load(name: str) -> LegwiseStrategy | None:
    try:
        return load_legwise(strategy_path(name))
    except Exception:  # noqa: BLE001 - no file, a bad file or an unknown track: the id is shown
        return None


def label(name: str) -> Label:
    """(head, params) of a rotation variant, from its strategy file; never raises."""
    try:
        index, _, _ = parts(name)
        kind = _kind(name)
        strategy = _load(name)
        if kind is None or strategy is None or index not in ("N", "S"):
            return fallback(name)
        strikes = _across(strategy.legs, _strike, "/")
        return Label(f"{index}_{kind}_{strikes}", _params(strategy))
    except Exception:  # noqa: BLE001 - a message must always go out
        return fallback(name)


def buy_strategy(name: str) -> bool:
    """Whether the id is a Buy variant; False for an id that is not a rotation variant at all."""
    try:
        return is_buy(name)
    except ValueError:
        return False


def slot(name: str) -> str:
    """The entry time in the variant's id (`N_wide_1117` -> `11:17`), or '' when it has none."""
    try:
        tag = parts(name)[2]
    except ValueError:
        return ""
    ok = len(tag) == 4 and tag.isdigit() and int(tag[:2]) < 24 and int(tag[2:]) < 60
    return f"{tag[:2]}:{tag[2:]}" if ok else ""


def breakout_note(name: str) -> str | None:
    """`buys only if the premium breaks the range high` for a range-breakout strategy, else None."""
    strategy = _load(name)
    if strategy is None:
        return None
    r = next((leg.range_breakout for leg in strategy.legs if leg.range_breakout), None)
    if r is None:
        return None
    what = "the index" if r.source == "underlying" else "the premium"
    return f"buys only if {what} breaks the range {r.side}"
