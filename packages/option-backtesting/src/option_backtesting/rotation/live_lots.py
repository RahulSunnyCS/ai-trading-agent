"""The lots each pick trades (BL-183, owner 2026-10-28): on a day neither index expires, the
picked Dir trades 2 lots; every other pick, every pick on an expiry day, and every pick on a day
no Dir is picked trade 1 lot. From BL-133 Amendment 2 (the Dir is the best home for a fourth
lot) and Amendment 3 (expiry days stay at 3 lots of the expiring index).

Pure, and importing nothing of the rotation but `variants` (the messages import it): the
exports, the messages, the result and BL-135's lot plans all read it, so they never disagree. It
applies only where an account row's "Dir ×2 on non-expiry days" switch is on
(`automation_settings.dir_boost_wanted`); off, every pick is 1 lot as before. The Buy add-on is
never doubled."""

from __future__ import annotations

from ..legwise.schema import LegwiseStrategy
from .variants import is_dir

#: the lots of the doubled Dir
DIR_LOTS = 2


def is_expiry(labels: dict[str, str]) -> bool:
    """True when NIFTY or SENSEX expires today ({'NIFTY': '0', ...} on the weekday basis)."""
    return str(labels.get("NIFTY")) == "0" or str(labels.get("SENSEX")) == "0"


def dir_pick(core: list[str]) -> str | None:
    """The core Dir pick (Dir ATM or Dir ITM1), or None on a three-Widesl day."""
    return next((n for n in core if is_dir(n)), None)


def lots_for_day(core: list[str], dte: dict[str, str] | None, on: bool = True) -> dict[str, int]:
    """{variant: lots} for the day's core picks, in pick order. `dte` is {'NIFTY': .., 'SENSEX':
    ..} on the weekday basis; unknown labels (None) count as an expiry day, so nothing is doubled
    on a day that cannot be shown to be a normal one."""
    out = {n: 1 for n in core}
    if not on or dte is None or is_expiry(dte) or not _known(dte):
        return out
    d = dir_pick(core)
    if d is not None:
        out[d] = DIR_LOTS
    return out


def _known(dte: dict[str, str]) -> bool:
    return all(str(dte.get(i)).isdigit() or str(dte.get(i)) == "7+" for i in ("NIFTY", "SENSEX"))


def boosted(lots: dict[str, int]) -> bool:
    """Whether any pick trades more than 1 lot."""
    return any(v > 1 for v in lots.values())


def summary(core: list[str], dte: dict[str, str] | None) -> str:
    """Why the day trades what it does: 'Dir ×2', 'expiry day' or 'no Dir picked' (for messages)."""
    if dte is None or not _known(dte) or is_expiry(dte):
        return "expiry day"
    return "Dir ×2" if dir_pick(core) is not None else "no Dir picked"


def scaled(spec: LegwiseStrategy, lots: int) -> LegwiseStrategy:
    """`spec` traded at `lots` times its own size: every leg's lots and the overall rupee stop and
    target multiplied (a strategy's MTM SL is per lot: ₹3,000 at 1 lot is ₹6,000 at 2). Leg
    stops, targets and trails are in points or percent of the premium, so they stay as they are.
    1 returns `spec` itself, so a 1-lot export is exactly what it was."""
    if lots == 1:
        return spec
    if lots < 1:
        raise ValueError(f"lots must be at least 1, not {lots}")
    overall = spec.overall.model_copy(
        update={
            k: (None if v is None else v * lots)
            for k, v in (
                ("stop_loss_inr", spec.overall.stop_loss_inr),
                ("target_inr", spec.overall.target_inr),
            )
        }
    )
    legs = [leg.model_copy(update={"lots": leg.lots * lots}) for leg in spec.legs]
    return spec.model_copy(update={"legs": legs, "overall": overall})
