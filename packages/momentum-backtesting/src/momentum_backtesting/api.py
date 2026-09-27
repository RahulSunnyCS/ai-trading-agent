"""Local web UI: `mbt ui` serves this on 127.0.0.1 only. Not meant to be exposed."""

import threading
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Literal

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis
from .config import DATA_DIR
from .engine import BENCHMARK, CASH, Config, run_backtest
from .fetch import load_universe
from .tax import TaxRules
from .trade_prices import build_trade_prices

STATIC = Path(__file__).with_name("static")
PLOTLY_URL = "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js"


class _Data:
    """Weekly closes, reloaded when `mbt fetch` rewrites the file."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mtime = None
        self.prices: pd.DataFrame | None = None
        self.rank_cache: OrderedDict = OrderedDict()
        self.fill_tables: dict = {}

    def get(self) -> pd.DataFrame:
        path = DATA_DIR / "weekly_closes.csv"
        if not path.exists():
            raise HTTPException(409, "No data yet - run `mbt login` then `mbt fetch`.")
        with self._lock:
            mtime = path.stat().st_mtime
            if mtime != self._mtime:
                self.prices = pd.read_csv(path, index_col=0, parse_dates=True)
                self._mtime = mtime
                self.rank_cache.clear()
                self.fill_tables.clear()
            return self.prices

    def fills(self, track: str, execution: str):
        """Trade-price table for this track/execution (None = index at Friday close), built
        once per data refresh - it reads a few dozen daily CSVs."""
        prices = self.get()
        key = (track, execution)
        with self._lock:
            if key not in self.fill_tables:
                try:
                    self.fill_tables[key] = build_trade_prices(
                        prices, track, execution, data_dir=DATA_DIR
                    )
                except ValueError as error:
                    raise HTTPException(409, str(error)) from None
            return self.fill_tables[key]

    def trim_cache(self, limit: int = 24) -> None:
        while len(self.rank_cache) > limit:
            self.rank_cache.popitem(last=False)


DATA = _Data()


class BacktestRequest(BaseModel):
    universe: list[str] = Field(min_length=1)
    start: str = "2017-01-01"
    end: str | None = None
    top_n: int = Field(5, ge=1, le=20)
    exit_rank: int = Field(10, ge=1, le=40)
    lookbacks: list[int] = Field([1, 4, 13, 26, 52], min_length=1)
    weights: list[float] | None = None
    defensive: Literal["off", "ranked", "filter"] = "off"
    filter_lookback: int = Field(13, ge=1, le=104)
    cost_pct: float = Field(0.10, ge=0, le=5)
    signal_delay: int = Field(0, ge=0, le=4)
    tax: bool = False
    slab_rate: float = Field(0.30, ge=0, le=0.5)
    benchmark: str = BENCHMARK
    portfolio: Literal["buffer", "slots"] = "buffer"
    entry: Literal["wait", "make_room"] = "wait"
    max_position: float | None = Field(0.35, gt=0, le=1)  # None = no cap
    cap_band: float = Field(0.05, ge=0, le=0.5)
    track: Literal["index", "etf"] = "index"
    execution: Literal["fri_close", "mon_open", "mon_10am"] = "fri_close"


def create_app() -> FastAPI:
    app = FastAPI(title="Momentum backtest", docs_url="/api/docs")

    @app.get("/api/meta")
    def meta() -> dict:
        prices = DATA.get()
        instruments = []
        for inst in load_universe():
            series = prices[inst.name].dropna() if inst.name in prices else pd.Series(dtype=float)
            instruments.append(
                {
                    "name": inst.name,
                    "group": inst.group,
                    "include": inst.include,
                    "trade_etf": inst.trade_etf,
                    "tax_class": inst.tax_class,
                    "note": inst.note,
                    "first_week": series.index[0].strftime("%Y-%m-%d") if len(series) else None,
                    "has_data": bool(len(series)),
                }
            )
        turnover = {}
        from .config import UNIVERSE_CSV

        for row in pd.read_csv(UNIVERSE_CSV).itertuples():
            turnover[row.index] = row.etf_turnover_cr_day
        for inst in instruments:
            value = turnover.get(inst["name"])
            inst["etf_turnover_cr_day"] = None if pd.isna(value) else float(value)
        defaults = Config()
        return {
            "instruments": instruments,
            "first_week": prices.index[0].strftime("%Y-%m-%d"),
            "last_week": prices.index[-1].strftime("%Y-%m-%d"),
            "cash": CASH,
            "defaults": {
                "top_n": defaults.top_n,
                "exit_rank": defaults.exit_rank,
                "lookbacks": list(defaults.lookbacks),
                "defensive": defaults.defensive,
                "filter_lookback": defaults.filter_lookback,
                "cost_pct": defaults.cost_pct,
                "signal_delay": defaults.signal_delay,
                "start": defaults.start,
                "benchmark": defaults.benchmark,
                "portfolio": defaults.portfolio,
                "entry": defaults.entry,
                "max_position": defaults.max_position,
                "cap_band": defaults.cap_band,
                # The UI opens on what you'd actually trade; the engine default stays "index".
                "track": "etf",
                "execution": defaults.execution,
            },
        }

    @app.post("/api/backtest")
    def backtest(req: BacktestRequest) -> dict:
        prices = DATA.get()
        universe = {inst.name: inst for inst in load_universe()}
        includes = {name: inst.include for name, inst in universe.items()}
        if req.weights is not None and len(req.weights) != len(req.lookbacks):
            raise HTTPException(422, "Give one weight per lookback.")
        if req.benchmark not in prices:
            raise HTTPException(422, f"No price history for benchmark {req.benchmark!r}.")
        try:
            config = Config(
                lookbacks=tuple(req.lookbacks),
                weights=tuple(req.weights) if req.weights else None,
                top_n=req.top_n,
                exit_rank=req.exit_rank,
                cost_pct=req.cost_pct,
                defensive=req.defensive,
                filter_lookback=req.filter_lookback,
                start=req.start,
                end=req.end or None,
                signal_delay=req.signal_delay,
                tax=TaxRules(slab_rate=req.slab_rate) if req.tax else None,
                universe=tuple(req.universe),
                benchmark=req.benchmark,
                portfolio=req.portfolio,
                entry=req.entry,
                max_position=req.max_position,
                cap_band=req.cap_band,
                track=req.track,
                execution=req.execution,
            )
            ranked = [n for n in req.universe if includes.get(n) != "defensive"]
            if config.defensive == "ranked":
                ranked = list(req.universe)
            if len(ranked) < config.top_n:
                raise ValueError(
                    f"Only {len(ranked)} instruments selected for ranking - need at least "
                    f"top N ({config.top_n})."
                )
            classes = {name: inst.tax_class for name, inst in universe.items()}
            fills = DATA.fills(req.track, req.execution)
            result = run_backtest(
                prices,
                includes,
                config,
                classes,
                DATA.rank_cache,
                fills.prices if fills is not None else None,
            )
            DATA.trim_cache()
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        groups = {name: inst.group for name, inst in universe.items()}
        return analysis.payload(
            result,
            prices,
            config,
            groups,
            fills.proxy if fills is not None else None,
            fills.warnings if fills is not None else None,
        )

    @app.get("/vendor/plotly.min.js")
    def plotly() -> FileResponse:
        """Charting library, downloaded once and kept in data/ so the UI then works offline."""
        path = DATA_DIR / "vendor" / "plotly-2.35.2.min.js"
        if not path.exists():
            try:
                request = urllib.request.Request(PLOTLY_URL, headers={"User-Agent": "Mozilla/5.0"})
                body = urllib.request.urlopen(request, timeout=60).read()
            except OSError as error:
                raise HTTPException(503, f"Couldn't download the chart library: {error}") from None
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        return FileResponse(path, media_type="text/javascript")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    return app


app = create_app()
