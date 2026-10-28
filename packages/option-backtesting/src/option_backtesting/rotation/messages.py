"""The text of the rotation Telegram messages (BL-125): pure functions from journal entries,
results and expected picks to a string. Nothing here reads or writes the store, scores, or touches
a hash, so the picks, the journal and the scoring are exactly what they were; only the wording
changes.

Morning (09:16): Adaptive, then the T1 track, in one vertical message. Evening (16:00): the day's
result for both, then tomorrow's strategies in full. The owner and the friends' group get the same
text, except the owner's evening live-vs-paper lines. Strategy names come from `labels.label`, so
every line says what the strategy does (`N_widesl_OTM1` and its stop loss, trail, re-entry and
overall stop) instead of an id.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta

from . import labels
from .lists import DISPLAY_NAMES

ADAPTIVE_KEY = "C"
NUMBERS = ("1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣")
SEPARATOR = "━━━━━━━━━━━━━━━"
#: what the messages call the T1 track (owner, 2026-10-28); alerts and logs still say T1
T1_NAME = "Tuned Adaptive (In Testing phase)"
T1_HEAD = f"🧪 {T1_NAME}"
T1_NOT_RECORDED = f"{T1_HEAD} · not recorded today"
#: the morning note when T1 is still being recorded (slow, or its results being caught up): it
#: follows as a message of its own, or an alert says it failed
T1_FOLLOWS = f"{T1_HEAD} · follows in a separate message"
#: the evening message's T1 notes
T1_RESULT_NOT_READY = f"{T1_HEAD} · result not ready"
T1_RESULT_NOT_RECORDED = T1_NOT_RECORDED
T1_TOMORROW_NOT_READY = f"{T1_HEAD} · not ready"
LATE_LINE = "⚠️ LATE · not a forward entry"
MINUS = "−"


def day_text(day: date | str) -> str:
    """`Mon 19 Oct`."""
    d = date.fromisoformat(day) if isinstance(day, str) else day
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}"


def rupees(value: float) -> str:
    """`+₹1,240`, `−₹460` (a real minus sign), `₹0`."""
    rounded = round(value)
    sign = "+" if rounded > 0 else MINUS if rounded < 0 else ""
    return f"{sign}₹{abs(rounded):,}"


def expiry_day_line(index: str) -> str:
    """The one line a BL-122 rule day adds to the morning message."""
    return f"⚡ Expiry day · {index} only"


def dte_text(dte: dict | None) -> str:
    """`NIFTY 2 DTE · SENSEX 4 DTE` (weekdays to each index's expiry), or '' when not known."""
    parts = [
        f"{index} {dte[index]} DTE"
        for index in ("NIFTY", "SENSEX")
        if dte and str(dte.get(index, "unknown")) != "unknown"
    ]
    return " · ".join(parts)


def _with_dte(head: str, dte: dict | None) -> str:
    text = dte_text(dte)
    return f"{head} · {text}" if text else head


def change_line(day: date | str, previous: dict | None, core, buy) -> str:
    """How the 09:16 picks compare with the list the evening message sent (`previous`:
    `{'day', 'sent_on', 'core', 'buy'}`): `✅ No change from yesterday's list` or `🔄 Changed from
    yesterday's list: ➖ 12:17 N_widesl_p100 · ➕ 09:32 S_dir_ATM`; '' with no evening list, or
    one it cannot read (never raises: the 09:16 message is sent after the entry is recorded)."""
    try:
        return _change_line(day, previous, core, buy)
    except Exception:  # noqa: BLE001
        return ""


def _change_line(day: date | str, previous: dict | None, core, buy) -> str:
    if not isinstance(previous, dict) or str(previous.get("day")) != str(day):
        return ""
    sent_on = str(previous.get("sent_on") or "")
    d = date.fromisoformat(day) if isinstance(day, str) else day
    yesterday = sent_on == (d - timedelta(days=1)).isoformat()
    when = "yesterday's" if yesterday or not sent_on else f"{day_text(sent_on)[:3]}'s"
    before = {*previous.get("core", []), *previous.get("buy", [])}
    now = {*core, *buy}
    if before == now:
        return f"✅ No change from {when} list"
    gone = [f"➖ {_at(n, labels.label(n).head)}" for n in _by_time(sorted(before - now))]
    new = [f"➕ {_at(n, labels.label(n).head)}" for n in _by_time(sorted(now - before))]
    return f"🔄 Changed from {when} list: " + " · ".join([*gone, *new])


def _at(name: str, head: str) -> str:
    """`09:17  N_dir_ITM1` (the head alone for an id with no entry time)."""
    when = labels.slot(name)
    return f"{when}  {head}" if when else head


def _by_time(names: Sequence[str]) -> list[str]:
    return sorted(names, key=lambda n: (labels.slot(n) or "99:99", n))


def pick_lines(
    core: Sequence[str],
    buy: Sequence[str] = (),
    options: dict[str, str | None] | None = None,
) -> list[str]:
    """The numbered strategies (by entry time), the Buy add-on when there is one, and the optional
    next-best line. Each strategy is its time and head, with its full settings underneath."""
    lines: list[str] = []
    for i, name in enumerate(_by_time(core)):
        lab = labels.label(name)
        lines.append(f"{NUMBERS[i] if i < len(NUMBERS) else '▪️'} {_at(name, lab.head)}")
        if lab.params:
            lines.append(f"   {lab.params}")
    if buy:
        lines.append("➕ Buy")
        for name in _by_time(buy):
            lab = labels.label(name)
            lines.append(f"   {_at(name, lab.head)}")
            if lab.params:
                lines.append(f"   {lab.params}")
            note = labels.breakout_note(name)
            if note:
                lines.append(f"   ⏳ {note}")
    extra = optional_line(options)
    if extra:
        lines.append(extra)
    return lines


def optional_line(options: dict[str, str | None] | None) -> str:
    """`➕ Optional: Widesl 13:17 N_widesl_OTM1 · Dir 09:47 N_dir_ITM1`, or ''."""
    parts = [
        f"{word} {labels.slot(options[kind])} {labels.label(options[kind]).head}"
        for kind, word in (("wide", "Widesl"), ("dir", "Dir"))
        if options and options.get(kind)
    ]
    return "➕ Optional: " + " · ".join(parts) if parts else ""


def footer(entry: dict) -> str:
    """`🔒 f1a77247 · 09:16`: the entry's chain hash and the minute it was recorded."""
    h = str(entry.get("hash", ""))
    witness = "dry run" if h.startswith("(") or not h else h[:8]
    return f"🔒 {witness} · {str(entry.get('recorded_at', ''))[11:16]}"


def _entry_picks(entry: dict) -> tuple[list[str], list[str]]:
    block = entry["lists"][ADAPTIVE_KEY]
    return list(block["core"]), list(block["buy"])


def _adaptive_block(
    entry: dict, options: dict[str, str | None] | None, previous: dict | None = None
) -> list[str]:
    head = f"🎯 {DISPLAY_NAMES.get(ADAPTIVE_KEY, 'Adaptive').upper()} · {day_text(entry['day'])}"
    lines = [_with_dte(head, entry.get("dte"))]
    if entry.get("expiry_only"):
        lines.append(expiry_day_line(entry["expiry_only"]))
    core, buy = _entry_picks(entry)
    change = change_line(entry["day"], previous, core, buy)
    if change:
        lines.append(change)
    return [*lines, "", *pick_lines(core, buy, options)]


def _t1_block(
    entry: dict,
    options: dict[str, str | None] | None,
    *,
    dated: bool = False,
    previous: dict | None = None,
) -> list[str]:
    head = f"{T1_HEAD} · {day_text(entry['day'])}" if dated else T1_HEAD
    lines = [head]
    if entry.get("expiry_only"):  # BL-122 restricts T1 as well, so its block says so too
        lines.append(expiry_day_line(entry["expiry_only"]))
    # inside the combined message; a T1 message of its own carries LATE as its first line instead
    if not dated and not entry.get("before_first_entry", True):
        lines.append(f"   {LATE_LINE}")
    core, buy = _entry_picks(entry)
    change = change_line(entry["day"], previous, core, buy)
    if change:
        lines.append(change)
    return [*lines, "", *pick_lines(core, buy, options)]


def _late_prefix(entry: dict) -> list[str]:
    return [] if entry.get("before_first_entry", True) else [LATE_LINE]


def render_entry(entry: dict, options: dict[str, dict[str, str | None]] | None = None) -> str:
    """One journal entry as a message of its own: Adaptive's layout for the live entry, the T1
    layout (labelled testing phase) for a track entry."""
    own = (options or {}).get(ADAPTIVE_KEY)
    body = _t1_block(entry, own, dated=True) if entry.get("track") else _adaptive_block(entry, own)
    lines = [*_late_prefix(entry), *body, "", footer(entry)]
    return "\n".join(lines)


def render_morning(
    live: dict,
    live_options: dict[str, dict[str, str | None]] | None,
    t1: dict | None,
    t1_options: dict[str, dict[str, str | None]] | None = None,
    t1_note: str = T1_NOT_RECORDED,
    previous: dict | None = None,
) -> str:
    """The 09:16 message, the same for the owner and the friends' group: Adaptive, then the T1
    track (or, with no T1 entry, `t1_note`: not recorded, or follows separately), ending with the
    Adaptive entry's chain hash. `previous` is the list the evening message sent for this session
    (`result.read_tentative`): each list then says whether it changed."""
    previous = previous or {}
    adaptive = _adaptive_block(
        live, (live_options or {}).get(ADAPTIVE_KEY), previous.get("adaptive")
    )
    t1_lines = (
        [t1_note]
        if t1 is None
        else _t1_block(t1, (t1_options or {}).get(ADAPTIVE_KEY), previous=previous.get("t1"))
    )
    return "\n".join([*_late_prefix(live), *adaptive, "", SEPARATOR, *t1_lines, "", footer(live)])


# -- evening ------------------------------------------------------------------------------------


def _result_rows(strategies: Sequence[tuple[str, float]]) -> list[str]:
    rows = sorted(
        strategies, key=lambda s: (labels.buy_strategy(s[0]), labels.slot(s[0]) or "99:99", s[0])
    )
    heads = [labels.label(name).head for name, _ in rows]
    amounts = [rupees(value) for _, value in rows]
    head_w = max((len(h) for h in heads), default=0)
    amount_w = max((len(a) for a in amounts), default=0)
    out = []
    for (name, _), head, amount in zip(rows, heads, amounts, strict=True):
        lead = "➕" if labels.buy_strategy(name) else "  "
        out.append(f"{lead} {_at(name, head.ljust(head_w))}  {amount.rjust(amount_w)}")
    return out


def result_block(
    emoji: str, name: str, gain: float, strategies: Sequence[tuple[str, float]]
) -> list[str]:
    return [f"{emoji} {name.ljust(8)}   {rupees(gain)}", *_result_rows(strategies)]


def _next_lines(title: str, picks) -> list[str]:
    return [title, *pick_lines(picks.core, picks.buy, picks.options)]


def render_result(
    day: date | str,
    adaptive: tuple[float, Sequence[tuple[str, float]]] | None,
    t1: tuple[float, Sequence[tuple[str, float]]] | str | None,
    tomorrow_adaptive=None,
    tomorrow_t1=None,
    *,
    heading: str = "result",
    live: Sequence[str] | None = None,
) -> str:
    """The evening message. `adaptive` and `t1` are (total, [(strategy, rupees)]); either may be
    None to leave that list out (the T1 follow-up has no Adaptive), and
    `t1` may be a note (`T1_RESULT_NOT_READY`). `tomorrow_adaptive` / `tomorrow_t1` are
    `tomorrow.NextPicks` (T1's may be a note); with neither there is no tomorrow section. `live` is
    BL-141's live-vs-paper block (`live_compare.message_lines`), for the owner's copy only."""
    lines = [f"📊 {day_text(day)} · {heading}", "1 lot per strategy, after costs"]
    if adaptive is not None:
        lines += ["", *result_block("🎯", "Adaptive", *adaptive)]
    if isinstance(t1, str):
        lines += ["", t1]
    elif t1 is not None:
        lines += ["", *result_block("🧪", T1_NAME, *t1)]
    if live:
        lines += ["", *live]
    first = tomorrow_adaptive or (None if isinstance(tomorrow_t1, str) else tomorrow_t1)
    if first is not None:
        lines += ["", f"➡️ {day_text(first.day)} (Tentative)"]
        if first.expiry_only:
            lines.append(f"⚡ {first.expiry_only} only")
        lines.append("")
        if tomorrow_adaptive is not None:
            lines += _next_lines(_with_dte("🎯 Adaptive", tomorrow_adaptive.dte), tomorrow_adaptive)
        if isinstance(tomorrow_t1, str):
            lines.append(tomorrow_t1)
        elif tomorrow_t1 is not None:
            lines += _next_lines(T1_HEAD, tomorrow_t1)
    return "\n".join(lines)
