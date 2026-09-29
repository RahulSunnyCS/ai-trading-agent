from datetime import date, datetime

from option_backtesting.cli import _last_closed_session
from option_backtesting.legwise.daily import (
    StrategyFile,
    load_history,
    load_strategy_files,
    run_day,
    summary,
    telegram_failure,
    telegram_summary,
)

STRATEGY = """\
strategy:
  id: s1
  underlying: NIFTY
  entry_time: "09:20"
  exit_time: "15:00"
  legs:
    - {id: ce, lots: 1, position: sell, option_type: CE, strike: {strike_type: ATM}}
"""


def _files(tmp_path, text=STRATEGY) -> list[StrategyFile]:
    folder = tmp_path / "strategies"
    folder.mkdir(exist_ok=True)
    (folder / "s1.yaml").write_text(text)
    return load_strategy_files(folder)


def test_missing_underlying_day_is_skipped_not_fatal(tmp_path):
    [record] = run_day(date(2026, 9, 29), tmp_path / "data", _files(tmp_path))
    assert "skipped" in record and "no Fyers data" in record["skipped"]
    assert load_history(tmp_path / "data") == []


def test_results_from_an_edited_strategy_are_not_counted(tmp_path):
    old = _files(tmp_path)[0]
    history = [
        {"strategy_id": "s1", "strategy_sha": old.sha, "net": 100.0},
        {"strategy_id": "s1", "strategy_sha": "something-else", "net": -5000.0},
    ]
    text = summary(date(2026, 9, 29), [], history, [old])
    assert "so far: +100 over 1 days (1 up)" in text
    assert "1 older day(s) ran an earlier version" in text


def test_default_day_is_the_last_session_that_has_closed():
    # Tue 29 Sep 2026 after the close -> that day; before it -> Monday 28th.
    assert _last_closed_session(datetime(2026, 9, 29, 18, 0)) == date(2026, 9, 29)
    assert _last_closed_session(datetime(2026, 9, 29, 11, 0)) == date(2026, 9, 28)
    # Just after midnight on Wednesday -> Tuesday.
    assert _last_closed_session(datetime(2026, 9, 30, 0, 5)) == date(2026, 9, 29)
    # Saturday 3 Oct -> Thursday 1 Oct (Friday 2 Oct is Gandhi Jayanti).
    assert _last_closed_session(datetime(2026, 10, 3, 12, 0)) == date(2026, 10, 1)


def test_telegram_summary_lines_and_severity(tmp_path):
    [file] = _files(tmp_path)
    today = [
        {
            "strategy_id": "s1",
            "strategy_sha": file.sha,
            "net": -2919.0,
            "trades": [{}, {}],
            "stopped_by": "overall SL at 11:30",
        }
    ]
    history = [*today, {"strategy_id": "s1", "strategy_sha": file.sha, "net": 1000.0}]
    n = telegram_summary(date(2026, 9, 29), today, history, [file])
    assert n.severity == "info"
    assert n.title == "Options daily Tue 29 Sep: -2,919"
    assert "s1: -2,919 (2 trades, overall SL at 11:30)" in n.body
    assert "so far -1,919 over 2 days" in n.body
    assert telegram_summary(date(2026, 9, 29), today, history, [file], 3).severity == "warn"


def test_telegram_failure_asks_for_login_on_a_token_problem():
    n = telegram_failure(date(2026, 9, 29), "No valid Fyers token. Log in once for today")
    assert n.severity == "action_required" and "SAME evening" in n.body
    assert telegram_failure(date(2026, 9, 29), "disk full").severity == "error"


def test_render_never_leaks_the_bot_token(monkeypatch):
    from option_backtesting.notify import Notification, render

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123456:secret-token")
    text = render(Notification("src", "error", "boom", "token was 123456:secret-token"))
    assert "secret-token" not in text and "***REDACTED***" in text


def test_terminal_summary_says_1_trade_not_1_trades(tmp_path):
    [file] = _files(tmp_path)
    rec = {
        "strategy_id": "s1",
        "strategy_sha": file.sha,
        "net": 5.0,
        "notes": [],
        "stopped_by": None,
        "trades": [
            {
                "leg": "ce",
                "contract": "X",
                "entry": "09:20",
                "entry_price": 1.0,
                "exit": "15:00",
                "exit_price": 1.0,
                "reason": "EXIT_TIME",
                "pnl": 5.0,
            }
        ],
    }
    text = summary(date(2026, 9, 29), [rec], [rec], [file])
    assert "over 1 trade" in text and "1 trades" not in text
