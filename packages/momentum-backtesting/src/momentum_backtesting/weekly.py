"""The weekly Friday signal (`mbt weekly --run preview|final`), sent to Telegram.

Two runs each Friday (IST):
  preview  ~14:40 - ranks on live prices so the trades can be placed before the 15:30 close,
           i.e. at (nearly) the Friday close the backtest assumes. Index levels come from
           Fyers quotes when a token is available; otherwise each index is estimated from
           its ETF's live Yahoo quote (~15 min delayed): last index close x ETF now / ETF
           last close. Estimates are never stored.
  final    ~16:45 - official closes; reports anything the close changed versus the preview.

Sources, best first: Fyers (dashboard token or standalone env/file token),
niftyindices.com (NSE's official closes, for indices with a `backfill` name), then the same
ETF-implied estimate. Every series' freshness is checked; when too many are stale, the run
sends a data-health alert instead of a signal.

The positions are the backtest's model portfolio under live_config.toml, run from 2017 -
not your actual holdings.
"""

import copy
import shutil
import tempfile
import tomllib
from dataclasses import dataclass, field, fields, replace
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from . import analysis, fyers
from .config import DATA_DIR
from .engine import Config, run_backtest
from .fetch import ETF_SAME, Instrument, load_universe
from .notify import IST, Notification
from .sources import (
    amfi_nav,
    index_in_inr,
    niftyindices_candles,
    silver_daily,
    split_factors,
    weekly,
    yahoo_candles,
    yahoo_quote,
)
from .tax import TaxRules
from .trade_prices import build_trade_prices, load_premiums

LIVE_CONFIG = Path(__file__).with_name("live_config.toml")
REFRESH_DAYS = 20  # re-fetch this many calendar days each run; older history comes from the DB
STALE_LIMIT = 0.25  # more than this share of ranked series stale -> no signal
LAST_SAFE_PREVIEW = (15, 15)  # after 15:15 IST there isn't time to trade before the close


@dataclass
class LiveSettings:
    config: Config
    premium_warn: float = 0.01
    premium_warn_international: float = 0.02


def load_live_config(path: Path = LIVE_CONFIG) -> LiveSettings:
    raw = tomllib.loads(path.read_text())
    warn = raw.pop("premium_warn_pct", 1.0) / 100
    warn_intl = raw.pop("premium_warn_international_pct", 2.0) / 100
    if "lookbacks" in raw:
        raw["lookbacks"] = tuple(raw["lookbacks"])
    if raw.get("weights"):
        raw["weights"] = tuple(raw["weights"])
    return LiveSettings(Config(**raw), warn, warn_intl)


# --- refresh ------------------------------------------------------------------------------------


@dataclass
class Health:
    today: date
    sources: dict[str, str] = field(default_factory=dict)  # instrument -> where today's came from
    last_day: dict[str, date | None] = field(default_factory=dict)
    failures: dict[str, str] = field(default_factory=dict)
    fyers: str = "not used"

    def stale(self, names: list[str], as_of: date) -> list[str]:
        return [n for n in names if (self.last_day.get(n) or date.min) < as_of]


@dataclass(frozen=True)
class WeeklySnapshot:
    """One refreshed source snapshot shared by every favourited strategy.

    Running multiple strategies must not fetch the same market data repeatedly:
    aside from wasting quota, that would let later strategies see a different
    source state from the active strategy that is sent to Telegram.
    """

    health: Health
    universe: list[Instrument]
    today: date
    week_ending: date


def week_ending_on_or_before(day: date) -> date:
    """Return the Friday labelling the most recent completed NSE week."""
    return day - timedelta(days=(day.weekday() - 4) % 7)


def last_nse_session(health: Health, names: list[str], week_ending: date) -> date | None:
    """Latest observed NSE session in the Monday-Friday week ending ``week_ending``.

    NSE does not trade every Friday. The weekly series deliberately labels a
    Thursday holiday-week close as Friday, so this chooses Thursday (or an
    earlier session for consecutive holidays) without changing the established
    weekly index convention.
    """
    week_start = week_ending - timedelta(days=4)
    dates = [
        observed
        for name in names
        if (observed := health.last_day.get(name)) is not None
        and week_start <= observed <= week_ending
    ]
    return max(dates, default=None)


