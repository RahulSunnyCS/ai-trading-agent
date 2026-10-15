"""BL-104 (2026-10-16, owner-directed): expiry-day and non-expiry-day lists for every Core-298 family.

For each family (N_wide, N_p80, N_p100, S_wide, S_p250, S_p320, N_dir, N_ditm1, S_dir, S_ditm1,
N_buy, S_buy), each of the 7 sampled entry times and each day type, keep the default unless settings
clear the rule registered in BL-104 → Experiments ("day-type lists", Amendment 1). The family keeps
its own strike; every other parameter varies over the Stage 1 grid. Writes the two lists under
results/daytype/, one strategy file per pick under strategies/daytype/{expiry,non_expiry}/, and the
readable lists in strategies/daytype/README.md. The schema has no day filter: a file trades every day
if run, and the day type lives in its folder and name.

    uv run python research/bl104/daytype_lists.py                  # the lists (after every run)
Amendment 4 (owner, 2026-10-16): one setting per family and day type that works across all 7 entry
times (time-generic), never a per-slot pick.
    uv run python research/bl104/daytype_lists.py --refine-cells   # after premium_coarse: refine cells
"""

from __future__ import annotations

import csv
import json
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402

from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise  # noqa: E402
from option_backtesting.rotation.readout import max_drawdown  # noqa: E402

PACKAGE = HERE.parents[1]
RESULTS = HERE / "results"
OUT = RESULTS / "daytype"
STRATEGIES = PACKAGE / "strategies" / "daytype"
REFERENCE = PACKAGE / "src" / "option_backtesting" / "data" / "reference"
CUT = date(2025, 10, 9)  # first year < CUT <= test year
MARGIN = {"expiry": 25.0, "other": 15.0, "all": 15.0}
WORST_X = 1.25
MAX_CORR = 0.7
KINDS = {"expiry": ("expiry", "EXP"), "other": ("non_expiry", "NONEXP"), "all": ("all_days", "ALL")}
HALF = date(2025, 4, 9)  # with WINDOW "first": the first year is split here for the both-halves rule
WINDOW: str | None = None  # "first" = selection on the first year only (BL-107)
R1 = ("cost", 1, None)
OWNER_DEFAULT = {  # N_wide only (owner, 2026-10-15)
    "expiry": {"strike": "OTM1", "sl": 150, "trail": (25, 15), "mtm": 4000, "exit": "15:28", "reentry": R1},
    "other": {"strike": "OTM1", "sl": 60, "trail": (15, 10), "mtm": 3000, "exit": "15:28", "reentry": None},
}
FAMILY_TEXT = {
    "W": "Widesl (short strangle, wide SL)",
    "D": "Directional (short straddle, tight SL)",
    "B": "Buy (range breakout)",
}


@dataclass(frozen=True)
class Family:
    name: str
    fam: str  # W | D | B
    idx: str  # N | S
    strike: Any  # the family's own strike; for a premium family, the coarse premiums (₹)
    templates: tuple[tuple[str, str, dict | None], ...]  # (rotation name, tag, params) comparators
    premiums: tuple[float, ...] = ()  # non-empty = a premium family (Amendment 2)

    @property
    def is_premium(self) -> bool:
        return bool(self.premiums)


FAMILIES = [
    Family("N_wide", "W", "N", "OTM1", (("N_wide", None, None),)),
    Family("NIFTY_Widesl_premium", "W", "N", None,
           (("N_p80", None, {"strike": 80}), ("N_p100", None, {"strike": "PHIGH"})),
           (40, 60, 80, 100, 120, 150)),
    Family("S_wide", "W", "S", "OTM2", (("S_wide", None, None),)),
    Family("SENSEX_Widesl_premium", "W", "S", None,
           (("S_p250", None, {"strike": 250}), ("S_p320", None, {"strike": "PHIGH"})),
           (100, 150, 200, 250, 320, 400)),
    Family("N_dir", "D", "N", "ATM", (("N_dir", None, None),)),
    Family("N_ditm1", "D", "N", "ITM1", (("N_ditm1", None, {"strike": "ITM1"}),)),
    Family("S_dir", "D", "S", "ATM", (("S_dir", None, None),)),
    Family("S_ditm1", "D", "S", "ITM1", (("S_ditm1", None, {"strike": "ITM1"}),)),
    Family("NIFTY_Buy_premium", "B", "N", None, (("N_buy", None, None),), (20, 30, 50, 75, 100)),
    Family("SENSEX_Buy_premium", "B", "S", None, (("S_buy", None, None),), (30, 50, 90, 150, 225)),
]
TAGS = ("stage1", "daytype", "premium_coarse", "premium_refine", "slots12")  # searched in order
PREMIUM_DUP_CORR = 0.9  # Amendment 2: a later premium pick is dropped only as a near-duplicate
GRID_STRIKE_FOR_OFFGRID = {"W": "OTM1", "B": "ATM"}  # how the off-grid cells were generated


def key(p: dict | None) -> str:
    return json.dumps(p, default=list)


