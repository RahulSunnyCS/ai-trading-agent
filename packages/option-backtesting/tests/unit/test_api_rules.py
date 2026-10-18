"""`/legwise/rules/*` (BL-120): the spec is checked and read back, the confirmation lock answers 403,
and the ledger and results are readable. The test job itself needs the lake and is run by the
acceptance script, not here."""

from __future__ import annotations

import yaml
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.ruletest import store
from tests.unit.test_ruletest_spec import BASE

client = TestClient(create_app())
TEXT = yaml.safe_dump({"rule": BASE})


def test_validate_reads_the_rule_back():
    r = client.post("/legwise/rules/validate", json={"text": TEXT})
    body = r.json()
    assert r.status_code == 200 and body["ok"] and len(body["spec_hash"]) == 16
    assert body["sides"] == ["both"] and body["window"] == ["10:30", "14:00"]
    assert body["sentences"][0].startswith("Watch the NIFTY index")


def test_validate_names_the_problem():
    bad = yaml.safe_dump({"rule": {**BASE, "when": {"gt": ["close", "nope"]}}})
    r = client.post("/legwise/rules/validate", json={"text": bad})
    assert r.status_code == 422 and "unknown name 'nope'" in r.json()["error"]
    assert client.post("/legwise/rules/validate", json={"text": "x" * 20_001}).status_code == 422


def test_confirmation_is_refused_while_locked_and_the_ledger_starts_empty():
    r = client.post("/legwise/rules/test", json={"text": TEXT, "periods": ["confirmation"]})
    assert r.status_code == 403 and "locked for this strategy" in r.json()["error"]
    assert (
        client.post("/legwise/rules/test", json={"text": TEXT, "periods": ["nope"]}).status_code
        == 422
    )
    assert client.post("/legwise/rules/test", json={"text": TEXT, "mode": "x"}).status_code == 422
    assert client.get("/legwise/rules/tests").json() == {
        "tests": [],
        "counts": {"week": 0, "month": 0, "total": 0},
    }
    assert client.get("/legwise/rules/job").json()["state"] in ("idle", "done", "failed")


def test_reveal_then_results_are_readable(tmp_path):
    spec_hash = client.post("/legwise/rules/validate", json={"text": TEXT}).json()["spec_hash"]
    assert client.post("/legwise/rules/reveal", json={"spec_hash": spec_hash}).status_code == 200
    assert client.post("/legwise/rules/reveal", json={"spec_hash": "../../x"}).status_code == 422
    from option_backtesting.fyers.daily import data_dir

    store.record_test(
        data_dir(),
        {"id": "20261008-120000-abcd", "at": "2026-10-08T12:00:00+05:30", "tries": 1},
        {"ok": 1},
    )
    assert client.get("/legwise/rules/tests/20261008-120000-abcd").json() == {"ok": 1}
    assert client.get("/legwise/rules/tests/..%2f..%2fx").status_code == 404
    assert client.get("/legwise/rules/tests").json()["counts"]["total"] == 1
    assert client.get("/legwise/rules/periods").json()["data_cutoff"] == "2026-10-08"