def _read(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    return pd.read_csv(path, index_col=0, parse_dates=True).sort_index()


def _merge(path: Path, new: pd.DataFrame, rescale: float = 1.0) -> pd.DataFrame:
    """New rows win; older rows are multiplied by `rescale` (a unit split in the window)."""
    old = _read(path)
    if old is not None and not old.empty:
        kept = old[old.index < new.index.min()] * rescale if len(new) else old
        later = old[(old.index > new.index.max())] if len(new) else old.iloc[0:0]
        new = pd.concat([kept, new, later]).sort_index()
        new = new[~new.index.duplicated(keep="last")]
    path.parent.mkdir(parents=True, exist_ok=True)
    new.to_csv(path, index_label="date")
    return new


def _etf_implied(signal: pd.DataFrame, etf: pd.DataFrame) -> pd.DataFrame:
    """Extend an index series past its last close using its ETF's daily moves."""
    last = signal["close"].last_valid_index()
    later = etf[etf.index > last]
    if later.empty or last not in etf.index:
        return signal.iloc[0:0]
    scale = signal.at[last, "close"] / etf.at[last, "close"]
    return (later * scale)[["close"]]


def refresh(
    data_dir: Path,
    today: date,
    creds,
    log=print,
    universe: list[Instrument] | None = None,
    until: date | None = None,
) -> Health:
    """Re-fetch the last REFRESH_DAYS of every series into data_dir and rebuild the recent
    rows of weekly_closes.csv. Older history (and each series' backfill join) is untouched.
    `until` drops anything later - the preview passes yesterday, because during market hours
    the sources return today's still-moving candle and that must never be stored."""
    health = Health(today, fyers=f"token from {creds.source}" if creds else "no token")
    start = today - timedelta(days=REFRESH_DAYS)
    until = until or today

    def window(frame: pd.DataFrame) -> pd.DataFrame:
        days = frame.index.date
        return frame[(days >= start) & (days <= until)]

    universe = universe or load_universe()
    daily_dir, etf_dir = data_dir / "daily", data_dir / "daily_etf"
    etf_new: dict[str, pd.DataFrame] = {}

    # ETFs first: they're the fallback for any index an official source doesn't have yet.
    for inst in universe:
        if inst.etf_source == ETF_SAME:
            continue
        try:
            if creds is not None:
                raw = fyers.daily_candles(inst.etf_source, start, today, creds)
            else:
                raw = yahoo_candles(f"{inst.trade_etf}.NS", start)
            etf_new[inst.name] = window(raw)
        except Exception as error:
            health.failures[f"{inst.trade_etf} (ETF)"] = str(error)[:120]

    signal_new: dict[str, pd.DataFrame] = {}
    for inst in universe:
        source, frame, how = inst.price_source, None, ""
        try:
            if source.startswith("NSE:") and creds is not None:
                frame, how = fyers.daily_candles(source, start, today, creds), "fyers"
            elif source.startswith("NSE:") and inst.backfill.startswith("NIFTYINDICES:"):
                name = inst.backfill.removeprefix("NIFTYINDICES:")
                frame, how = niftyindices_candles(name, start, today), "niftyindices"
            elif source.startswith("NSE:") and source.endswith("-EQ"):  # e.g. GOLDBEES
                frame, how = yahoo_candles(source[4:-3] + ".NS", start), "yahoo"
            elif source.startswith("AMFI:"):
                frame = amfi_nav(source.removeprefix("AMFI:"), start).to_frame("close")
                how = "amfi"
            elif source.startswith("INDEXFX:"):
                _, index_symbol, fx_symbol, when = source.split(":")
                closes = index_in_inr(index_symbol, fx_symbol, start, previous_close=when == "prev")
                frame, how = closes.to_frame("close"), "yahoo"
            elif source == "SILVER":
                frame, how = silver_daily(start).to_frame("close"), "yahoo"
        except fyers.FyersCredentialsError:
            raise
        except Exception as error:
            health.failures[inst.name] = str(error)[:120]
        old = _read(daily_dir / f"{inst.name}.csv")
        if frame is not None and len(frame):
            frame = window(frame)
        if (frame is None or frame.empty or frame.index[-1].date() < until) and (
            inst.name in etf_new and old is not None
        ):
            base = old if frame is None or frame.empty else pd.concat([old, frame])
            base = base[~base.index.duplicated(keep="last")].sort_index()
            implied = _etf_implied(base, etf_new[inst.name])
            if len(implied):
                frame = implied if frame is None or frame.empty else pd.concat([frame, implied])
                how = f"{how}+ETF-implied" if how else "ETF-implied"
        if frame is None or frame.empty:
            health.last_day[inst.name] = old.index[-1].date() if old is not None else None
            continue
        signal_new[inst.name] = frame
        merged = _merge(daily_dir / f"{inst.name}.csv", frame)
        health.sources[inst.name] = how
        health.last_day[inst.name] = merged.index[-1].date()

    for inst in universe:
        if inst.name not in etf_new or etf_new[inst.name].empty:
            continue
        raw = etf_new[inst.name]
        reference = _read(daily_dir / f"{inst.name}.csv")
        factors = (
            split_factors(raw["close"], reference["close"])
            if reference is not None
            else pd.Series(1.0, index=raw.index)
        )
        _merge(etf_dir / f"{inst.name}.csv", raw.mul(factors, axis=0), float(factors.iloc[0]))
        if inst.amfi_code:
            try:
                nav = amfi_nav(inst.amfi_code, start, adjust=False)
                premium = (raw["close"] / nav.reindex(raw.index) - 1).dropna()
                premium = premium[premium.abs() <= 0.5]
                table = _read(data_dir / "etf_premium.csv")
                table = pd.DataFrame() if table is None else table
                for day, value in premium.items():
                    table.loc[day, inst.name] = value
                table.sort_index().to_csv(data_dir / "etf_premium.csv", index_label="date")
            except Exception as error:
                health.failures[f"{inst.trade_etf} (NAV)"] = str(error)[:120]

    _rebuild_weekly(data_dir, signal_new, start)
    return health


def _rebuild_weekly(data_dir: Path, fresh: dict[str, pd.DataFrame], start: date) -> None:
    path = data_dir / "weekly_closes.csv"
    table = _read(path)
    table = pd.DataFrame() if table is None else table
    first_week = pd.offsets.Week(weekday=4).rollforward(pd.Timestamp(start))  # Friday on/after
    for name in fresh:
        daily = _read(data_dir / "daily" / f"{name}.csv")
        if daily is None:
            continue
        recent = weekly(daily["close"])
        recent = recent[recent.index >= first_week].dropna()
        for week, value in recent.items():
            table.loc[week, name] = value
    table = table.sort_index()
    table.index.name = "week_ending"
    table.to_csv(path)


# --- live preview -------------------------------------------------------------------------------


def live_prices(
    universe: list[Instrument], data_dir: Path, creds, now: datetime
) -> tuple[dict[str, float], dict[str, float], dict[str, str]]:
    """(index level now, ETF price now, how) per instrument, for the preview."""
    fyers_quotes: dict[str, float] = {}
    if creds is not None:
        symbols = [i.price_source for i in universe if i.price_source.startswith("NSE:")]
        symbols += [i.etf_source for i in universe if i.etf_source.startswith("NSE:")]
        fyers_quotes = fyers.quotes(sorted(set(symbols)), creds)
    index_now, etf_now, how = {}, {}, {}
    for inst in universe:
        daily = _read(data_dir / "daily" / f"{inst.name}.csv")
        if daily is None or daily.empty:
            continue
        last_close = float(daily["close"].iloc[-1])
        etf_price = None
        if inst.etf_source.startswith("NSE:"):
            etf_price = fyers_quotes.get(inst.etf_source)
            if etf_price is None:
                try:
                    price, when = yahoo_quote(f"{inst.trade_etf}.NS")
                    etf_price = price if when.date() == now.date() else None
                except Exception:
                    etf_price = None
        if etf_price is not None:
            etf_now[inst.name] = etf_price
        if inst.price_source in fyers_quotes:
            index_now[inst.name], how[inst.name] = fyers_quotes[inst.price_source], "fyers live"
        elif inst.price_source.startswith("NSE:") and inst.price_source.endswith("-EQ"):
            try:
                price, when = yahoo_quote(inst.price_source[4:-3] + ".NS")
                if when.date() == now.date():
                    index_now[inst.name], how[inst.name] = price, "yahoo live"
            except Exception:
                pass
        elif etf_price is not None:
            etf_daily = _read(data_dir / "daily_etf" / f"{inst.name}.csv")
            if etf_daily is not None and not etf_daily.empty:
                ratio = etf_price / float(etf_daily["close"].iloc[-1])
                index_now[inst.name], how[inst.name] = last_close * ratio, "ETF-implied live"
        if inst.name not in index_now:
            # NAVs, previous-US-close series, and anything without a live price: the latest
            # known value is what's known right now.
            index_now[inst.name], how[inst.name] = last_close, "last close"
    return index_now, etf_now, how


def apply_preview(data_dir: Path, today: date, index_now: dict, etf_now: dict) -> None:
    """Write today's live prices into a (scratch) data folder as if they were the close."""
    stamp = pd.Timestamp(today)
    for name, value in index_now.items():
        path = data_dir / "daily" / f"{name}.csv"
        _merge(path, pd.DataFrame({"close": [value]}, index=[stamp]))
    for name, value in etf_now.items():
        path = data_dir / "daily_etf" / f"{name}.csv"
        if path.exists():
            _merge(path, pd.DataFrame({"close": [value]}, index=[stamp]))
    _rebuild_weekly(data_dir, dict.fromkeys(index_now), today - timedelta(days=6))


# --- the signal ---------------------------------------------------------------------------------


def compute_signal(data_dir: Path, settings: LiveSettings) -> dict:
    """The model portfolio's action list at the latest week in data_dir."""
    universe = load_universe()
    prices = pd.read_csv(data_dir / "weekly_closes.csv", index_col=0, parse_dates=True)
    includes = {i.name: i.include for i in universe}
    # Only the fill *timing* is a backtest question; the live signal is always at this close.
    config = replace(settings.config, execution="fri_close")
    fills = build_trade_prices(prices, config.track, "fri_close", universe, data_dir)
    tax_classes = {i.name: i.tax_class for i in universe} if config.tax is not None else None
    result = run_backtest(
        prices,
        includes,
        config,
        tax_classes=tax_classes,
        trade_prices=fills.prices if fills is not None else None,
    )
    signal = analysis.latest_signal(result, prices, config)
    by_name = {i.name: i for i in universe}
    premiums = load_premiums(data_dir)
    previous = result.ranks.iloc[-2] if len(result.ranks) > 1 else pd.Series(dtype=float)
    rows = []
    for row in signal["rows"]:
        name = row["asset"]
        inst = by_name.get(name)
        premium = None
        if name in premiums and premiums[name].notna().any():
            premium = float(premiums[name].dropna().iloc[-1])
        rows.append(
            {
                "asset": name,
                "etf": inst.trade_etf if inst else name,
                "group": inst.group if inst else "",
                "rank": None if pd.isna(row["rank"]) else int(row["rank"]),
                "previous_rank": None if pd.isna(previous.get(name)) else int(previous[name]),
                "action": row["action"],
                "held": row["held"],
                "premium": premium,
            }
        )
    weights = result.weights.iloc[-1] if len(result.weights) else pd.Series(dtype=float)
    return {
        "week": f"{signal['week']:%Y-%m-%d}",
        "label": config.label,
        "explain": signal["explain"],
        "rows": rows,
        "weights": {k: round(float(v), 4) for k, v in weights.items() if v > 1e-6},
        "config": {
            "top_n": config.top_n,
            "exit_rank": config.exit_rank,
            "track": config.track,
            "lookbacks": list(config.lookbacks),
        },
    }


def changes(preview: dict | None, final: dict) -> list[str]:
    if not preview:
        return []
    before = {r["asset"]: r["action"] for r in preview["rows"]}
    out = []
    for row in final["rows"]:
        was = before.get(row["asset"], "")
        if (was or row["action"]) and was != row["action"]:
            out.append(f"{row['asset']}: {was or '-'} -> {row['action'] or '-'}")
    return out


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.1%}"


