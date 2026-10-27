"""The condition grammar of a rule strategy (BL-120 Phase 1) and its evaluator.

A condition is a small expression tree written as YAML or JSON. Every value is a (sessions x 375)
array on the 1-minute grid; stamp j is the bar that starts at 09:15 + j minutes. **Every operator
reads only stamps <= j of the session and earlier sessions**, so a firing at stamp j is known when
that bar completes and the trade enters at j + 1 (the BL-083 convention).

Leaves
    a number                       a constant
    open high low close            the index bar at that stamp
    vix                            India VIX close at that stamp (NaN where it has no bar)
    vix_open                       the VIX's 09:15 open, constant per session
    session_open                   the index's 09:15 open, constant per session
    prev_high prev_low prev_close  the previous session's
    pivot r1 s1                    the previous session's classic pivot P = (H+L+C)/3,
                                   R1 = 2P-L, S1 = 2P-H
    atr14                          mean true range of the previous 14 completed sessions
    minute                         the stamp index (0 = 09:15)
    expiry_day                     true all session when its nearest listed weekly expiry is
                                   that session (BL-165; known before the open)
    {clock: "10:30"}               the stamp index of a clock time
    {straddle: {at: "09:20"}}      CE + PE close of the strike that was ATM at that bar's spot
                                   close, nearest expiry; NaN before that bar (its strike is not
                                   known yet) and where option bars are missing
    {rsi: {n: 14, minutes: 5}}     Wilder RSI of the closes of `minutes`-minute bars, continuous
                                   across sessions, held until the next bar completes
    {supertrend: {n: 10, mult: 3, minutes: 5}}
                                   the Supertrend line of `minutes`-minute bars (TradingView's
                                   ta.supertrend: hl2 -/+ mult x Wilder ATR-n, bands that only
                                   tighten), continuous across sessions, held until the next bar
    {supertrend_dir: {n: 10, mult: 3, minutes: 5}}
                                   its direction: +1 up (line below price), -1 down; NaN until
                                   the ATR has n bars. Test it with gt / lt 0
    {bollinger: {n: 20, k: 2, minutes: 5, band: upper}}
                                   the upper / middle / lower Bollinger band of the closes of
                                   `minutes`-minute bars: mean of n -/+ k population standard
                                   deviations (as TradingView), continuous across sessions
    {at_first: {x, when}}          x at the first stamp of the session where `when` holds, held
                                   from then on (NaN before, and all day if it never holds)
    {min_since_first: {x, when}}   the running min / max of x from (inclusive) that first stamp;
    {max_since_first: {x, when}}   NaN before it
    {swing: {kind: high, back: 0, minutes: 5, n: 2}}
                                   the latest (back 0) or the one-before (back 1) confirmed swing
                                   high / low of the session's `minutes`-minute bars: a bar whose
                                   high (low) is strictly above (below) the n bars on each side,
                                   known from the close of the n-th bar after it; NaN before
                                   (BL-166). Swings do not carry across sessions
    {bar_close: 5}                 true only at the stamps where a 5-minute bar completes
                                   (j + 1 is a multiple of 5), so a rule can act on bar closes
    a name from `define:`          an earlier definition of the same rule

Operators (a list of arguments, or a mapping with the named parameters)
    add sub mul div [a, b]     abs [a]   (a one-argument operator may take its expression directly)
    max min [a, b]             the larger / smaller of two numbers (missing if either is)
    gt ge lt le [a, b]         all any [b, ...]          not [b]
    crosses_up [a, b]          a[j-1] < b[j] <= a[j]
    crosses_down [a, b]        a[j-1] > b[j] >= a[j]
    first [b]                  true only at the first stamp of the session where b is true
    ever [b]                   true from the first stamp of the session where b is true on
    lag {x, n}                 x at j-n
    pct_change {x, n}          x[j] / x[j-n] - 1
    roll_max roll_min roll_mean {x, n}     over the n stamps ending at j (NaN until n exist)
    cum_max cum_min {x}                    since the open
    at {x, clock}                          x at that clock stamp, from then on (NaN before)
    max_since min_since {x, from | after}  running extreme from (inclusive) or after (exclusive)
                                           a clock time
    prior_median prior_mean {x, sessions}  of x at the same stamp over the previous sessions
    prev_at {x, clock}                     the previous session's x at that clock stamp,
                                           constant over the session (BL-164); like
                                           prev_close, "previous" is the frame's previous
                                           row, so a session the frame dropped (strict_open:
                                           the Muhurat sessions, three Angel One days in
                                           2026-09) is skipped over
    prev_agg {x, how: max | min}           the previous session's highest / lowest x over its
                                           375 stamps, constant over the session (BL-164)

Trade-relative (only in a rule's `exit_when`, and only under the elementwise operators add sub mul
div abs max min gt ge lt le all any not; each trade evaluates them from its own entry)
    {at_entry: x}                  x at the minute the trade's entry was decided (the minute
                                   before it enters; its close is the entry fill)
    minutes_in_trade               minutes the trade would have been held if it exits the next
                                   minute (1 at the entry minute)

A comparison with a missing value is false. `not` flips that false to true, so guard a `not` with a
comparison on the value it needs. Nothing is interpolated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

N_BARS = 375
OPEN_MIN = 555  # 09:15


class RuleError(ValueError):
    """A rule that cannot be parsed or evaluated; the message names the path to the problem."""


def clock_to_stamp(text: str, path: str = "clock") -> int:
    try:
        hh, mm = text.split(":")
        minutes = int(hh) * 60 + int(mm) - OPEN_MIN
    except (ValueError, AttributeError) as error:
        raise RuleError(f"{path}: {text!r} is not a HH:MM time") from error
    if not 0 <= minutes < N_BARS:
        raise RuleError(f"{path}: {text!r} is outside the 09:15-15:29 session")
    return minutes


def stamp_to_clock(stamp: int) -> str:
    minutes = OPEN_MIN + int(stamp)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# --- the tree -----------------------------------------------------------------------------


@dataclass(eq=False)
class Node:
    op: str
    args: tuple[Any, ...] = ()
    params: dict[str, Any] = field(default_factory=dict)
    kind: str = "num"  # "num" | "bool"
    path: str = "when"
    label: str | None = None  # the `define:` name this node was given, shown in plain words
    trade: bool = False  # reads at_entry / minutes_in_trade: only evaluable per trade

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Node({self.op}, {self.args}, {self.params})"


FEATURES = {
    "open",
    "high",
    "low",
    "close",
    "vix",
    "vix_open",
    "session_open",
    "prev_high",
    "prev_low",
    "prev_close",
    "pivot",
    "r1",
    "s1",
    "atr14",
    "minute",
}

# op -> (parameter names, result kind, argument kind or None for "see rule")
_POSITIONAL: dict[str, tuple[tuple[str, ...], str, str]] = {
    "add": (("a", "b"), "num", "num"),
    "sub": (("a", "b"), "num", "num"),
    "mul": (("a", "b"), "num", "num"),
    "div": (("a", "b"), "num", "num"),
    "max": (("a", "b"), "num", "num"),
    "min": (("a", "b"), "num", "num"),
    "abs": (("a",), "num", "num"),
    "gt": (("a", "b"), "bool", "num"),
    "ge": (("a", "b"), "bool", "num"),
    "lt": (("a", "b"), "bool", "num"),
    "le": (("a", "b"), "bool", "num"),
    "crosses_up": (("a", "b"), "bool", "num"),
    "crosses_down": (("a", "b"), "bool", "num"),
    "not": (("a",), "bool", "bool"),
    "first": (("a",), "bool", "bool"),
    "ever": (("a",), "bool", "bool"),
}
_VARIADIC = {"all", "any"}
# op -> (parameter names, required, result kind); `x` is always a num expression
_PARAMETRIC: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "lag": (("x", "n"), ("x", "n")),
    "pct_change": (("x", "n"), ("x", "n")),
    "roll_max": (("x", "n"), ("x", "n")),
    "roll_min": (("x", "n"), ("x", "n")),
    "roll_mean": (("x", "n"), ("x", "n")),
    "cum_max": (("x",), ("x",)),
    "cum_min": (("x",), ("x",)),
    "at": (("x", "clock"), ("x", "clock")),
    "max_since": (("x", "from", "after"), ("x",)),
    "min_since": (("x", "from", "after"), ("x",)),
    "prior_median": (("x", "sessions"), ("x", "sessions")),
    "prior_mean": (("x", "sessions"), ("x", "sessions")),
    "prev_at": (("x", "clock"), ("x", "clock")),
    "prev_agg": (("x", "how"), ("x", "how")),
}
_LEAF_OPS = {
    "clock",
    "straddle",
    "rsi",
    "bar_close",
    "supertrend",
    "supertrend_dir",
    "bollinger",
    "swing",
}
_SINCE_FIRST = {"at_first", "min_since_first", "max_since_first"}
_TRADE_OPS = {"at_entry"}
#: the operators a trade-relative value may sit under (they work on one session's row alone)
ELEMENTWISE = {"add", "sub", "mul", "div", "abs", "max", "min", "gt", "ge", "lt", "le"} | {
    "all",
    "any",
    "not",
}
TRADE_LEAF = "minutes_in_trade"
EXPIRY_LEAF = "expiry_day"
BANDS = ("upper", "middle", "lower")
ALL_OPS = set(_POSITIONAL) | _VARIADIC | set(_PARAMETRIC) | _LEAF_OPS | _SINCE_FIRST | _TRADE_OPS


def _int_param(value: Any, path: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise RuleError(f"{path}: expected a whole number from {low} to {high}, got {value!r}")
    return value


def _float_param(value: Any, path: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise RuleError(f"{path}: expected a number from {low:g} to {high:g}, got {value!r}")
    return float(value)


def parse(expr: Any, defs: dict[str, Node] | None = None, path: str = "when") -> Node:
    """Turn a YAML / JSON expression into a tree, naming the path of the first problem. A node that
    reads a trade-relative value is marked `trade`; one may sit only under elementwise operators."""
    node = _parse_node(expr, defs, path)
    if node.op in _TRADE_OPS or node.op == TRADE_LEAF:
        node.trade = True
    elif any(isinstance(a, Node) and a.trade for a in node.args):
        if node.op not in ELEMENTWISE:
            raise RuleError(
                f"{path}: at_entry / minutes_in_trade can only be used under "
                f"{', '.join(sorted(ELEMENTWISE))}"
            )
        node.trade = True
    return node


def _parse_node(expr: Any, defs: dict[str, Node] | None, path: str) -> Node:
    defs = defs or {}
    if isinstance(expr, bool):
        raise RuleError(f"{path}: a bare true / false is not an expression")
    if isinstance(expr, (int, float)):
        if isinstance(expr, float) and not np.isfinite(expr):
            raise RuleError(f"{path}: {expr!r} is not a finite number")
        return Node("const", (float(expr),), kind="num", path=path)
    if isinstance(expr, str):
        if expr in defs:
            return defs[expr]
        if expr == TRADE_LEAF:
            return Node(TRADE_LEAF, kind="num", path=path)
        if expr == EXPIRY_LEAF:
            return Node(EXPIRY_LEAF, kind="bool", path=path)
        if expr in FEATURES:
            return Node("feature", (expr,), kind="num", path=path)
        known = ", ".join(sorted(FEATURES | set(defs) | {TRADE_LEAF, EXPIRY_LEAF}))
        raise RuleError(f"{path}: unknown name {expr!r} (known: {known})")
    if not isinstance(expr, dict) or len(expr) != 1:
        raise RuleError(f"{path}: expected a number, a name or a one-key mapping, got {expr!r}")
    ((op, body),) = expr.items()
    here = f"{path}.{op}"
    if op not in ALL_OPS:
        raise RuleError(f"{here}: unknown operator {op!r}")
    if op == "clock":
        stamp = clock_to_stamp(body, here) if isinstance(body, str) else None
        if stamp is None:
            raise RuleError(f"{here}: give a HH:MM string")
        return Node("const", (float(stamp),), kind="num", path=path)
    if op == "straddle":
        at = body.get("at") if isinstance(body, dict) else None
        if not isinstance(at, str) or set(body) != {"at"}:
            raise RuleError(f'{here}: write {{straddle: {{at: "09:20"}}}}')
        return Node("straddle", params={"at": clock_to_stamp(at, here)}, kind="num", path=path)
    if op == "rsi":
        if not isinstance(body, dict) or set(body) - {"n", "minutes"}:
            raise RuleError(f"{here}: write {{rsi: {{n: 14, minutes: 5}}}}")
        n = _int_param(body.get("n", 14), f"{here}.n", 2, 100)
        minutes = _int_param(body.get("minutes", 5), f"{here}.minutes", 1, 125)
        return Node("rsi", params={"n": n, "minutes": minutes}, kind="num", path=path)
    if op in ("supertrend", "supertrend_dir"):
        if not isinstance(body, dict) or set(body) - {"n", "mult", "minutes"}:
            raise RuleError(f"{here}: write {{{op}: {{n: 10, mult: 3, minutes: 5}}}}")
        params = {
            "n": _int_param(body.get("n", 10), f"{here}.n", 1, 100),
            "mult": _float_param(body.get("mult", 3), f"{here}.mult", 0.1, 20),
            "minutes": _int_param(body.get("minutes", 5), f"{here}.minutes", 1, 125),
        }
        return Node(op, params=params, kind="num", path=path)
    if op == "bollinger":
        if not isinstance(body, dict) or set(body) - {"n", "k", "minutes", "band"}:
            example = "{bollinger: {n: 20, k: 2, minutes: 5, band: upper}}"
            raise RuleError(f"{here}: write {example}")
        band = body.get("band", "upper")
        if band not in BANDS:
            raise RuleError(f"{here}.band: expected upper, middle or lower, got {band!r}")
        params = {
            "n": _int_param(body.get("n", 20), f"{here}.n", 2, 200),
            "k": _float_param(body.get("k", 2), f"{here}.k", 0, 10),
            "minutes": _int_param(body.get("minutes", 5), f"{here}.minutes", 1, 125),
            "band": band,
        }
        return Node(op, params=params, kind="num", path=path)
    if op == "swing":
        if not isinstance(body, dict) or set(body) - {"kind", "back", "minutes", "n"}:
            raise RuleError(f"{here}: write {{swing: {{kind: high, back: 0, minutes: 5, n: 2}}}}")
        kind = body.get("kind")
        if kind not in ("high", "low"):
            raise RuleError(f"{here}.kind: expected high or low, got {kind!r}")
        params = {
            "kind": kind,
            "back": _int_param(body.get("back", 0), f"{here}.back", 0, 5),
            "minutes": _int_param(body.get("minutes", 5), f"{here}.minutes", 1, 125),
            "n": _int_param(body.get("n", 2), f"{here}.n", 1, 10),
        }
        return Node(op, params=params, kind="num", path=path)
    if op in _SINCE_FIRST:
        if not isinstance(body, dict) or set(body) != {"x", "when"}:
            raise RuleError(f"{here}: write {{{op}: {{x: ..., when: ...}}}}")
        x = _typed(parse(body["x"], defs, f"{here}.x"), "num", f"{here}.x")
        when = _typed(parse(body["when"], defs, f"{here}.when"), "bool", f"{here}.when")
        return Node(op, (x, when), kind="num", path=path)
    if op == "at_entry":
        x = _typed(parse(body, defs, here), "num", here)
        if x.trade:
            raise RuleError(f"{here}: at_entry cannot hold another trade-relative value")
        return Node(op, (x,), kind="num", path=path)
    if op == "bar_close":
        minutes = body.get("minutes") if isinstance(body, dict) else body
        return Node(
            "bar_close",
            params={"minutes": _int_param(minutes, f"{here}.minutes", 1, 125)},
            kind="bool",
            path=path,
        )
    if op in _VARIADIC:
        if not isinstance(body, list) or not body:
            raise RuleError(f"{here}: give a non-empty list of conditions")
        args = tuple(
            _typed(parse(item, defs, f"{here}[{k}]"), "bool", f"{here}[{k}]")
            for k, item in enumerate(body)
        )
        return Node(op, args, kind="bool", path=path)
    if op in _POSITIONAL:
        names, kind, arg_kind = _POSITIONAL[op]
        items = _as_list(body, names, here)
        args = tuple(
            _typed(parse(item, defs, f"{here}[{k}]"), arg_kind, f"{here}[{k}]")
            for k, item in enumerate(items)
        )
        return Node(op, args, kind=kind, path=path)
    names, required = _PARAMETRIC[op]
    if isinstance(body, list):
        if len(body) > len(names):
            raise RuleError(f"{here}: too many arguments (parameters: {', '.join(names)})")
        body = dict(zip(names, body, strict=False))
    if not isinstance(body, dict) or set(body) - set(names):
        raise RuleError(f"{here}: parameters are {', '.join(names)}")
    for name in required:
        if name not in body:
            raise RuleError(f"{here}: missing {name!r}")
    x = _typed(parse(body["x"], defs, f"{here}.x"), "num", f"{here}.x")
    params: dict[str, Any] = {}
    if "n" in body:
        params["n"] = _int_param(body["n"], f"{here}.n", 1, N_BARS - 1)
    if "sessions" in body:
        params["sessions"] = _int_param(body["sessions"], f"{here}.sessions", 1, 600)
    if "clock" in body:
        params["clock"] = clock_to_stamp(body["clock"], f"{here}.clock")
    if "how" in body:
        if body["how"] not in ("max", "min"):
            raise RuleError(f"{here}.how: expected max or min, got {body['how']!r}")
        params["how"] = body["how"]
    if op in ("max_since", "min_since"):
        if ("from" in body) == ("after" in body):
            raise RuleError(f"{here}: give exactly one of from / after")
        key = "from" if "from" in body else "after"
        params["start"] = clock_to_stamp(body[key], f"{here}.{key}") + (key == "after")
    return Node(op, (x,), params, kind="num", path=path)


def _as_list(body: Any, names: tuple[str, ...], path: str) -> list[Any]:
    if len(names) == 1:  # a one-argument operator may take its expression directly
        if isinstance(body, dict) and set(body) == {"a"}:
            body = [body["a"]]
        items = body if isinstance(body, list) else [body]
        if len(items) != 1:
            raise RuleError(f"{path}: expected 1 argument")
        return items
    if isinstance(body, dict):
        if set(body) != set(names):
            raise RuleError(f"{path}: parameters are {', '.join(names)}")
        return [body[name] for name in names]
    if not isinstance(body, list) or len(body) != len(names):
        raise RuleError(f"{path}: expected {len(names)} argument(s)")
    return body


def _typed(node: Node, kind: str, path: str) -> Node:
    if node.kind != kind:
        raise RuleError(
            f"{path}: expected a {'condition' if kind == 'bool' else 'number'}, "
            f"got a {'condition' if node.kind == 'bool' else 'number'}"
        )
    return node


def parse_rule(when: Any, define: dict[str, Any] | None = None) -> tuple[Node, dict[str, Node]]:
    """Parse `define:` in order (a definition may use the ones before it) and then `when:`."""
    defs: dict[str, Node] = {}
    for name, body in (define or {}).items():
        if name in FEATURES or name in ALL_OPS or name in (TRADE_LEAF, EXPIRY_LEAF):
            raise RuleError(f"define.{name}: the name is already taken")
        defs[name] = parse(body, defs, f"define.{name}")
        if defs[name].label is None:
            defs[name].label = name
    root = parse(when, defs, "when")
    if root.trade:
        raise RuleError("when: at_entry / minutes_in_trade belong in exit_when only")
    if root.kind != "bool":
        raise RuleError("when: a rule's condition must be true / false, not a number")
    return root, defs


# --- the data the evaluator reads ---------------------------------------------------------


@dataclass
class Frame:
    """Index sessions on the 375-minute grid. `straddle_loader(at_stamp)` returns a
    (sessions x 375) array of the ATM straddle, NaN where it cannot be built."""

    days: list[str]
    O: np.ndarray  # noqa: E741, N815
    H: np.ndarray  # noqa: N815
    L: np.ndarray  # noqa: N815
    C: np.ndarray  # noqa: N815
    vix_close: np.ndarray | None = None
    vix_open: np.ndarray | None = None
    straddle_loader: Any = None
    #: () -> (sessions,) bool, the session is its own nearest weekly expiry (`expiry_day`)
    expiry_loader: Any = None
    _cache: dict[Any, np.ndarray] = field(default_factory=dict, repr=False)

    @property
    def n(self) -> int:
        return len(self.days)


def _full(frame: Frame, value: float = np.nan) -> np.ndarray:
    return np.full((frame.n, N_BARS), value, dtype=float)


def _per_session(frame: Frame, values: np.ndarray) -> np.ndarray:
    return np.repeat(values[:, None], N_BARS, axis=1)


def _prev(frame: Frame, series: np.ndarray) -> np.ndarray:
    out = np.full(frame.n, np.nan)
    out[1:] = series[:-1]
    return out


def feature(frame: Frame, name: str) -> np.ndarray:
    H, L, C = frame.H, frame.L, frame.C  # noqa: N806
    day_high, day_low, day_close = H.max(1), L.min(1), C[:, -1]
    if name == "open":
        return frame.O.copy()
    if name == "high":
        return H.copy()
    if name == "low":
        return L.copy()
    if name == "close":
        return C.copy()
    if name == "minute":
        return np.tile(np.arange(N_BARS, dtype=float), (frame.n, 1))
    if name == "session_open":
        return _per_session(frame, frame.O[:, 0])
    if name in ("vix", "vix_open"):
        source = frame.vix_close if name == "vix" else frame.vix_open
        if source is None:
            return _full(frame)
        return source.copy() if name == "vix" else _per_session(frame, source)
    prev_high, prev_low, prev_close = (_prev(frame, a) for a in (day_high, day_low, day_close))
    if name == "prev_high":
        return _per_session(frame, prev_high)
    if name == "prev_low":
        return _per_session(frame, prev_low)
    if name == "prev_close":
        return _per_session(frame, prev_close)
    if name in ("pivot", "r1", "s1"):
        pivot = (prev_high + prev_low + prev_close) / 3
        return _per_session(
            frame,
            {"pivot": pivot, "r1": 2 * pivot - prev_low, "s1": 2 * pivot - prev_high}[name],
        )
    if name == "atr14":
        prev = _prev(frame, day_close)
        tr = np.maximum.reduce(
            [day_high - day_low, np.abs(day_high - prev), np.abs(day_low - prev)]
        )
        atr = np.full(frame.n, np.nan)
        for i in range(14, frame.n):
            atr[i] = np.nanmean(tr[i - 14 : i])
        return _per_session(frame, atr)
    raise RuleError(f"unknown feature {name!r}")


def wilder_rsi(closes: np.ndarray, n: int = 14) -> np.ndarray:
    out = np.full(len(closes), np.nan)
    if len(closes) <= n:
        return out
    d = np.diff(closes)
    au = _wilder_mean(np.maximum(d, 0), n)[n - 1 :]
    ad = _wilder_mean(np.maximum(-d, 0), n)[n - 1 :]
    with np.errstate(divide="ignore", invalid="ignore"):
        out[n:] = np.where(ad > 0, 100 - 100 / (1 + au / ad), 100.0)
    return out


def _wilder_mean(x: np.ndarray, n: int) -> np.ndarray:
    """Wilder's running mean (TradingView's ta.rma): the plain mean of the first n values, then
    (prev x (n-1) + x) / n."""
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    out[n - 1] = x[:n].mean()
    for i in range(n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def supertrend(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = 10, mult: float = 3.0
) -> tuple[np.ndarray, np.ndarray]:
    """(line, direction) of one continuous series of bars, as TradingView's ta.supertrend: the
    first bar with an ATR starts down; direction +1 means up (the line is the lower band)."""
    prev_close = np.concatenate([[np.nan], close[:-1]])
    tr = np.fmax(high - low, np.fmax(np.abs(high - prev_close), np.abs(low - prev_close)))
    atr = _wilder_mean(tr, n)
    mid = (high + low) / 2
    line = np.full(len(close), np.nan)
    direction = np.full(len(close), np.nan)
    lower_prev = upper_prev = np.nan
    dir_prev = 0
    for i in range(len(close)):
        if np.isnan(atr[i]):
            continue
        lower, upper = mid[i] - mult * atr[i], mid[i] + mult * atr[i]
        if dir_prev:
            if not (lower > lower_prev or close[i - 1] < lower_prev):
                lower = lower_prev
            if not (upper < upper_prev or close[i - 1] > upper_prev):
                upper = upper_prev
        if dir_prev == 0:
            d = -1
        elif dir_prev == -1:
            d = 1 if close[i] > upper else -1
        else:
            d = -1 if close[i] < lower else 1
        line[i] = lower if d == 1 else upper
        direction[i] = d
        lower_prev, upper_prev, dir_prev = lower, upper, d
    return line, direction


def bollinger(close: np.ndarray, n: int = 20, k: float = 2.0) -> dict[str, np.ndarray]:
    """{upper, middle, lower} of one continuous series: mean of the last n closes -/+ k population
    standard deviations; NaN until n closes exist."""
    out = {band: np.full(len(close), np.nan) for band in BANDS}
    if len(close) < n:
        return out
    windows = np.lib.stride_tricks.sliding_window_view(close, n)
    mean, sd = windows.mean(axis=1), windows.std(axis=1)
    out["middle"][n - 1 :] = mean
    out["upper"][n - 1 :] = mean + k * sd
    out["lower"][n - 1 :] = mean - k * sd
    return out


def _bars(frame: Frame, m: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(high, low, close) of the complete `m`-minute bars from 09:15, (sessions x 375 // m); a
    session's last part-bar, when m does not divide 375, is left out."""
    nb = N_BARS // m
    cols = nb * m
    shape = (frame.n, nb, m)
    return (
        frame.H[:, :cols].reshape(shape).max(axis=2),
        frame.L[:, :cols].reshape(shape).min(axis=2),
        frame.C[:, m - 1 : cols : m],
    )


