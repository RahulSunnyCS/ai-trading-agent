"""`obt` must read the repo .env before every command, not only the ones that resolve
Fyers credentials — otherwise TRADING_DATA_ROOT never reaches `obt daily --no-fetch` or
`obt legwise run`, and they silently use the default root."""

from typer.testing import CliRunner

from option_backtesting import cli
from option_backtesting.fyers import auth


def test_every_command_loads_the_repo_env_first(monkeypatch):
    calls = []
    monkeypatch.setattr(auth, "load_dotenv", lambda: calls.append("loaded"))
    result = CliRunner().invoke(cli.app, ["legwise", "--help"])
    assert result.exit_code == 0
    assert calls == ["loaded"]