def expiries() -> dict[str, set[date]]:
    out: dict[str, set[date]] = {"NIFTY": set(), "SENSEX": set()}
    with (REFERENCE / "expiries_observed.csv").open(newline="") as h:
        for r in csv.DictReader(h):
            if r["underlying"] in out:
                out[r["underlying"]].add(date.fromisoformat(r["expiry"]))
    return out


_SERIES: dict[tuple[str, str], tuple[list[date], dict[str, int], np.ndarray]] = {}


def series(tag: str, cohort: str) -> tuple[list[date], dict[str, int], np.ndarray]:
    if (tag, cohort) not in _SERIES:
        base = RESULTS / tag / "series" / cohort
        meta = json.loads(base.with_suffix(".json").read_text())
        m = np.load(base.with_suffix(".npy")).astype(float)
        days = [date.fromisoformat(d) for d in meta["days"]]
        keep = [i for i, d in enumerate(days) if d.weekday() < 5]
        _SERIES[(tag, cohort)] = (
            [days[i] for i in keep],
            {lab: i for i, lab in enumerate(meta["labels"])},
            m[keep],
        )
    return _SERIES[(tag, cohort)]


def column(tag: str | None, f: Family, slot: str, params: dict | None) -> tuple[list[date], np.ndarray]:
    """A cell's series; `tag` None = the first results tag that holds it."""
    cell = grid.Cell(f.fam, f.idx, slot, params)
    if tag is None:
        tag = next((t for t in TAGS if _has(t, f, slot, params)), None)
        if tag is None:
            raise KeyError(f"no stored series for {cell.label}")
    days, col, m = series(tag, cell.cohort)
    return days, m[:, col[cell.label]]


def _has(tag: str, f: Family, slot: str, params: dict) -> bool:
    cell = grid.Cell(f.fam, f.idx, slot, params)
    base = RESULTS / tag / "series" / f"{cell.cohort}.json"
    if not base.exists():
        return False
    _, col, _ = series(tag, cell.cohort)
    return cell.label in col


def refined_premiums(f: Family, slot: str) -> list[float]:
    """Premiums the refine run added for this family and slot (read from its cells file)."""
    path = HERE / "premium_refine_cells_2026-10-16.json"
    if not path.exists():
        return []
    vals = {
        c["params"]["strike"] for c in json.loads(path.read_text())
        if c["family"] == f.fam and c["index"] == f.idx and c["slot"] == slot
    }
    return sorted(vals)


def candidates(f: Family, slot: str) -> list[tuple[dict, str, dict]]:
    """(params as described, tag, params as stored) for every setting of the family."""
    out = []
    base_strike = {"W": "OTM1", "B": "ATM"}.get(f.fam)
    grid_names = {v: k for k, v in grid.PREMIUM.get(f.fam, {}).get(grid.INDICES[f.idx], {}).items()}
    premiums = sorted(set(f.premiums) | set(refined_premiums(f, slot))) if f.is_premium else []
    for c in grid.cells(f.fam, f.idx, slot, with_template=False):
        p = c.params
        if f.fam in ("W", "D") and p["mtm"] is None:
            continue
        if not f.is_premium:
            if p["strike"] == f.strike:
                out.append((p, None, p))
            continue
        if p["strike"] != base_strike:
            continue
        for pr in premiums:
            described = {**p, "strike": pr}
            stored = {**p, "strike": grid_names[pr]} if pr in grid_names else described
            tag = next((t for t in TAGS if _has(t, f, slot, stored)), None)
            if tag is not None:
                out.append((described, tag, stored))
    return out


def neighbours(f: Family, p: dict) -> list[dict]:
    out = []
    for axis, chains in grid.CHAINS[f.fam].items():
        if axis == "strike":
            continue
        for chain in chains:
            if p[axis] in chain:
                i = chain.index(p[axis])
                for j in (i - 1, i + 1):
                    if 0 <= j < len(chain) and not (axis == "mtm" and chain[j] is None and f.fam != "B"):
                        out.append({**p, axis: chain[j]})
    return out


# -- readable descriptions, read from the built strategy -------------------------------------


def _legs(values: list[str]) -> str:
    return values[0] if len(set(values)) == 1 else " / ".join(
        f"{side} {v}" for side, v in zip(("CE", "PE"), values, strict=False)
    )


def _amount(a) -> str:
    if a is None:
        return "none"
    return f"{a.percent:g}%" if a.percent is not None else f"{a.points:g} pts"


def _trail(t) -> str:
    if t is None:
        return "none"
    if t.percent is not None:
        return f"{t.percent[0]:g}%/{t.percent[1]:g}%"
    return f"{t.points[0]:g}/{t.points[1]:g} pts"


def _strike(s) -> str:
    return s.strike_type if s.strike_type else f"closest premium ₹{s.closest_premium:g}"


