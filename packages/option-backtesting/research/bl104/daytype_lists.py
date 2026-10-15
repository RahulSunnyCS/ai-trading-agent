"""BL-104 (2026-10-16, owner-directed): expiry-day and non-expiry-day lists for every Core-298 family.

For each family (N_wide, N_p80, N_p100, S_wide, S_p250, S_p320, N_dir, N_ditm1, S_dir, S_ditm1,
N_buy, S_buy), each of the 7 sampled entry times and each day type, keep the default unless settings
clear the rule registered in BL-104 → Experiments ("day-type lists", Amendment 1). The family keeps
its own strike; every other parameter varies over the Stage 1 grid. Writes the two lists under
results/daytype/, one strategy file per pick under strategies/daytype/{expiry,non_expiry}/, and the
readable lists in strategies/daytype/README.md. The schema has no day filter: a file trades every day
if run, and the day type lives in its folder and name.

    uv run python research/bl104/daytype_lists.py                  # the lists (after every run)
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

PACKAGE = HERE.parents[1]
RESULTS = HERE / "results"
OUT = RESULTS / "daytype"
STRATEGIES = PACKAGE / "strategies" / "daytype"
REFERENCE = PACKAGE / "src" / "option_backtesting" / "data" / "reference"
CUT = date(2025, 10, 9)  # first year < CUT <= test year
MARGIN = {"expiry": 25.0, "other": 15.0}
WORST_X = 1.25
MAX_CORR = 0.7
KINDS = {"expiry": ("expiry", "EXP"), "other": ("non_expiry", "NONEXP")}
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
    Family("N_wide", "W", "N", "OTM1", (("N_wide", "stage1", None),)),
    Family("NIFTY_Widesl_premium", "W", "N", None,
           (("N_p80", "daytype", {"strike": 80}), ("N_p100", "daytype", {"strike": "PHIGH"})),
           (40, 60, 80, 100, 120, 150)),
    Family("S_wide", "W", "S", "OTM2", (("S_wide", "stage1", None),)),
    Family("SENSEX_Widesl_premium", "W", "S", None,
           (("S_p250", "daytype", {"strike": 250}), ("S_p320", "daytype", {"strike": "PHIGH"})),
           (100, 150, 200, 250, 320, 400)),
    Family("N_dir", "D", "N", "ATM", (("N_dir", "stage1", None),)),
    Family("N_ditm1", "D", "N", "ITM1", (("N_ditm1", "daytype", {"strike": "ITM1"}),)),
    Family("S_dir", "D", "S", "ATM", (("S_dir", "stage1", None),)),
    Family("S_ditm1", "D", "S", "ITM1", (("S_ditm1", "daytype", {"strike": "ITM1"}),)),
    Family("NIFTY_Buy_premium", "B", "N", None, (("N_buy", "stage1", None),), (20, 30, 50, 75, 100)),
    Family("SENSEX_Buy_premium", "B", "S", None, (("S_buy", "stage1", None),), (30, 50, 90, 150, 225)),
]
PREMIUM_TAGS = ("daytype", "premium_coarse", "premium_refine")
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


def column(tag: str, f: Family, slot: str, params: dict | None) -> tuple[list[date], np.ndarray]:
    cell = grid.Cell(f.fam, f.idx, slot, params)
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
                out.append((p, "stage1", p))
            continue
        if p["strike"] != base_strike:
            continue
        for pr in premiums:
            described = {**p, "strike": pr}
            if pr in grid_names:
                out.append((described, "stage1", {**p, "strike": grid_names[pr]}))
                continue
            tag = next((t for t in PREMIUM_TAGS if _has(t, f, slot, described)), None)
            if tag is not None:
                out.append((described, tag, described))
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
    is_exp = np.array([x in exp for x in tdays])
    out = {}
    for kind, mask in (("expiry", is_exp), ("other", ~is_exp)):
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


def decide(f: Family, res: dict, kind: str, allowed: list[float] | None = None) -> dict[str, Any]:
    rows, tmpl = res["rows"], res["template"]
    dflt = rows[key(OWNER_DEFAULT[kind])] if f.name == "N_wide" else tmpl

    def clears(r: dict) -> bool:
        return (
            r is not dflt and r["gain_first"] > 0 and r["gain_test"] > 0
            and r["gain"] >= dflt["gain"] + MARGIN[kind]
            and not (r["worst_x"] > WORST_X) and r["nb_beat"] >= 2
        )

    ok = sorted((r for r in rows.values() if clears(r)), key=lambda r: -r["gain"])
    if f.is_premium and allowed is not None:
        ok = [r for r in ok if r["params"]["strike"] in allowed]
    if ok and f.is_premium:
        picks: list[dict] = []
        for r in ok:
            if any(r["params"]["strike"] == k["params"]["strike"] for k in picks):
                continue
            corr = [float(np.corrcoef(k["values"], r["values"])[0, 1]) for k in picks]
            if picks:
                r["corr_with_first"] = corr[0]
            picks.append(r)
            if len(picks) == 3:
                break
        return {"status": f"chosen ({len(picks)} premium{'s' if len(picks) > 1 else ''})",
                "picks": picks, "alts": [], "default": dflt, "n_clear": len(ok)}
    if ok:
        picks = [ok[0]]
        for r in ok[1:]:
            if float(np.corrcoef(ok[0]["values"], r["values"])[0, 1]) < MAX_CORR:
                r["corr_with_first"] = float(np.corrcoef(ok[0]["values"], r["values"])[0, 1])
                picks.append(r)
                break
        return {"status": "chosen" if len(picks) == 1 else "chosen (2, low correlation)",
                "picks": picks, "alts": [], "default": dflt, "n_clear": len(ok)}
    if dflt["gain_first"] < 0 and dflt["gain_test"] < 0:
        top = sorted(rows.values(), key=lambda r: -r["gain"])[:3]
        return {"status": "owner to choose", "picks": [dflt], "alts": top, "default": dflt, "n_clear": 0}
    return {"status": "default (template)" if dflt is tmpl else "default (owner setting)",
            "picks": [dflt], "alts": [], "default": dflt, "n_clear": 0}


def write_yaml(f: Family, slot: str, kind: str, st: LegwiseStrategy, status: str, text: str) -> Path:
    stem = file_stem(f, slot, kind, st)
    path = STRATEGIES / KINDS[kind][0] / f"{stem}.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    st = st.model_copy(deep=True)
    st.id = stem
    day = "NIFTY/SENSEX weekly EXPIRY days only" if kind == "expiry" else "NON-expiry days only"
    head = (
        f"# BL-104 day-type list ({status}) — {day} of {st.underlying}.\n"
        f"# {text}\n"
        "# The schema has no day filter: this file trades every day if run. Research lead, not adopted.\n"
        "# Generated by packages/option-backtesting/research/bl104/daytype_lists.py.\n"
    )
    body = yaml.safe_dump({"strategy": st.model_dump(mode="json", exclude_none=True)}, sort_keys=False,
                          allow_unicode=True)
    path.write_text(head + body)
    assert load_legwise(path).model_dump() == st.model_dump(), path
    return path


def premium_scores(f: Family, kind: str, exp: dict, results: dict | None = None) -> dict[float, float]:
    """Amendment 3: per premium, the mean over the 7 slots of the best setting's gain over the
    template on this day type (the premium is chosen across entry times, never per slot)."""
    per: dict[float, list[float]] = {}
    for slot in grid.SLOTS:
        res = (results or {}).get(slot) or evaluate(f, slot, exp[grid.INDICES[f.idx]])
        best: dict[float, float] = {}
        for r in res[kind]["rows"].values():
            pr = r["params"]["strike"]
            best[pr] = max(best.get(pr, -1e18), r["gain"])
        for pr, g in best.items():
            per.setdefault(pr, []).append(g)
    return {pr: float(np.mean(v)) for pr, v in per.items() if len(v) == len(grid.SLOTS)}


def refine_cells() -> None:
    """Amendment 3 refine step: per premium family and day type, the coarse premium with the best
    slot-mean score is the area; add the midpoints to its coarse neighbours (₹5 rounding), or one
    step beyond at an end of the range; the union over the two day types is run at all 7 slots."""
    exp = expiries()
    out, report = [], []
    for f in (x for x in FAMILIES if x.is_premium):
        coarse = sorted(f.premiums)
        base_strike = {"W": "OTM1", "B": "ATM"}[f.fam]
        results = {slot: evaluate(f, slot, exp[grid.INDICES[f.idx]]) for slot in grid.SLOTS}
        new: set[float] = set()
        for kind in KINDS:
            score = premium_scores(f, kind, exp, results)
            area = max((p for p in score if p in coarse), key=score.get)
            i = coarse.index(area)
            lo = 5 * round((area + coarse[i - 1]) / 10) if i > 0 else max(5, 5 * round((2 * area - coarse[1]) / 5))
            hi = (5 * round((area + coarse[i + 1]) / 10) if i < len(coarse) - 1
                  else 5 * round((2 * area - coarse[-2]) / 5))
            pts = [x for x in (lo, hi) if x not in coarse and x > 0]
            new |= set(pts)
            report.append(f"{f.name} {kind}: scores " + ", ".join(f"₹{p:g} {score[p]:+.0f}" for p in sorted(score))
                          + f" -> area ₹{area:g}, add {pts}")
        for slot in grid.SLOTS:
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


def family_premiums(f: Family, kind: str, exp: dict, results: dict) -> tuple[list[float], dict[float, float]]:
    """Amendment 3: the family's premiums for a day type, top three by slot-mean score, a later one
    dropped when its slot-mean daily P&L (best setting per slot) correlates >= 0.9 with a kept one."""
    score = premium_scores(f, kind, exp, results)
    curves: dict[float, np.ndarray] = {}
    for pr in score:
        parts = []
        for slot in grid.SLOTS:
            rows = [r for r in results[slot][kind]["rows"].values() if r["params"]["strike"] == pr]
            parts.append(max(rows, key=lambda r: r["gain"])["values"])
        curves[pr] = np.mean(parts, axis=0)
    kept: list[float] = []
    for pr in sorted(score, key=lambda p: -score[p]):
        if any(float(np.corrcoef(curves[k], curves[pr])[0, 1]) >= PREMIUM_DUP_CORR for k in kept):
            continue
        kept.append(pr)
        if len(kept) == 3:
            break
    return kept, score


def main() -> None:
    if "--refine-cells" in sys.argv:
        refine_cells()
        return
    exp = expiries()
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in KINDS:
        folder = STRATEGIES / KINDS[kind][0]
        if folder.exists():
            for old in folder.glob("*.yaml"):
                old.unlink()
    lists: dict[str, list[dict]] = {"expiry": [], "other": []}
    premium_report = []
    for f in FAMILIES:
        underlying = grid.INDICES[f.idx]
        results = {slot: evaluate(f, slot, exp[underlying]) for slot in grid.SLOTS}
        allowed: dict[str, list[float] | None] = {k: None for k in KINDS}
        if f.is_premium:
            for kind in KINDS:
                allowed[kind], score = family_premiums(f, kind, exp, results)
                premium_report.append(
                    f"{f.name} {KINDS[kind][0]}: premiums kept {['₹%g' % p for p in allowed[kind]]}; scores "
                    + ", ".join(f"₹{p:g} {score[p]:+.0f}" for p in sorted(score))
                )
        for slot in grid.SLOTS:
            res = results[slot]
            for kind in KINDS:
                dec = decide(f, res[kind], kind, allowed[kind])
                t = res[kind]["template"]
                for rank, r in enumerate(dec["picks"], 1):
                    st = build(f, slot, r["params"])
                    desc = describe(st, f.fam)
                    text = one_line(desc)
                    path = write_yaml(f, slot, kind, st, dec["status"], text)
                    lists[kind].append({
                        "family": f.name, "slot": slot, "pick": rank, "status": dec["status"],
                        **desc,
                        "net_per_lot_day": round(r["net"]), "net_first_year": round(r["net_first"]),
                        "net_test_year": round(r["net_test"]),
                        "template": t["name"],
                        "template_net": round(t["net"]), "template_first_year": round(t["net_first"]),
                        "template_test_year": round(t["net_test"]),
                        "gain_vs_template": round(r["gain"]), "gain_first_year": round(r["gain_first"]),
                        "gain_test_year": round(r["gain_test"]), "worst_day": round(r["worst"]),
                        "template_worst_day": round(t["worst"]),
                        "corr_with_pick_1": "" if rank == 1 else round(r.get("corr_with_first", float("nan")), 2),
                        "settings_clearing_rule": dec["n_clear"],
                        "alternatives": " || ".join(
                            f"{one_line(describe(build(f, slot, a['params']), f.fam))} "
                            f"(gain {a['gain']:+.0f}; {a['gain_first']:+.0f} / {a['gain_test']:+.0f})"
                            for a in dec["alts"]
                        ),
                        "days": res[kind]["n_days"], "file": str(path.relative_to(PACKAGE)),
                        "description": text,
                    })
    for kind, rows in lists.items():
        name = f"{KINDS[kind][0]}_list.csv"
        with (OUT / name).open("w", newline="") as h:
            fields: list[str] = []
            for r in rows:
                fields += [k for k in r if k not in fields]
            w = csv.DictWriter(h, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    write_readme(lists, premium_report)
    print("\n".join(premium_report))
    for kind, rows in lists.items():
        changed = [r for r in rows if r["status"].startswith("chosen")]
        print(f"{KINDS[kind][0]}: {len(rows)} rows, {len(changed)} picks differ from the default, "
              f"{sum(r['status'] == 'owner to choose' for r in rows)} owner-to-choose")


def write_readme(lists: dict[str, list[dict]], premium_report: list[str]) -> None:
    lines = [
        "# Day-type strategy lists (BL-104, research leads — not adopted)",
        "",
        "Two lists for every Core-298 family at the 7 sampled entry times: the best setting on",
        "**expiry days** and on **non-expiry days** (NIFTY and SENSEX weekly expiries, each index its own).",
        "Each family keeps its own strike; every other parameter was varied over the BL-104 Stage 1 grid.",
        "Net ₹ per lot-day after charges, 2024-10-09 → 2026-10-09; first year ends 2025-10-08.",
        "",
        "How a row was chosen (registered in `backlog/BL-104-full-parameter-sweep.md` → Experiments,",
        "day-type lists, Amendment 1): the default is the family's own rotation file (for N_wide, the",
        "owner's settings: expiry SL 150 % / trail 25/15 / MTM ₹4,000 / RE cost ×1; other days SL 60 % /",
        "trail 15/10 / MTM ₹3,000 / no re-entry). Another setting replaces it only when it beats the",
        "template in **both** years, beats the default by ₹25 (expiry) or ₹15 (other days) a lot-day, has a",
        "worst day no more than 1.25 × the template's and at least two grid neighbours that also beat the",
        "template. A second pick is kept only when its daily P&L correlates below 0.7 with the first.",
        "",
        "**Caution:** a per-slot choice from hundreds of settings on about 50 expiry days a year is close",
        "to choosing noise. These files are for the forward journal, not proof. The engine has no day",
        "filter, so a file trades every day if run; the day type is in its folder and in its name (`EXP` /",
        "`NONEXP`).",
        "",
        "Premium families: the premium is chosen across all 7 entry times (Amendment 3), then the",
        "settings per entry time among those premiums.",
        "",
        *[f"- {line}" for line in premium_report],
        "",
    ]
    for kind, rows in lists.items():
        title = "Expiry days" if kind == "expiry" else "Non-expiry days"
        lines += [f"## {title}", "",
                  "| Family | Entry | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain vs template (1st / test) | Worst day (template) |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in rows:
            lines.append(
                f"| {r['family']}{'' if r['pick'] == 1 else ' (2nd)'} | {r['slot']} | {r['status']} | {r['index']} | "
                f"{r['strategy']} | {r['strike']} | {r.get('range', '—') or '—'} | {r['leg SL']} | {r['trail SL']} | "
                f"{r['MTM SL']} | {r['target']} | {r['re-entry']} | {r['exit']} | "
                f"{r['net_per_lot_day']} ({r['net_first_year']} / {r['net_test_year']}) | "
                f"{r['template_net']} ({r['template_first_year']} / {r['template_test_year']}) | "
                f"{r['gain_vs_template']:+d} ({r['gain_first_year']:+d} / {r['gain_test_year']:+d}) | "
                f"{r['worst_day']} ({r['template_worst_day']}) |"
            )
        alts = [r for r in rows if r["alternatives"]]
        if alts:
            lines += ["", f"### {title}: slots for the owner to choose", ""]
            for r in alts:
                lines.append(f"- **{r['family']} {r['slot']}**: {r['alternatives']}")
        lines.append("")
    (STRATEGIES / "README.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
