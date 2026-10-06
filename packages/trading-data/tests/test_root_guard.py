"""The data root may live on an external volume (an APFS image on the SSD). A root on a
volume that is not mounted must fail loudly, never fall back or create a fresh root."""

import pytest
from typer.testing import CliRunner

from trading_data.cli import app
from trading_data.db import check_mounted, connect, data_root

NOT_MOUNTED = "/Volumes/bl034-test-volume-that-is-not-mounted/TradingData"


def test_a_root_on_an_unmounted_volume_is_refused(monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", NOT_MOUNTED)
    with pytest.raises(RuntimeError, match="not mounted"):
        data_root()
    with pytest.raises(RuntimeError, match="not mounted"):
        connect().__enter__()
    assert str(data_root(require_mounted=False)) == NOT_MOUNTED


def test_a_dangling_symlink_to_an_unmounted_volume_is_refused(tmp_path):
    link = tmp_path / "TradingData"
    link.symlink_to(NOT_MOUNTED)
    with pytest.raises(RuntimeError, match="not mounted"):
        check_mounted(link)


def test_ordinary_roots_are_unaffected(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path / "data"))
    assert data_root() == tmp_path / "data"
    check_mounted(tmp_path)  # not under /Volumes: nothing to check


def test_mount_is_a_no_op_when_the_root_is_available(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    result = CliRunner().invoke(app, ["mount"])
    assert result.exit_code == 0
    assert "mounted" in result.output


def test_mount_explains_what_is_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("TRADING_DATA_ROOT", NOT_MOUNTED)
    monkeypatch.delenv("TRADING_DATA_IMAGE", raising=False)
    result = CliRunner().invoke(app, ["mount"])
    assert result.exit_code == 1
    assert "TRADING_DATA_IMAGE is not set" in result.output

    monkeypatch.setenv("TRADING_DATA_IMAGE", str(tmp_path / "missing.sparsebundle"))
    result = CliRunner().invoke(app, ["mount"])
    assert result.exit_code == 1
    assert "is the SSD connected" in result.output