def describe(st: LegwiseStrategy, fam: str) -> dict[str, str]:
    legs = st.legs
    re = legs[0].reentry_on_sl
    reentry = "none" if re is None else f"{re.mode.upper()} ×{re.count}"
    if re is not None:
        reentry += f", cutoff {st.no_reentry_after}" if st.no_reentry_after else ", no cutoff"
    d = {
        "index": st.underlying,
        "strategy": FAMILY_TEXT[fam],
        "strike": _legs([_strike(x.strike) for x in legs]),
        "entry": st.entry_time,
        "exit": st.exit_time,
        "leg SL": _legs([_amount(x.stop_loss) for x in legs]),
        "trail SL": _legs([_trail(x.trail_sl) for x in legs]),
        "MTM SL": "none" if st.overall.stop_loss_inr is None else f"₹{st.overall.stop_loss_inr:,.0f}",
        "target": _legs([_amount(x.target) for x in legs]),
        "re-entry": reentry,
        "square-off": st.square_off,
    }
    rb = legs[0].range_breakout
    if rb is not None:
        d["range"] = (
            f"until {rb.until} on {rb.source}, {rb.side} side, gap {rb.gap_percent:g}%"
            + (f", valid until {rb.valid_until}" if rb.valid_until else "")
        )
    return d


def one_line(d: dict[str, str]) -> str:
    keys = ["index", "strategy", "strike", "entry", "range", "leg SL", "trail SL", "MTM SL",
            "target", "re-entry", "exit", "square-off"]
    return " · ".join(f"{k} {d[k]}" if k not in ("index", "strategy") else d[k] for k in keys if k in d)


def file_stem(f: Family, slot: str, kind: str, st: LegwiseStrategy) -> str:
    leg = st.legs[0]
    s = leg.strike
    strike = s.strike_type.lower() if s.strike_type else f"p{s.closest_premium:g}"
    amt = lambda a: "none" if a is None else (f"{a.percent:g}" if a.percent is not None else f"{a.points:g}pt")  # noqa: E731
    tr = leg.trail_sl
    trail = "none" if tr is None else ("-".join(f"{v:g}" for v in (tr.percent or tr.points)) + ("" if tr.percent else "pt"))
    re = leg.reentry_on_sl
    reentry = "none" if re is None else f"{re.mode}{re.count}" + (f"-cut{st.no_reentry_after.replace(':', '')}" if st.no_reentry_after else "")
    mtm = "none" if st.overall.stop_loss_inr is None else f"{st.overall.stop_loss_inr:g}"
    parts = [f.name, slot.replace(":", ""), KINDS[kind][1], strike]
    if leg.range_breakout is not None:
        rb = leg.range_breakout
        parts.append(f"range{rb.until.replace(':', '')}-{rb.source}")
    parts += [f"sl{amt(leg.stop_loss)}", f"tsl{trail}", f"mtm{mtm}", f"tgt{amt(leg.target)}",
              f"re{reentry}", f"exit{st.exit_time.replace(':', '')}"]
    return "_".join(parts)


def build(f: Family, slot: str, params: dict | None) -> LegwiseStrategy:
    return grid.build(grid.Cell(f.fam, f.idx, slot, params))


def evaluate(f: Family, slot: str, exp: set[date]) -> dict[str, Any]:
    tdays = None
    tvals = {}
    for name, tag, params in f.templates:
        days, v = column(tag, f, slot, params)
        if tdays is None:
            tdays = days
        elif days != tdays:
            pos = {d: i for i, d in enumerate(days)}
            v = np.array([v[pos[d]] for d in tdays])
        tvals[name] = v
    cands = candidates(f, slot)
    vals = {}
    for described, tag, stored in cands:
        days, v = column(tag, f, slot, stored)
        if days != tdays:
            pos = {d: i for i, d in enumerate(days)}
            v = np.array([v[pos[d]] for d in tdays])
        vals[key(described)] = v
    d = np.array(tdays)
    first = d < CUT
    if WINDOW == "first":  # BL-107: nothing from the test year is read
        tvals = {n: v[first] for n, v in tvals.items()}
        vals = {k: v[first] for k, v in vals.items()}
        tdays = [x for x, k in zip(tdays, first, strict=True) if k]
        d = d[first]
        first = d < HALF  # "both years positive" becomes "both halves of the first year positive"
    is_exp = np.array([x in exp for x in tdays])
    out = {}
    for kind, mask in (("expiry", is_exp), ("other", ~is_exp), ("all", np.ones(len(is_exp), dtype=bool))):
        # comparator: the better of the family's current files on these days (Amendment 2)
        tname = max(tvals, key=lambda n: tvals[n][mask].mean())
        t = tvals[tname][mask]
        tparams = next(p for n, _, p in f.templates if n == tname)
        fy = first[mask]
        rows = {}
        for described, _, _ in cands:
            c = vals[key(described)][mask]
            g = c - t
            rows[key(described)] = {
                "params": described, "values": c, "net": float(c.mean()), "gain": float(g.mean()),
                "gain_first": float(g[fy].mean()), "gain_test": float(g[~fy].mean()),
                "net_first": float(c[fy].mean()), "net_test": float(c[~fy].mean()),
                "worst": float(c.min()),
                "worst_x": float(c.min() / t.min()) if t.min() < 0 else float("nan"),
            }
        for r in rows.values():
            nb = [rows[key(q)] for q in neighbours(f, r["params"]) if key(q) in rows]
            r["nb_beat"] = sum(x["gain"] > 0 for x in nb)
        tmpl = {
            "params": tparams, "name": tname, "values": t, "net": float(t.mean()), "gain": 0.0,
            "gain_first": 0.0, "gain_test": 0.0, "net_first": float(t[fy].mean()),
            "net_test": float(t[~fy].mean()), "worst": float(t.min()), "worst_x": 1.0,
            "nb_beat": 0, "is_template": True,
        }
        out[kind] = {"rows": rows, "template": tmpl, "n_days": int(mask.sum()),
                     "n_first": int(fy.sum())}
    return out


