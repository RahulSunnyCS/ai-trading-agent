# BL-111: descriptive range look (2026-11-07)

Not a run of H1 / H2: the owner's question whether the day range belongs in the rotation's rules. See the
BL-111 Log entry of 2026-11-07. Run from `packages/option-backtesting` (outputs are JSON files you name):

    uv run python research/bl111/range_look/range_study.py OUT/range_data.json          # ranges + book series
    uv run python research/bl111/range_look/range_an.py OUT/range_data.json OUT/range_feats.json
    uv run python research/bl111/range_look/range_fam.py OUT/range_feats.json          # families, 2024-11 -> 2026-11
    uv run python research/bl111/range_look/range_stab.py OUT/range_feats.json         # by period, incl. _bl214
