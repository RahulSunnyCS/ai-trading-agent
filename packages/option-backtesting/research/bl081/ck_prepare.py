"""BL-081 block 3, stage 1: for one (set, list) reproduce the list's daily picks and 09:16 composites.

    uv run --with pandas --with numpy --with duckdb python research/bl081/ck_prepare.py <explore|confirm> <A|B|C|REF>

Writes out/ck/prep_<set>_<list>.npz (variant names, days, results matrix, composites on the selection days,
core / buy picks) and checks the plain list's gross against rotate.py's own printed total.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
OUT = HERE / "out" / "ck"
LB = ["--fit-lookbacks", "5:30,21:25,63:25,126:20"]
LISTS = {
    "A": ["--weights", "5,34,33,23,0,5", *LB, "--family-key", "band"],
    "B": ["--weights", "0,36,35,24,0,5", *LB, "--family-key", "band"],
    "C": ["--weights", "15,30,30,20,0,5", *LB, "--family-key", "band"],
    "REF": ["--weights", "33,25,25,17"],
}
SETS = {
    "explore": ["--window-from", "2024-10-09"],
    "confirm": ["--nifty-only", "--early-results", str(HERE.parent / "bl071" / "results"),
                "--window-from", "2022-01-03", "--window-to", "2024-10-08"],
}


def main() -> None:
    st, lst = sys.argv[1], sys.argv[2]
    argv = ["--basket", "DRB-6W3L2", *LISTS[lst], *SETS[st]]
    printed = subprocess.run([sys.executable, str(HERE.parent / "bl057" / "rotate.py"), *argv],
                             capture_output=True, text=True, cwd=HERE.parent.parent).stdout
    m = re.search(r"ROTATION case A[^\n]*?\)\s+(-?[\d,]+)", printed)
    printed_total = float(m.group(1).replace(",", ""))
    sys.argv = ["rotate.py", *argv]
    sys.path.insert(0, str(HERE.parent / "bl057"))
    import rotate as R  # noqa: E402

    P, f = R.load_all()
    names, days = list(P.columns), P.index
    Pv = P.to_numpy()
    masks = R.variant_masks(names)
    wd, vb, dte = R.day_inputs(f, names)
    if R.W_CRIT.get("rfam"):
        def band(tag):
            mm = R._minutes(tag)
            return "A" if mm <= R._minutes("1002") else "B" if mm <= R._minutes("1202") else "C" if mm <= R._minutes("1402") else "D"

        def typ(fam):
            if fam in ("dir", "ditm1"):
                return "dir"
            return "wide" if fam == "wide" or fam in R.CLOSEST_FAMILIES else fam

        keys = [f"{typ(n.split('_')[1])}_{band(n.split('_')[2])}" for n in names]
        R._STATE["family_idx"] = np.unique(keys, return_inverse=True)[1]
    sel = list(range(R.WARMUP, len(days)))
    comp_rows, core, buy = [], [], []
    for i in sel:
        crit, comp = R.score_day(Pv, wd, vb, dte, i)
        core_a, _core_b, b, _o = R.select_picks(comp, names, masks)
        comp_rows.append(comp)
        core.append(list(core_a))
        buy.append(list(b))
    plain = sum(R.LOTS_PER * (Pv[i, c].sum() + Pv[i, b].sum()) for i, c, b in zip(sel, core, buy, strict=True))
    assert abs(plain - printed_total) < 1.0, (plain, printed_total)
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez(OUT / f"prep_{st}_{lst}.npz", names=np.array(names), days=np.array([d.strftime("%Y-%m-%d") for d in days]),
             Pv=Pv, sel=np.array(sel), comp=np.array(comp_rows),
             core=np.array(core), buy=np.array([b[0] if b else -1 for b in buy]))
    print(f"{st} {lst}: {len(sel)} selection days, {len(names)} variants, plain gross {plain:,.0f} == rotate {printed_total:,.0f}")


if __name__ == "__main__":
    main()