def _on_grid(frame: Frame, m: int, values: np.ndarray) -> np.ndarray:
    """Per-bar values (sessions x bars) placed on each bar's last stamp and held until the next."""
    out = _full(frame)
    out[:, m - 1 : values.shape[1] * m : m] = values
    return _ffill(out)


def _indicator(frame: Frame, node: Node) -> np.ndarray:
    p = node.params
    m = p["minutes"]
    if node.op == "bollinger":
        key: tuple[Any, ...] = ("bollinger", p["n"], p["k"], m)
        if key not in frame._cache:
            close = _bars(frame, m)[2]
            bands = bollinger(close.reshape(-1), p["n"], p["k"])
            frame._cache[key] = {b: v.reshape(close.shape) for b, v in bands.items()}
        return _on_grid(frame, m, frame._cache[key][p["band"]])
    key = ("supertrend", p["n"], p["mult"], m)
    if key not in frame._cache:
        high, low, close = _bars(frame, m)
        line, direction = supertrend(
            high.reshape(-1), low.reshape(-1), close.reshape(-1), p["n"], p["mult"]
        )
        frame._cache[key] = {
            "line": line.reshape(close.shape),
            "dir": direction.reshape(close.shape),
        }
    return _on_grid(frame, m, frame._cache[key]["line" if node.op == "supertrend" else "dir"])