def format_message(
    signal: dict,
    run: str,
    health: Health,
    settings: LiveSettings,
    now: datetime,
    live_how: dict[str, str] | None = None,
    changed: list[str] | None = None,
) -> Notification:
    rows = signal["rows"]
    universe = {i.name: i for i in load_universe()}
    intl = {n for n, i in universe.items() if i.tax_class == "international"}

    def line(r: dict) -> str:
        text = f"• {r['asset']} ({r['etf']}) — rank {r['rank'] if r['rank'] else '-'}"
        limit = settings.premium_warn_international if r["asset"] in intl else settings.premium_warn
        if r["premium"] is not None:
            text += f" · premium {_pct(r['premium'])}"
            if r["action"].startswith(("BUY", "ADD")) and r["premium"] > limit:
                text += " ⚠️ buying above NAV"
        return text

    groups = [
        ("SELL", lambda a: a == "SELL"),
        ("TRIM", lambda a: a.startswith("TRIM")),
        ("BUY / TOP UP", lambda a: a.startswith(("BUY", "ADD"))),
        ("HOLD", lambda a: a in ("HOLD", "AT CAP")),
        ("WAITING FOR A SALE", lambda a: a == "WAIT"),
    ]
    cfg = signal["config"]
    lines = [
        f"Model portfolio · top {cfg['top_n']}, sell when rank > {cfg['exit_rank']} · "
        f"P&L on {'ETFs' if cfg['track'] == 'etf' else 'index'}",
    ]
    trades = [r for r in rows if r["action"] and r["action"] not in ("HOLD", "AT CAP", "WAIT")]
    if not trades:
        lines.append("No trades this week.")
    for title, match in groups:
        picked = [r for r in rows if r["action"] and match(r["action"])]
        if picked:
            lines += ["", title, *[line(r) for r in picked]]
    movers = [
        r
        for r in rows
        if r["rank"] and r["previous_rank"] and abs(r["rank"] - r["previous_rank"]) >= 3
    ]
    movers.sort(key=lambda r: -(abs(r["rank"] - r["previous_rank"])))
    if movers:
        lines += ["", "Biggest rank moves"]
        lines += [
            f"{'↑' if r['rank'] < r['previous_rank'] else '↓'} {r['asset']} "
            f"{r['previous_rank']} → {r['rank']}"
            for r in movers[:6]
        ]
    if changed:
        lines += ["", "Changed since the preview", *[f"• {c}" for c in changed]]
    elif run == "final" and changed is not None:
        lines += ["", "Same as the preview."]
    lines += ["", _health_line(health, live_how)]
    if run == "preview" and (now.hour, now.minute) > LAST_SAFE_PREVIEW:
        lines += ["", "⏰ Sent after 15:15 IST - likely too late to trade before today's close."]
    title = f"Momentum {run.upper()} — week of {pd.Timestamp(signal['week']):%d %b %Y}"
    severity = "action_required" if trades else "info"
    return Notification(
        "momentum-weekly", severity, title, "\n".join(lines), type=f"momentum.{run}"
    )


