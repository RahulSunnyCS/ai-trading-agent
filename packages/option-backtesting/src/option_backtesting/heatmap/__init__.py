"""Straddle heatmap (BL-094): the P&L of an ATM short straddle for every entry time and stop loss,
the AlgoTest "Heatmap" grid, computed from the lake's 1-minute option bars.

    grid.py    one day -> rows (entry time x SL), the same fill rules as legwise/engine.py
    store.py   rows kept as one Parquet file per underlying under TRADING_DATA_ROOT/heatmap/
    view.py    the three AlgoTest views (time x SL, date x time, date x SL) read from those rows
"""