def _swing(frame: Frame, node: Node) -> np.ndarray:
    """`{swing: ...}`: per session, the back-th latest confirmed fractal swing, held from the stamp
    its n-th following bar completes until the next swing of that kind is confirmed."""
    p = node.params
    m, n, back = p["minutes"], p["n"], p["back"]
    key = ("swing", p["kind"], m, n)
    if key not in frame._cache:
        high, low, _close = _bars(frame, m)
        bars = high if p["kind"] == "high" else low
        sign = 1.0 if p["kind"] == "high" else -1.0
        found: list[list[tuple[int, float]]] = []
        for row in bars:
            mine = []
            for k in range(n, len(row) - n):
                side = np.concatenate([row[k - n : k], row[k + 1 : k + n + 1]])
                if not np.isnan(row[k]) and bool(np.all(sign * row[k] > sign * side)):
                    mine.append(((k + n + 1) * m - 1, float(row[k])))
            found.append(mine)
        frame._cache[key] = found
    out = _full(frame)
    for s, mine in enumerate(frame._cache[key]):
        for idx in range(back, len(mine)):
            start = mine[idx][0]
            end = mine[idx + 1][0] if idx + 1 < len(mine) else N_BARS
            out[s, start:end] = mine[idx - back][1]
    return out


def _ffill(a: np.ndarray) -> np.ndarray:
    """Hold the last valid value along each row (stamps)."""
    out = a.copy()
    for j in range(1, out.shape[1]):
        gap = np.isnan(out[:, j])
        out[gap, j] = out[gap, j - 1]
    return out


