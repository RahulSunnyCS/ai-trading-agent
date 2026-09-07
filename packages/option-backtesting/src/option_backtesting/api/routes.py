"""
FastAPI routes over the M-3 engine. This service is loopback-only (see
api/app.py) — the only public-facing surface is the Fastify proxy
(`apps/server/src/server/routes/backtest.ts`), which applies access-gating,
credit consumption, a request-body cap, and a timeout before ever reaching
this process.

Preset names are allow-listed against the real files under `strategies/`
(`preset_names()`) BEFORE being used to build a filesystem path — a client
can never supply an arbitrary path component that resolves outside that
directory, since the only names accepted are ones already enumerated from
disk.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..data.cache import Cache
from ..data.reference.loader import default_reference_data
from ..engine.loop import run_backtest
from ..engine.margin import compute_return_on_peak_margin
from ..engine.registry import RunRecord, get_run, list_runs, record_run
from ..engine.result import aggregate, bootstrap_ci
from ..features.regime import regime_bucket_report
from ..presets import STRATEGIES_DIR, preset_names
from ..strategy.loader import StrategyValidationError, load_strategy_from_source
from .models import (
    BootstrapOut,
    MarginOut,
    PresetDetail,
    PresetSummary,
    RunRequest,
    RunResponse,
    RunSummaryOut,
    SessionResultOut,
    ValidateRequest,
    ValidateResponse,
)

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/presets", response_model=list[PresetSummary])
def list_presets() -> list[PresetSummary]:
    return [PresetSummary(name=n) for n in preset_names()]


@router.get("/presets/{name}", response_model=PresetDetail)
def get_preset(name: str) -> PresetDetail:
    if name not in preset_names():
        raise HTTPException(status_code=404, detail=f"Unknown preset {name!r}")
    path = STRATEGIES_DIR / f"{name}.yaml"
    return PresetDetail(name=name, yaml=path.read_text())


@router.get("/coverage")
def coverage(underlying: str, request: Request) -> dict[str, dict[str, str]]:
    cache = Cache(request.app.state.cache_dir)
    return cache.coverage(underlying.upper())


@router.post("/validate", response_model=ValidateResponse)
def validate(body: ValidateRequest) -> ValidateResponse:
    try:
        loaded = load_strategy_from_source(body.yaml)
    except StrategyValidationError as e:
        return ValidateResponse(valid=False, errors=e.errors)
    assert loaded.strategy is not None
    return ValidateResponse(
        valid=True,
        strategy_id=loaded.strategy.id,
        n_features=len(loaded.features),
        n_ladders=len(loaded.strategy.ladders),
        n_exits=len(loaded.strategy.exits),
    )


@router.post("/runs", response_model=RunResponse)
def create_run(body: RunRequest, request: Request) -> RunResponse:
    try:
        loaded = load_strategy_from_source(body.yaml)
    except StrategyValidationError as e:
        raise HTTPException(status_code=422, detail=e.errors) from None
    assert loaded.strategy is not None

    cache = Cache(request.app.state.cache_dir)
    reference = default_reference_data()
    sessions = run_backtest(loaded, cache, reference, body.from_, body.to)
    if not sessions:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No cached sessions for {loaded.strategy.universe.underlying} "
                f"in [{body.from_}, {body.to}]"
            ),
        )

    result = aggregate(sessions)
    run_id = record_run(
        request.app.state.registry_db, loaded.strategy, body.from_, body.to, result, body.yaml
    )

    bootstrap_out = None
    if body.bootstrap:
        ci = bootstrap_ci(
            [s.net for s in sessions],
            [s.lot_days for s in sessions],
            n_resamples=body.bootstrap_resamples,
            seed=body.seed,
        )
        bootstrap_out = BootstrapOut(
            net_lo=ci.net_lo,
            net_hi=ci.net_hi,
            inr_per_lot_day_lo=ci.inr_per_lot_day_lo,
            inr_per_lot_day_hi=ci.inr_per_lot_day_hi,
            n_resamples=ci.n_resamples,
            seed=ci.seed,
        )

    margin_out = None
    try:
        margin = compute_return_on_peak_margin(loaded.strategy, reference, result)
    except (NotImplementedError, ValueError):
        margin = None
    if margin is not None:
        margin_out = MarginOut(
            strategy_type=margin.strategy_type,
            peak_lots=margin.peak_lots,
            peak_date=margin.peak_date,
            margin_per_lot_inr=margin.margin_per_lot_inr,
            peak_margin_inr=margin.peak_margin_inr,
            return_on_peak_margin=margin.return_on_peak_margin,
        )

    return RunResponse(
        run_id=run_id,
        net_inr=result.net_inr,
        gross_inr=result.gross_inr,
        win_days=result.win_days,
        worst_day=result.worst_day,
        sum_peak_loss=result.sum_peak_loss,
        worst_intraday_mtm=result.worst_intraday_mtm,
        lot_days=result.lot_days,
        inr_per_lot_day=result.inr_per_lot_day,
        dte_buckets=result.dte_buckets,
        sessions=[
            SessionResultOut(
                date=s.date,
                dte=s.dte,
                net=s.net,
                gross=s.gross,
                cost=s.cost,
                lot_days=s.lot_days,
                peak_loss=s.peak_loss,
                total_lots=s.total_lots,
            )
            for s in result.sessions
        ],
        bootstrap=bootstrap_out,
        margin=margin_out,
        regime_buckets=regime_bucket_report(sessions, loaded.strategy.universe.underlying),
    )


@router.get("/runs", response_model=list[RunSummaryOut])
def get_runs(request: Request, limit: int = 20) -> list[RunSummaryOut]:
    runs = list_runs(request.app.state.registry_db, limit=limit)
    return [_to_summary(r) for r in runs]


@router.get("/runs/{run_id}", response_model=RunSummaryOut)
def get_run_detail(run_id: str, request: Request) -> RunSummaryOut:
    record = get_run(request.app.state.registry_db, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown run_id {run_id!r}")
    return _to_summary(record)


def _to_summary(record: RunRecord) -> RunSummaryOut:
    return RunSummaryOut(
        run_id=record.run_id,
        strategy_id=record.strategy_id,
        strategy_version=record.strategy_version,
        strategy_hash=record.strategy_hash,
        date_from=record.date_from,
        date_to=record.date_to,
        created_at=record.created_at,
        net_inr=record.net_inr,
        win_days=record.win_days,
        worst_day=record.worst_day,
        sum_peak_loss=record.sum_peak_loss,
        lot_days=record.lot_days,
        inr_per_lot_day=record.inr_per_lot_day,
        n_sessions=record.n_sessions,
    )
