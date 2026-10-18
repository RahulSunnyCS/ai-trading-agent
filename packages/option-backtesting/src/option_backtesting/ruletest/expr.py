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
    {clock: "10:30"}               the stamp index of a clock time
    {straddle: {at: "09:20"}}      CE + PE close of the strike that was ATM at that bar's spot
                                   close, nearest expiry (NaN where option bars are missing)
    {rsi: {n: 14, minutes: 5}}     Wilder RSI of the closes of `minutes`-minute bars, continuous
                                   across sessions, held until the next bar completes
    {bar_close: 5}                 true only at the stamps where a 5-minute bar completes
                                   (j + 1 is a multiple of 5), so a rule can act on bar closes
    a name from `define:`          an earlier definition of the same rule

Operators (a list of arguments, or a mapping with the named parameters)
    add sub mul div [a, b]     abs [a]   (a one-argument operator may take its expression directly)
    gt ge lt le [a, b]         all any [b, ...]          not [b]
    crosses_up [a, b]          a[j-1] < b[j] <= a[j]
    crosses_down [a, b]        a[j-1] > b[j] >= a[j]
    first [b]                  true only at the first stamp of the session where b is true
    lag {x, n}                 x at j-n
    pct_change {x, n}          x[j] / x[j-n] - 1
    roll_max roll_min roll_mean {x, n}     over the n stamps ending at j (NaN until n exist)
    cum_max cum_min {x}                    since the open
    at {x, clock}                          x at that clock stamp, from then on (NaN before)
    max_since min_since {x, from | after}  running extreme from (inclusive) or after (exclusive)
                                           a clock time
    prior_median prior_mean {x, sessions}  of x at the same stamp over the previous sessions

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
    "abs": (("a",), "num", "num"),
    "gt": (("a", "b"), "bool", "num"),
    "ge": (("a", "b"), "bool", "num"),
    "lt": (("a", "b"), "bool", "num"),
    "le": (("a", "b"), "bool", "num"),
    "crosses_up": (("a", "b"), "bool", "num"),
    "crosses_down": (("a", "b"), "bool", "num"),
    "not": (("a",), "bool", "bool"),
    "first": (("a",), "bool", "bool"),
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
}
_LEAF_OPS = {"clock", "straddle", "rsi", "bar_close"}
ALL_OPS = set(_POSITIONAL) | _VARIADIC | set(_PARAMETRIC) | _LEAF_OPS


def _int_param(value: Any, path: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise RuleError(f"{path}: expected a whole number from {low} to {high}, got {value!r}")
    return value


def parse(expr: Any, defs: dict[str, Node] | None = None, path: str = "when") -> Node:
    """Turn a YAML / JSON expression into a tree, naming the path of the first problem."""
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
        if expr in FEATURES:
            return Node("feature", (expr,), kind="num", path=path)
        known = ", ".join(sorted(FEATURES | set(defs)))
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
        if name in FEATURES or name in ALL_OPS:
            raise RuleError(f"define.{name}: the name is already taken")
        defs[name] = parse(body, defs, f"define.{name}")
        if defs[name].label is None:
            defs[name].label = name
    root = parse(when, defs, "when")
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
    up, dn = np.maximum(d, 0), np.maximum(-d, 0)
    au, ad = up[:n].mean(), dn[:n].mean()
    out[n] = 100 - 100 / (1 + au / ad) if ad > 0 else 100.0
    for i in range(n, len(d)):
        au = (au * (n - 1) + up[i]) / n
        ad = (ad * (n - 1) + dn[i]) / n
        out[i + 1] = 100 - 100 / (1 + au / ad) if ad > 0 else 100.0
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


def evaluate(node: Node, frame: Frame, memo: dict[int, np.ndarray] | None = None) -> np.ndarray:
    """The node's value on every (session, stamp): float for numbers, bool for conditions."""
    memo = {} if memo is None else memo
    key = id(node)
    if key in memo:
        return memo[key]
    out = _evaluate(node, frame, memo)
    memo[key] = out
    return out


def _evaluate(node: Node, frame: Frame, memo: dict[int, np.ndarray]) -> np.ndarray:
    op = node.op
    if op == "const":
        return np.full((frame.n, N_BARS), node.args[0], dtype=float)
    if op == "feature":
        return feature(frame, node.args[0])
    if op == "straddle":
        if frame.straddle_loader is None:
            return _full(frame)
        return np.asarray(frame.straddle_loader(node.params["at"]), dtype=float)
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
    args = [evaluate(a, frame, memo) for a in node.args]
    with np.errstate(invalid="ignore", divide="ignore"):
        if op == "add":
            return args[0] + args[1]
        if op == "sub":
            return args[0] - args[1]
        if op == "mul":
            return args[0] * args[1]
        if op == "div":
            return args[0] / args[1]
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
    raise RuleError(f"{node.path}: cannot evaluate {op!r}")  # pragma: no cover


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
    if op == "bar_close":
        return f"a {node.params['minutes']}-minute bar has just completed"
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
    if op == "crosses_up":
        return f"{kids[0]} crosses above {kids[1]}"
    if op == "crosses_down":
        return f"{kids[0]} crosses below {kids[1]}"
    if op == "first":
        return f"{kids[0]} for the first time today"
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
    return op  # pragma: no cover


def describe_defs(defs: dict[str, Node]) -> list[str]:
    """One sentence per `define:` name, in the order they were written."""
    return [f"{name} means {describe(node)}" for name, node in defs.items()]
