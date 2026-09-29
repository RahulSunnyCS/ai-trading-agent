"""Category-momentum stock-tag data layer: which stocks belong to which
universe.csv Sector/Thematic category (Nifty Bank, Nifty IT, ...), as of
which year.

This is a data layer only -- the same boundary `stocks/` draws around itself.
Nothing in engine.py or the ranking/backtest CLI commands reads it yet; the
backtest-composition logic that would buy the top-K tagged stocks instead of
a category's ETF is a separate, later task. See resolve.py's
`resolve_category_members` for the one function that later work should call.

Deliberately separate from `stocks/`: `stocks/` builds a from-scratch,
survivorship-bias-free, corporate-action-adjusted price history for every
ever-member of the Nifty 50 (a much more rigorous, much narrower dataset, for
a different purpose). This package only answers "which symbols were tagged
with category X in year Y" -- current/point-in-time index constituent lists,
not adjusted price series -- for the much broader Nifty Total Market universe
(755 names). Do not merge the two; do not touch stocks/ or its curated/ files
from here.
"""
