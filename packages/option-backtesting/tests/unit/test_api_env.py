"""`obt-api` must load the repo .env before it resolves the bar cache: BACKTEST_DATA_DIR set
only in .env used to be ignored because the app was built at import time."""

from option_backtesting.api import app as app_module
from option_backtesting.fyers import auth


def test_main_loads_the_env_before_building_the_app(monkeypatch, tmp_path):
    monkeypatch.delenv("BACKTEST_DATA_DIR", raising=False)
    monkeypatch.setattr(
        auth, "load_dotenv", lambda: monkeypatch.setenv("BACKTEST_DATA_DIR", str(tmp_path))
    )
    served = []
    monkeypatch.setattr(app_module.uvicorn, "run", lambda app, **_kw: served.append(app))

    app_module.main()

    [app] = served
    assert app.state.cache_dir == tmp_path / "cache"
