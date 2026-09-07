"""Pydantic request/response models for the FastAPI service."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field


class ValidateRequest(BaseModel):
    yaml: str


class ValidateResponse(BaseModel):
    valid: bool
    errors: list[str] = []
    strategy_id: str | None = None
    n_features: int = 0
    n_ladders: int = 0
    n_exits: int = 0


class RunRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    yaml: str
    from_: date = Field(alias="from")
    to: date
    bootstrap: bool = False
    bootstrap_resamples: int = 2000
    seed: int = 0


class SessionResultOut(BaseModel):
    date: date
    dte: int
    net: float
    gross: float
    cost: float
    lot_days: float
    peak_loss: float
    total_lots: int


class BootstrapOut(BaseModel):
    net_lo: float
    net_hi: float
    inr_per_lot_day_lo: float
    inr_per_lot_day_hi: float
    n_resamples: int
    seed: int


class MarginOut(BaseModel):
    strategy_type: str
    peak_lots: int
    peak_date: date
    margin_per_lot_inr: float
    peak_margin_inr: float
    return_on_peak_margin: float


class RunResponse(BaseModel):
    run_id: str
    net_inr: float
    gross_inr: float
    win_days: int
    worst_day: float
    sum_peak_loss: float
    worst_intraday_mtm: float
    lot_days: float
    inr_per_lot_day: float
    dte_buckets: dict[int, float]
    sessions: list[SessionResultOut]
    bootstrap: BootstrapOut | None = None
    # None when the strategy's leg shape isn't a classifiable margin
    # category, or no margin.csv row applies — never fabricated.
    margin: MarginOut | None = None
    # None when regime data isn't available (DATABASE_URL unset) or no
    # regime row applies to this window — never fabricated.
    regime_buckets: dict[str, float] | None = None


class RunSummaryOut(BaseModel):
    run_id: str
    strategy_id: str
    strategy_version: int
    strategy_hash: str
    date_from: str
    date_to: str
    created_at: str
    net_inr: float
    win_days: int
    worst_day: float
    sum_peak_loss: float
    lot_days: float
    inr_per_lot_day: float
    n_sessions: int


class PresetSummary(BaseModel):
    name: str


class PresetDetail(BaseModel):
    name: str
    yaml: str