def _health_line(health: Health, live_how: dict[str, str] | None) -> str:
    parts = [f"Fyers: {health.fyers}"]
    estimated = sorted(n for n, how in health.sources.items() if "ETF-implied" in how)
    if estimated:
        parts.append(f"estimated from ETF: {', '.join(estimated)}")
    if live_how:
        kinds = pd.Series(live_how).value_counts()
        parts.append("live prices: " + ", ".join(f"{k} {v}" for k, v in kinds.items()))
    if health.failures:
        parts.append(f"failed: {', '.join(sorted(health.failures))}")
    return "Data · " + " · ".join(parts)


# --- the run ------------------------------------------------------------------------------------


@dataclass
class RunResult:
    notification: Notification
    signal: dict | None


def refresh_weekly_snapshot(
    run: str,
    data_dir: Path,
    now: datetime,
    creds,
    conn=None,
    log=print,
) -> WeeklySnapshot:
    """Refresh once, then let every weekly strategy read identical closes."""
    today = now.date()
    universe = load_universe()
    week_ending = week_ending_on_or_before(today)
    # A final run on Saturday/Monday must still close the preceding completed
    # week, never accidentally incorporate an incomplete new week.
    until = week_ending if run == "final" else today - timedelta(days=1)
    health = refresh(data_dir, today, creds, log, universe, until)
    if conn is not None:
        from . import local_store as store

        store.push_dir(conn, data_dir, pd.Timestamp(today - timedelta(days=REFRESH_DAYS)))
    return WeeklySnapshot(health=health, universe=universe, today=today, week_ending=week_ending)