ALL_SLOTS = (  # Amendment 8: four per band
    "09:17", "09:32", "09:47", "10:17",
    "10:47", "11:32", "12:17", "13:02",
    "13:17", "13:47", "14:02", "14:32",
)
BANDS = {
    "09:15-10:30": ALL_SLOTS[0:4],
    "10:30-13:00": ALL_SLOTS[4:8],
    "13:00-15:30": ALL_SLOTS[8:12],
    "all times": ALL_SLOTS,  # Amendment 6: the best across every time, no band
}


def slots_needed(n: int) -> int:
    """All 12 times: 9 of 12. A band of four: 3 of 4 (all but one). Fewer: all (Amendment 8)."""
    if n == len(ALL_SLOTS):
        return 9
    return n - 1 if n >= 3 else n


def aggregate(f: Family, results: dict[str, dict], kind: str, slots: tuple[str, ...]) -> dict[str, dict]:
    """Amendment 4: every setting across the 7 slots — slot-mean gain, per-slot gains, both-year
    slot-mean gains, slot-mean worst-day ratio, and the slot-mean daily P&L (for correlations)."""
    agg: dict[str, dict] = {}
    keys = set.intersection(*(set(results[s][kind]["rows"]) for s in slots))
    for k in keys:
        per = [results[s][kind]["rows"][k] for s in slots]
        wx = [r["worst_x"] for r in per if r["worst_x"] == r["worst_x"]]
        agg[k] = {
            "params": per[0]["params"],
            "slot_gain": [r["gain"] for r in per],
            "slot_gain_first": [r["gain_first"] for r in per],
            "slot_net": [r["net"] for r in per],
            "gain": float(np.mean([r["gain"] for r in per])),
            "gain_first": float(np.mean([r["gain_first"] for r in per])),
            "gain_test": float(np.mean([r["gain_test"] for r in per])),
            "net": float(np.mean([r["net"] for r in per])),
            "net_first": float(np.mean([r["net_first"] for r in per])),
            "net_test": float(np.mean([r["net_test"] for r in per])),
            "worst_x": float(np.mean(wx)) if wx else float("nan"),
            "slots_pos": sum(r["gain"] > 0 for r in per),
            "values": np.mean([r["values"] for r in per], axis=0),
            "slots": slots,
            "max_dd": float(np.mean([max_drawdown(r["values"]) for r in per])),
            "win": float(np.mean([np.mean(r["values"] > 0) for r in per])),
            "worst": float(np.mean([r["worst"] for r in per])),
        }
    for r in agg.values():
        nb = [agg[key(q)] for q in neighbours(f, r["params"]) if key(q) in agg]
        r["nb_beat"] = sum(x["gain"] > 0 for x in nb)
        r["nb_beat_first"] = sum(x["gain_first"] > 0 for x in nb)
        r["slots_pos_first"] = sum(g > 0 for g in r["slot_gain_first"])
    t = [results[s][kind]["template"] for s in slots]
    agg["__template__"] = {
        "params": "template", "slot_gain": [0.0] * len(t), "slot_net": [x["net"] for x in t],
        "gain": 0.0, "gain_first": 0.0, "gain_test": 0.0,
        "net": float(np.mean([x["net"] for x in t])),
        "net_first": float(np.mean([x["net_first"] for x in t])),
        "net_test": float(np.mean([x["net_test"] for x in t])),
        "worst_x": 1.0, "slots_pos": 0, "nb_beat": 0, "is_template": True,
        "slot_gain_first": [0.0] * len(t), "slots_pos_first": 0, "nb_beat_first": 0,
        "values": np.mean([x["values"] for x in t], axis=0),
        "names": [x["name"] for x in t], "slots": slots,
        "max_dd": float(np.mean([max_drawdown(x["values"]) for x in t])),
        "win": float(np.mean([np.mean(x["values"] > 0) for x in t])),
        "worst": float(np.mean([x["worst"] for x in t])),
    }
    return agg


def premium_scores(agg: dict[str, dict]) -> dict[float, float]:
    """A premium's score is its best setting's slot-mean gain over the template in period 1 (the first
    year; with WINDOW "first", the first half of it) — Amendment 10: ranking reads period 1 only."""
    score: dict[float, float] = {}
    for k, r in agg.items():
        if k == "__template__":
            continue
        pr = r["params"]["strike"]
        score[pr] = max(score.get(pr, -1e18), r["gain_first"])
    return score