def _lag(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full_like(x, np.nan)
    out[:, n:] = x[:, :-n] if n else x
    return out


def _rolling(x: np.ndarray, n: int, how: str) -> np.ndarray:
    out = np.full_like(x, np.nan)
    reducer = {"max": np.max, "min": np.min, "mean": np.mean}[how]
    for j in range(n - 1, N_BARS):
        out[:, j] = reducer(x[:, j - n + 1 : j + 1], axis=1)
    return out


def _prior(x: np.ndarray, sessions: int, how: str) -> np.ndarray:
    out = np.full_like(x, np.nan)
    reducer = np.nanmedian if how == "median" else np.nanmean
    with np.errstate(all="ignore"):
        for i in range(sessions, x.shape[0]):
            out[i] = reducer(x[i - sessions : i], axis=0)
    return out


def evaluate(node: Node, frame: Frame, memo: dict[Node, np.ndarray] | None = None) -> np.ndarray:
    """The node's value on every (session, stamp): float for numbers, bool for conditions."""
    memo = {} if memo is None else memo
    # Keyed by the node itself (Node is `eq=False`, so by identity), not by `id(node)`: the memo
    # then keeps the node alive, so a freed node's address can't be reused by another node and
    # hit a stale entry.
    if node in memo:
        return memo[node]
    out = _evaluate(node, frame, memo)
    memo[node] = out
    return out


def _evaluate(node: Node, frame: Frame, memo: dict[Node, np.ndarray]) -> np.ndarray:
    op = node.op
    if op == "const":
        return np.full((frame.n, N_BARS), node.args[0], dtype=float)
    if op == "feature":
        return feature(frame, node.args[0])
    if op == "straddle":
        if frame.straddle_loader is None:
            return _full(frame)
        at = node.params["at"]
        out = np.array(frame.straddle_loader(at), dtype=float)  # a copy: the mask below is ours
        # The strike is the one ATM at the close of the `at` bar, so it is not known before that
        # bar: every earlier stamp is unavailable, and a window opening before `at` cannot see it.
        out[:, :at] = np.nan
        return out
    if op == EXPIRY_LEAF:
        if frame.expiry_loader is None:
            raise RuleError(f"{node.path}: expiry_day needs the expiry calendar, not loaded")
        days = np.asarray(frame.expiry_loader(), dtype=bool)
        return np.repeat(days[:, None], N_BARS, axis=1)
    if op == "bar_close":
        m = node.params["minutes"]
        out = np.zeros((frame.n, N_BARS), dtype=bool)
        out[:, m - 1 :: m] = True
        return out
    if op == "rsi":
        m, n = node.params["minutes"], node.params["n"]
        bars = frame.C[:, m - 1 :: m]
        rsi = wilder_rsi(bars.reshape(-1), n).reshape(bars.shape)
        out = _full(frame)
        out[:, m - 1 :: m] = rsi
        return _ffill(out)
    if op in ("supertrend", "supertrend_dir", "bollinger"):
        return _indicator(frame, node)
    if op == "swing":
        return _swing(frame, node)
    if node.trade:
        raise RuleError(f"{node.path}: at_entry / minutes_in_trade belong in exit_when only")
    args = [evaluate(a, frame, memo) for a in node.args]
    if op in ELEMENTWISE:
        return _elementwise(op, args)
    if op in _SINCE_FIRST:
        return _since_first(op, args[0], args[1])
    with np.errstate(invalid="ignore", divide="ignore"):
        if op in ("crosses_up", "crosses_down"):
            a, b = args
            out = np.zeros(a.shape, dtype=bool)
            if op == "crosses_up":
                out[:, 1:] = (a[:, :-1] < b[:, 1:]) & (b[:, 1:] <= a[:, 1:])
            else:
                out[:, 1:] = (a[:, :-1] > b[:, 1:]) & (b[:, 1:] >= a[:, 1:])
            return out
        if op == "first":
            x = args[0]
            out = np.zeros(x.shape, dtype=bool)
            rows = x.any(axis=1)
            out[rows, x[rows].argmax(axis=1)] = True
            return out
        if op == "ever":
            return np.logical_or.accumulate(args[0], axis=1)
        x = args[0]
        if op == "lag":
            return _lag(x, node.params["n"])
        if op == "pct_change":
            return x / _lag(x, node.params["n"]) - 1
        if op in ("roll_max", "roll_min", "roll_mean"):
            return _rolling(x, node.params["n"], op.split("_")[1])
        if op in ("cum_max", "cum_min"):
            out = (
                np.fmax.accumulate(x, axis=1) if op == "cum_max" else np.fmin.accumulate(x, axis=1)
            )
            return out
        if op == "at":
            s = node.params["clock"]
            out = _full(frame)
            out[:, s:] = x[:, s][:, None]
            return out
        if op in ("max_since", "min_since"):
            s = node.params["start"]
            out = _full(frame)
            if s < N_BARS:
                acc = np.fmax if op == "max_since" else np.fmin
                out[:, s:] = acc.accumulate(x[:, s:], axis=1)
            return out
        if op in ("prior_median", "prior_mean"):
            return _prior(x, node.params["sessions"], op.split("_")[1])
        if op == "prev_at":
            return _per_session(frame, _prev(frame, x[:, node.params["clock"]]))
        if op == "prev_agg":
            acc = np.fmax if node.params["how"] == "max" else np.fmin
            return _per_session(frame, _prev(frame, acc.reduce(x, axis=1)))
    raise RuleError(f"{node.path}: cannot evaluate {op!r}")  # pragma: no cover


def _elementwise(op: str, args: list[np.ndarray]) -> np.ndarray:
    """The operators that work stamp by stamp (on the whole grid or on one session's row)."""
    with np.errstate(invalid="ignore", divide="ignore"):
        if op == "add":
            return args[0] + args[1]
        if op == "sub":
            return args[0] - args[1]
        if op == "mul":
            return args[0] * args[1]
        if op == "div":
            return args[0] / args[1]
        if op == "max":
            return np.maximum(args[0], args[1])  # a missing value stays missing
        if op == "min":
            return np.minimum(args[0], args[1])
        if op == "abs":
            return np.abs(args[0])
        if op == "gt":
            return args[0] > args[1]
        if op == "ge":
            return args[0] >= args[1]
        if op == "lt":
            return args[0] < args[1]
        if op == "le":
            return args[0] <= args[1]
        if op == "all":
            return np.logical_and.reduce(args)
        if op == "any":
            return np.logical_or.reduce(args)
        if op == "not":
            return ~args[0]
    raise RuleError(f"{op!r} is not elementwise")  # pragma: no cover


def _since_first(op: str, x: np.ndarray, when: np.ndarray) -> np.ndarray:
    """at_first / min_since_first / max_since_first: from the first stamp `when` holds, per row."""
    has = when.any(axis=1)
    first = np.where(has, when.argmax(axis=1), N_BARS)
    after = np.arange(N_BARS)[None, :] >= first[:, None]
    if op == "at_first":
        value = x[np.arange(x.shape[0]), np.minimum(first, N_BARS - 1)]
        return np.where(after, value[:, None], np.nan)
    masked = np.where(after, x, np.nan)
    acc = np.fmin if op == "min_since_first" else np.fmax
    return np.where(after, acc.accumulate(masked, axis=1), np.nan)


def evaluate_trade(
    node: Node, frame: Frame, row: int, decided: int, memo: dict[Node, np.ndarray]
) -> np.ndarray:
    """One session's row of an exit condition for a trade whose entry was decided at stamp
    `decided` (it enters at `decided` + 1). Parts with no trade-relative value come from the
    whole-grid evaluation (`memo`, shared across trades); the rest are worked out on this row."""
    if not node.trade:
        return evaluate(node, frame, memo)[row]
    if node.op == TRADE_LEAF:
        return (np.arange(N_BARS) - decided).astype(float)
    if node.op == "at_entry":
        value = evaluate(node.args[0], frame, memo)[row, decided] if decided >= 0 else np.nan
        return np.full(N_BARS, value, dtype=float)
    args = [evaluate_trade(a, frame, row, decided, memo) for a in node.args]
    return _elementwise(node.op, args)


def first_firings(
    node: Node, frame: Frame, start: int, stop: int, rows: range | list[int] | None = None
) -> dict[int, int]:
    """{session index: first stamp in [start, stop] where the condition is true}."""
    truth = evaluate(node, frame)
    window = truth[:, start : stop + 1]
    out: dict[int, int] = {}
    for i in rows if rows is not None else range(frame.n):
        hits = np.flatnonzero(window[i])
        if len(hits):
            out[i] = start + int(hits[0])
    return out


# --- plain words ---------------------------------------------------------------------------

_WORDS = {
    "gt": ">",
    "ge": "≥",
    "lt": "<",
    "le": "≤",
    "add": "+",
    "sub": "−",
    "mul": "×",
    "div": "÷",
}


def describe(node: Node, top: bool = True) -> str:
    """The expression read back as a sentence fragment, built from the tree itself. A named
    definition is shown by its name below the top of the tree (`describe_defs` spells it out)."""
    if node.label and not top:
        return node.label
    op = node.op
    if op == "const":
        value = node.args[0]
        return f"{value:g}"
    if op == "feature":
        return node.args[0].replace("_", " ")
    if op == "straddle":
        return f"the ATM straddle from {stamp_to_clock(node.params['at'])}"
    if op == "rsi":
        return f"RSI-{node.params['n']} of {node.params['minutes']}-minute bars"
    if op in ("supertrend", "supertrend_dir"):
        p = node.params
        what = "line" if op == "supertrend" else "direction (+1 up, −1 down)"
        return f"the Supertrend ({p['n']}, {p['mult']:g}) {what} of {p['minutes']}-minute bars"
    if op == "bollinger":
        p = node.params
        return (
            f"the {p['band']} Bollinger band ({p['n']}, {p['k']:g}) of {p['minutes']}-minute bars"
        )
    if op == "swing":
        p = node.params
        which = "latest" if p["back"] == 0 else f"{p['back']} before the latest"
        return f"the {which} swing {p['kind']} ({p['n']} each side, {p['minutes']}-minute bars)"
    if op == "bar_close":
        return f"a {node.params['minutes']}-minute bar has just completed"
    if op == TRADE_LEAF:
        return "minutes in the trade"
    if op == EXPIRY_LEAF:
        return "today is a weekly expiry day"
    kids = [describe(a, False) for a in node.args]
    if op in _WORDS:
        return f"({kids[0]} {_WORDS[op]} {kids[1]})"
    if op == "all":
        text = " and ".join(kids)
        return text if top or len(kids) == 1 else f"({text})"
    if op == "any":
        return "(" + " or ".join(kids) + ")"
    if op == "not":
        return f"not ({kids[0]})"
    if op == "abs":
        return f"|{kids[0]}|"
    if op in ("max", "min"):
        return f"{op}({kids[0]}, {kids[1]})"
    if op == "at_entry":
        return f"{kids[0]} at entry"
    if op == "at_first":
        return f"{kids[0]} when {kids[1]} first held today"
    if op in ("min_since_first", "max_since_first"):
        word = "lowest" if op == "min_since_first" else "highest"
        return f"the {word} {kids[0]} since {kids[1]} first held today"
    if op == "crosses_up":
        return f"{kids[0]} crosses above {kids[1]}"
    if op == "crosses_down":
        return f"{kids[0]} crosses below {kids[1]}"
    if op == "first":
        return f"{kids[0]} for the first time today"
    if op == "ever":
        return f"{kids[0]} at some minute today so far"
    p = node.params
    if op == "lag":
        return f"{kids[0]} {p['n']} minutes ago"
    if op == "pct_change":
        return f"the change in {kids[0]} over {p['n']} minutes"
    if op in ("roll_max", "roll_min", "roll_mean"):
        word = {"roll_max": "highest", "roll_min": "lowest", "roll_mean": "average"}[op]
        return f"the {word} {kids[0]} of the last {p['n']} minutes"
    if op in ("cum_max", "cum_min"):
        return f"the day's {'highest' if op == 'cum_max' else 'lowest'} {kids[0]} so far"
    if op == "at":
        return f"{kids[0]} at {stamp_to_clock(p['clock'])}"
    if op in ("max_since", "min_since"):
        word = "highest" if op == "max_since" else "lowest"
        return f"the {word} {kids[0]} since {stamp_to_clock(p['start'])}"
    if op in ("prior_median", "prior_mean"):
        word = "median" if op == "prior_median" else "average"
        return f"the {word} of {kids[0]} at this minute over the last {p['sessions']} sessions"
    if op == "prev_at":
        return f"the previous session's {kids[0]} at {stamp_to_clock(p['clock'])}"
    if op == "prev_agg":
        word = "highest" if p["how"] == "max" else "lowest"
        return f"the previous session's {word} {kids[0]}"
    return op  # pragma: no cover


def describe_defs(defs: dict[str, Node]) -> list[str]:
    """One sentence per `define:` name, in the order they were written."""
    return [f"{name} means {describe(node)}" for name, node in defs.items()]