def settings_from_saved_config(config: dict) -> LiveSettings:
    """Convert a dashboard ETF configuration into the weekly engine's settings.

    Dashboard requests include transport/UI-only keys such as ``dataset``;
    accepting only actual ``Config`` fields prevents a saved UI shape from
    silently changing the scheduled strategy contract.
    """
    allowed = {item.name for item in fields(Config)}
    engine_config = {key: value for key, value in config.items() if key in allowed}
    # The dashboard saves tax as a bool plus a separate slab_rate (the API builds TaxRules from
    # them); passing the raw bool through made `False is not None` read as "tax on".
    engine_config["tax"] = (
        TaxRules(slab_rate=config.get("slab_rate", 0.30)) if config.get("tax") else None
    )
    # A saved run's `end` is the date it was saved on; the live signal always runs to the
    # latest week, or every later Friday would silently repeat that week's signal.
    engine_config.pop("end", None)
    for key in ("lookbacks", "weights", "universe"):
        if isinstance(engine_config.get(key), list):
            engine_config[key] = tuple(engine_config[key])
    return LiveSettings(Config(**engine_config))


def run_weekly(
    run: str,
    data_dir: Path = DATA_DIR,
    now: datetime | None = None,
    creds=None,
    settings: LiveSettings | None = None,
    conn=None,
    log=print,
    snapshot: WeeklySnapshot | None = None,
    display_name: str | None = None,
) -> RunResult:
    """Refresh data_dir, compute the signal, and return the Telegram message to send.
    `conn` (optional) stores fresh official prices and the signal; `creds` is Fyers.
    `display_name` (B6) is the saved favourite's human name — stored alongside the signal
    so a reader doesn't have to decode the engine's config-derived label (e.g.
    "buffer-wait-cap35_off_top5_exit10_lb1-4-13-26-52_etf-fri_close") to show which
    favourite a saved signal came from. The engine label itself is left untouched as the
    database's config_label key, since `load_signal`'s preview/final lookup depends on it."""
    now = (now or datetime.now(IST)).astimezone(IST)
    settings = settings or load_live_config()
    today = now.date()
    if today.weekday() != 4:
        log(f"note: today is {today:%A}, not Friday - running anyway")

    if snapshot is None:
        snapshot = refresh_weekly_snapshot(run, data_dir, now, creds, conn, log)
    elif snapshot.today != today:
        raise ValueError("weekly snapshot date does not match the requested run")
    health, universe = snapshot.health, snapshot.universe

    ranked = [i.name for i in universe if i.include == "core"]
    nse = [i.name for i in universe if i.price_source.startswith("NSE:") and i.name in ranked]

    if run == "final":
        session = last_nse_session(health, nse, snapshot.week_ending)
        if session is None:
            return RunResult(_closed(snapshot.week_ending, health), None)
        stale = health.stale(ranked, session)
        if len(stale) > STALE_LIMIT * len(ranked):
            return RunResult(_stale_alert(session, stale, health), None)
        signal = compute_signal(data_dir, settings)
        previous = None
        if conn is not None:
            from . import local_store as store

            previous = store.load_signal(conn, signal["week"], "preview", signal["label"])
        changed = changes(previous, signal) if previous is not None else None
        note = format_message(signal, "final", health, settings, now, None, changed)
        if session != snapshot.week_ending:
            note.body += (
                f"\n\nOfficial close: {session:%a %d %b} "
                f"(Friday {snapshot.week_ending:%d %b} was a market holiday)."
            )
        if conn is not None:
            signal["display_name"] = display_name or signal["label"]
            store.save_signal(conn, signal["week"], "final", signal["label"], signal)
        return RunResult(note, signal)

    # Preview: live prices go into a scratch copy, never into data_dir or the database.
    with tempfile.TemporaryDirectory() as scratch:
        scratch_dir = Path(scratch) / "data"
        shutil.copytree(data_dir, scratch_dir)
        index_now, etf_now, how = live_prices(universe, scratch_dir, creds, now)
        live = [n for n, h in how.items() if h != "last close" and n in nse]
        if not live:
            return RunResult(_closed(today, health, preview=True), None)
        apply_preview(scratch_dir, today, index_now, etf_now)
        signal = compute_signal(scratch_dir, settings)
    note = format_message(signal, "preview", health, settings, now, how)
    if conn is not None:
        from . import local_store as store

        signal["display_name"] = display_name or signal["label"]
        store.save_signal(conn, signal["week"], "preview", signal["label"], signal)
    return RunResult(note, copy.deepcopy(signal))