def family_premiums(agg: dict[str, dict]) -> tuple[list[float], dict[float, float]]:
    """Top three premiums by score; a later one dropped when its best setting's slot-mean daily
    P&L correlates >= 0.9 with a kept one's (a near-duplicate)."""
    score = premium_scores(agg)
    best = {}
    for k, r in agg.items():
        if k == "__template__":
            continue
        pr = r["params"]["strike"]
        if pr not in best or r["gain_first"] > best[pr]["gain_first"]:
            best[pr] = r
    kept: list[float] = []
    for pr in sorted(score, key=lambda p: -score[p]):
        if any(float(np.corrcoef(best[k]["values"], best[pr]["values"])[0, 1]) >= PREMIUM_DUP_CORR for k in kept):
            continue
        kept.append(pr)
        if len(kept) == 3:
            break
    return kept, score


TOP_RANKS = 3  # Amendment 10: walk at most to the third-ranked setting


def decide(f: Family, agg: dict[str, dict], kind: str, allowed: list[float] | None) -> dict[str, Any]:
    """Amendment 10 (owner, 2026-10-16): rank on period 1, walk ranks 1 → 3, take the first that also
    beats the template in period 2. Period 1 / 2 = first / second year (the lists), or the first /
    second half of the first year (WINDOW "first", BL-107: the test year is never read)."""
    tmpl = agg["__template__"]
    dflt = agg[key(OWNER_DEFAULT[kind])] if f.name == "N_wide" and kind in OWNER_DEFAULT else tmpl

    def eligible(r: dict) -> bool:  # period-1 conditions only
        return (
            r is not dflt and not r.get("is_template")
            and r["gain_first"] > 0
            and r["gain_first"] >= dflt["gain_first"] + MARGIN[kind]
            and r["slots_pos_first"] >= slots_needed(len(r["slots"]))
            and not (r["worst_x"] > WORST_X) and r["nb_beat_first"] >= 2
        )

    def walk(pool: list[dict]) -> tuple[dict | None, int, list[dict]]:
        ranked = sorted(pool, key=lambda r: -r["gain_first"])[:TOP_RANKS]
        for i, r in enumerate(ranked, 1):
            if r["gain_test"] > 0:  # beats the template in period 2 as well
                return r, i, ranked
        return None, 0, ranked

    pool = [r for r in agg.values() if eligible(r)]
    if f.is_premium and allowed is not None:
        picks: list[dict] = []
        for pr in allowed:
            r, rank, _ = walk([x for x in pool if x["params"]["strike"] == pr])
            if r is not None:
                r["rank_used"] = rank
                if picks:
                    r["corr_with_first"] = float(np.corrcoef(picks[0]["values"], r["values"])[0, 1])
                picks.append(r)
        if picks:
            return {"status": f"chosen ({len(picks)} premium{'s' if len(picks) > 1 else ''})", "picks": picks,
                    "alts": [], "n_clear": len(pool)}
    else:
        first, rank, ranked = walk(pool)
        if first is not None:
            first["rank_used"] = rank
            picks = [first]
            for r in ranked[rank:]:
                if r["gain_test"] > 0:
                    c = float(np.corrcoef(first["values"], r["values"])[0, 1])
                    if c < MAX_CORR:
                        r["corr_with_first"] = c
                        r["rank_used"] = ranked.index(r) + 1
                        picks.append(r)
                        break
            return {"status": "chosen" if len(picks) == 1 else "chosen (2, low correlation)", "picks": picks,
                    "alts": [], "n_clear": len(pool)}
    if dflt["gain_first"] < 0 and dflt["gain_test"] < 0:
        top = sorted((r for r in agg.values() if not r.get("is_template")), key=lambda r: -r["gain"])[:3]
        return {"status": "owner to choose", "picks": [dflt], "alts": top, "n_clear": 0}
    return {"status": "default (template)" if dflt is tmpl else "default (owner setting)", "picks": [dflt],
            "alts": [], "n_clear": 0}


def write_yaml(f: Family, slot: str, kind: str, st: LegwiseStrategy, status: str, text: str) -> Path:
    stem = file_stem(f, slot, kind, st)
    path = STRATEGIES / KINDS[kind][0] / f"{stem}.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    st = st.model_copy(deep=True)
    st.id = stem
    day = "weekly EXPIRY days only" if kind == "expiry" else "NON-expiry days only"
    head = (
        f"# BL-104 day-type list ({status}) — {st.underlying} {day}; one setting for every entry time.\n"
        f"# {text}\n"
        "# The schema has no day filter: this file trades every day if run. Research lead, not adopted.\n"
        "# Generated by packages/option-backtesting/research/bl104/daytype_lists.py.\n"
    )
    body = yaml.safe_dump({"strategy": st.model_dump(mode="json", exclude_none=True)}, sort_keys=False,
                          allow_unicode=True)
    path.write_text(head + body)
    assert load_legwise(path).model_dump() == st.model_dump(), path
    return path


def refine_cells() -> None:
    """Refine step (Amendments 3–4): per premium family and day type, the coarse premium with the
    best time-generic score is the area; add the midpoints to its coarse neighbours (₹5 rounding),
    or one step beyond at an end of the range; the union over the two day types, all 7 slots."""
    exp = expiries()
    out, report = [], []
    for f in (x for x in FAMILIES if x.is_premium):
        coarse = sorted(f.premiums)
        base_strike = {"W": "OTM1", "B": "ATM"}[f.fam]
        results = {slot: evaluate(f, slot, exp[grid.INDICES[f.idx]]) for slot in ALL_SLOTS}
        new: set[float] = set()
        for kind, (band, slots) in ((k, b) for k in KINDS for b in BANDS.items()):
            score = premium_scores(aggregate(f, results, kind, slots))
            area = max((p for p in score if p in coarse), key=score.get)
            i = coarse.index(area)
            lo = 5 * round((area + coarse[i - 1]) / 10) if i > 0 else max(5, 5 * round((2 * area - coarse[1]) / 5))
            hi = (5 * round((area + coarse[i + 1]) / 10) if i < len(coarse) - 1
                  else 5 * round((2 * area - coarse[-2]) / 5))
            pts = [x for x in (lo, hi) if x not in coarse and x > 0]
            new |= set(pts)
            report.append(f"{f.name} {kind} {band}: scores " + ", ".join(f"₹{p:g} {score[p]:+.0f}" for p in sorted(score))
                          + f" -> area ₹{area:g}, add {pts}")
        for slot in ALL_SLOTS:
            for c in grid.cells(f.fam, f.idx, slot, with_template=False):
                prm = c.params
                if prm["strike"] != base_strike or (f.fam == "W" and prm["mtm"] is None):
                    continue
                for pr in sorted(new):
                    out.append({"family": f.fam, "index": f.idx, "slot": slot, "params": {**prm, "strike": pr}})
    path = HERE / "premium_refine_cells_2026-10-16.json"
    path.write_text(json.dumps(out, default=list))
    print("\n".join(report))
    print(f"wrote {len(out)} cells to {path.name}")


def describe_params(f: Family, params: Any, slots: tuple[str, ...] = ALL_SLOTS) -> dict[str, str]:
    st = build(f, slots[0], None if params == "template" else params)
    d = describe(st, f.fam)
    d["entry"] = ", ".join(slots)
    return d