def run_favorite_strategies(
    run: str,
    data_dir: Path = DATA_DIR,
    now: datetime | None = None,
    creds=None,
    conn=None,
    log=print,
) -> list[dict]:
    """Evaluate every eligible favourite against one shared weekly snapshot.

    The ETF rotation is the only strategy family with a completed weekly
    refresh path today. Stock/Custom/Broad favourites are deliberately
    returned as blocked rather than evaluated on stale daily data; the
    source-aware stock ingest planner promotes them once its bhavcopy gate is
    satisfied. This prevents a misleading Telegram recommendation.
    """
    from . import runs_store

    now = (now or datetime.now(IST)).astimezone(IST)
    favorites = runs_store.list_favorites(conn) if conn is not None else []
    if not favorites:
        # Preserve the existing scheduled-job behaviour until the user has
        # saved and favourited a strategy.
        result = run_weekly(
            run, data_dir, now, creds, conn=conn, log=log, display_name="Default live strategy"
        )
        return [
            {
                "id": None,
                "name": "Default live strategy",
                "dataset": "etf",
                "active": True,
                "result": result,
                "blocked": None,
            }
        ]

    snapshot = refresh_weekly_snapshot(run, data_dir, now, creds, conn, log)
    outcomes = []
    for favorite in favorites:
        config = favorite["config"]
        dataset = config.get("dataset", "etf")
        if dataset != "etf":
            outcomes.append(
                {
                    "id": favorite["id"],
                    "name": favorite["name"],
                    "dataset": dataset,
                    "active": favorite["active"],
                    "result": None,
                    "blocked": "Weekly ingest is not yet available for this dataset.",
                }
            )
            continue
        try:
            result = run_weekly(
                run,
                data_dir,
                now,
                creds,
                settings=settings_from_saved_config(config),
                conn=conn,
                log=log,
                snapshot=snapshot,
                display_name=favorite["name"],
            )
            blocked = None
        except (ValueError, KeyError) as error:
            result = None
            blocked = str(error)
        outcomes.append(
            {
                "id": favorite["id"],
                "name": favorite["name"],
                "dataset": dataset,
                "active": favorite["active"],
                "result": result,
                "blocked": blocked,
            }
        )
    return outcomes


def _closed(today: date, health: Health, preview: bool = False) -> Notification:
    what = "no live NSE prices for today" if preview else "no NSE closes dated today"
    return Notification(
        "momentum-weekly",
        "info",
        f"Momentum: no signal for {today:%d %b} - market closed?",
        f"{what.capitalize()} (a holiday, or the sources haven't published yet).\n"
        + _health_line(health, None),
        type="momentum.problem",
    )


def _stale_alert(today: date, stale: list[str], health: Health) -> Notification:
    return Notification(
        "momentum-weekly",
        "error",
        "Momentum: data too stale for a signal",
        f"{len(stale)} series have no close for {today:%d %b}: {', '.join(stale)}.\n"
        + _health_line(health, None),
        type="momentum.problem",
    )