def main() -> None:
    global WINDOW, OUT
    if "--refine-cells" in sys.argv:
        refine_cells()
        return
    write = True
    if "--window" in sys.argv:
        WINDOW = sys.argv[sys.argv.index("--window") + 1]
        assert WINDOW == "first"
        OUT = RESULTS / "daytype_fy"
        write = False  # selection only: no strategy files, no README
    exp = expiries()
    OUT.mkdir(parents=True, exist_ok=True)
    winners: list[dict] = []
    for kind in KINDS if write else ():
        folder = STRATEGIES / KINDS[kind][0]
        if folder.exists():
            for old in folder.glob("*.yaml"):
                old.unlink()
    lists: dict[str, list[dict]] = {k: [] for k in KINDS}
    premium_report: list[str] = []
    for f in FAMILIES:
        results = {slot: evaluate(f, slot, exp[grid.INDICES[f.idx]]) for slot in ALL_SLOTS}
        aggs: dict[tuple[str, str], dict] = {}
        for kind, (band, slots) in ((k, b) for k in KINDS for b in BANDS.items()):
            agg = aggregate(f, results, kind, slots)
            aggs[(kind, band)] = agg
            allowed = None
            if f.is_premium:
                allowed, score = family_premiums(agg)
                kept = ", ".join(f"₹{p:g}" for p in allowed)
                premium_report.append(
                    f"{f.name} {KINDS[kind][0]} {band}: premiums kept {kept}; best band gain by premium "
                    + ", ".join(f"₹{p:g} {score[p]:+.0f}" for p in sorted(score))
                )
            dec = decide(f, agg, kind, allowed)
            tmpl = agg["__template__"]
            for rank, r in enumerate(dec["picks"], 1):
                params = None if r.get("is_template") else r["params"]
                files = []
                winners.append({
                    "family": f.name, "fam": f.fam, "index": f.idx, "kind": kind, "band": band,
                    "rank": rank, "status": dec["status"], "params": params, "rank_used": r.get("rank_used", ""),
                    "gain": r["gain"], "gain_first": r["gain_first"], "gain_test": r["gain_test"],
                })
                for slot in slots if write else ():
                    st = build(f, slot, params if params is not None else _template_params(f, results, slot, kind))
                    text = one_line(describe(st, f.fam))
                    files.append(str(write_yaml(f, slot, kind, st, dec["status"], text).relative_to(PACKAGE)))
                desc = describe_params(f, params if params is not None else "template", slots)
                lists[kind].append({
                    "family": f.name, "band": band, "pick": rank, "status": dec["status"], **desc,
                    "net_per_lot_day": round(r["net"]), "net_first_year": round(r["net_first"]),
                    "net_test_year": round(r["net_test"]),
                    "template_net": round(tmpl["net"]), "template_first_year": round(tmpl["net_first"]),
                    "template_test_year": round(tmpl["net_test"]),
                    "gain_vs_template": round(r["gain"]), "gain_first_year": round(r["gain_first"]),
                    "gain_test_year": round(r["gain_test"]),
                    "slots_better": f"{r['slots_pos']}/{len(slots)}",
                    "gain_by_slot": ", ".join(f"{s} {g:+.0f}" for s, g in zip(slots, r["slot_gain"], strict=True)),
                    "net_by_slot": ", ".join(f"{s} {g:.0f}" for s, g in zip(slots, r["slot_net"], strict=True)),
                    "worst_day_x_template": round(r["worst_x"], 2),
                    "win_rate": round(r["win"], 3), "max_drawdown": round(r["max_dd"]),
                    "worst_day": round(r["worst"]), "template_max_drawdown": round(tmpl["max_dd"]),
                    "gain_on_expiry_days": "" if kind != "all" or params is None else round(
                        aggs_lookup(f, results, "expiry", slots, params)),
                    "gain_on_non_expiry_days": "" if kind != "all" or params is None else round(
                        aggs_lookup(f, results, "other", slots, params)),
                    "corr_with_pick_1": "" if rank == 1 else round(r.get("corr_with_first", float("nan")), 2),
                    "rank_used": r.get("rank_used", ""),
                    "settings_clearing_rule": dec["n_clear"],
                    "alternatives": " || ".join(
                        f"{one_line(describe_params(f, a['params'], slots))} (gain {a['gain']:+.0f}; "
                        f"{a['gain_first']:+.0f} / {a['gain_test']:+.0f}; {a['slots_pos']}/{len(slots)} slots)"
                        for a in dec["alts"]
                    ),
                    "comparator": ", ".join(sorted(set(tmpl["names"]))),
                    "files": " ".join(files),
                })
    for kind, rows in lists.items():
        with (OUT / f"{KINDS[kind][0]}_list.csv").open("w", newline="") as h:
            fields: list[str] = []
            for r in rows:
                fields += [k for k in r if k not in fields]
            w = csv.DictWriter(h, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    (OUT / "winners.json").write_text(json.dumps(winners, default=list, indent=1))
    if write:
        write_readme(lists, premium_report)
    print("\n".join(premium_report))
    for kind, rows in lists.items():
        print(f"{KINDS[kind][0]}: {len(rows)} rows, {sum(r['status'].startswith('chosen') for r in rows)} "
              f"differ from the default, {sum(r['status'] == 'owner to choose' for r in rows)} owner-to-choose")


_AGG_CACHE: dict = {}


def aggs_lookup(f: Family, results: dict, kind: str, slots: tuple[str, ...], params: dict) -> float:
    """A setting's band-mean gain over the template on one day type (for the "works on both" table)."""
    ck = (f.name, kind, slots)
    if ck not in _AGG_CACHE:
        _AGG_CACHE[ck] = aggregate(f, results, kind, slots)
    return _AGG_CACHE[ck][key(params)]["gain"]


def _template_params(f: Family, results: dict, slot: str, kind: str) -> dict | None:
    """The comparator file at a slot (for a premium family, the better current file there)."""
    return results[slot][kind]["template"]["params"]


def write_readme(lists: dict[str, list[dict]], premium_report: list[str]) -> None:
    lines = [
        "# Day-type strategy lists (BL-104, research leads — not adopted)",
        "",
        "For every Core-298 family, for each of three time bands — **09:15–10:30** (09:17, 09:32, 09:47,",
        "10:17), **10:30–13:00** (10:47, 11:32, 12:17, 13:02) and **13:00–15:30** (13:17, 13:47, 14:02,",
        "14:32) — and for **all times** (one setting across all 12, beating the template at 9 or more of",
        "them): **one setting per day type",
        "that works across the band's entry times**, for **expiry days** and for",
        "**non-expiry days** (each index's own weekly expiries). The premium families (NIFTY / SENSEX",
        "Widesl, NIFTY / SENSEX Buy) also choose up to three premiums, each with its own setting.",
        "Net ₹ per lot-day after charges, averaged over the band's entry times, 2024-10-09 → 2026-10-09;",
        "the first year ends 2025-10-08.",
        "",
        "How a row was chosen (registered in `backlog/BL-104-full-parameter-sweep.md` → Experiments,",
        "day-type lists, Amendments 1–4): the default is the family's own rotation file (for N_wide, the",
        "owner's settings: expiry SL 150 % / trail 25/15 / MTM ₹4,000 / RE cost ×1; other days SL 60 % /",
        "trail 15/10 / MTM ₹3,000 / no re-entry). Settings are ranked on the **first year** (band means):",
        "beat the default by ₹25 (expiry) or ₹15 (other days) a lot-day, beat the template at 3 of the band's",
        "4 times (9 of 12 for all times), a worst day no more than 1.25 × the template's and at least two",
        "grid neighbours that also beat it. The rank-1 setting is taken if it **also beats the template in",
        "the second year**; otherwise rank 2, then rank 3, and no further (Amendment 10). A second pick is kept",
        "only when its daily P&L correlates below 0.7 with the first.",
        "",
        "The engine has no day filter: each file trades every day if run. The day type is in its folder",
        "and in its name (`EXP` / `NONEXP`); one file per entry time carries the same setting.",
        "",
        *[f"- {line}" for line in premium_report],
        "",
    ]
    grouped: dict[str, list[dict]] = {}
    for kind, rows in lists.items():
        for band in BANDS:
            grouped[f"{kind}|{band}"] = [r for r in rows if r["band"] == band]
    for gkey, rows in grouped.items():
        kind, band = gkey.split("|")
        title = {"expiry": "Expiry days", "other": "Non-expiry days", "all": "All days"}[kind] + f" — {band}"
        lines += [f"## {title}", "",
                  "| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in rows:
            lines.append(
                f"| {r['family']}{'' if r['pick'] == 1 else ' (pick ' + str(r['pick']) + ')'} | {r['band']} | {r['status']} | {r['index']} | "
                f"{r['strategy']} | {r['strike']} | {r.get('range', '—') or '—'} | {r['leg SL']} | {r['trail SL']} | "
                f"{r['MTM SL']} | {r['target']} | {r['re-entry']} | {r['exit']} | "
                f"{r['net_per_lot_day']} ({r['net_first_year']} / {r['net_test_year']}) | "
                f"{r['template_net']} ({r['template_first_year']} / {r['template_test_year']}) | "
                f"{r['gain_vs_template']:+d} ({r['gain_first_year']:+d} / {r['gain_test_year']:+d}) | "
                f"{r['slots_better']} | {r['worst_day_x_template']} |"
            )
        lines += ["", f"Gain by entry time ({title.lower()}):", ""]
        for r in rows:
            lines.append(f"- {r['family']} {r['band']} pick {r['pick']}: {r['gain_by_slot']}")
        alts = [r for r in rows if r["alternatives"]]
        if alts:
            lines += ["", f"### {title}: for the owner to choose", ""]
            for r in alts:
                lines.append(f"- **{r['family']} {r['band']}**: {r['alternatives']}")
        lines.append("")
    lines += ["# Leaderboards — which strategies work best (descriptive)", "",
              "Every family's pick (or its default) in each group, ranked by net ₹ per lot-day. Win rate,",
              "max drawdown and worst day are means over the group's entry times. Expiry-day figures cover",
              "about 50 days a year, non-expiry about 190.", ""]
    for band in BANDS:
        for kind in ("expiry", "other"):
            rows = sorted((r for r in lists[kind] if r["band"] == band), key=lambda r: -r["net_per_lot_day"])
            title = ("Expiry days" if kind == "expiry" else "Non-expiry days") + f" — {band}"
            lines += [f"## Leaderboard: {title}", "",
                      "| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |",
                      "|---|---|---|---|---|---|---|---|---|---|"]
            for i, r in enumerate(rows, 1):
                setting = (f"{r['strike']} · {r.get('range') + ' · ' if r.get('range') else ''}SL {r['leg SL']} · TSL {r['trail SL']} · "
                           f"MTM {r['MTM SL']} · target {r['target']} · RE {r['re-entry']} · exit {r['exit']}")
                lines.append(
                    f"| {i} | {r['family']} | {setting} | {r['net_per_lot_day']} ({r['net_first_year']} / {r['net_test_year']}) | "
                    f"{r['gain_vs_template']:+d} | {r['slots_better']} | {r['win_rate']:.0%} | {r['max_drawdown']} | "
                    f"{r['worst_day']} | {r['status']} |"
                )
            lines.append("")
    rows = [r for r in lists["all"] if r["band"] == "all times"]
    lines += ["## Works on both day types — all times, all days", "",
              "Each family's setting chosen on all days (expiry and non-expiry together) across all 12 entry",
              "times, with its gain over the template on each day type. **Both** = it beats the template on",
              "expiry days and on non-expiry days.", "",
              "| Family | Setting | Net/lot-day all days (1st / test) | Gain all days | Gain on expiry days | Gain on non-expiry days | Both? | Status |",
              "|---|---|---|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: -r["net_per_lot_day"]):
        setting = (f"{r['strike']} · {r.get('range') + ' · ' if r.get('range') else ''}SL {r['leg SL']} · TSL {r['trail SL']} · "
                   f"MTM {r['MTM SL']} · target {r['target']} · RE {r['re-entry']} · exit {r['exit']}")
        ge, gn = r["gain_on_expiry_days"], r["gain_on_non_expiry_days"]
        both = "yes" if ge != "" and gn != "" and ge > 0 and gn > 0 else ("template" if ge == "" else "no")
        lines.append(f"| {r['family']} | {setting} | {r['net_per_lot_day']} ({r['net_first_year']} / {r['net_test_year']}) | "
                     f"{r['gain_vs_template']:+d} | {ge if ge == '' else f'{ge:+d}'} | {gn if gn == '' else f'{gn:+d}'} | {both} | {r['status']} |")
    lines.append("")
    (STRATEGIES / "README.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
