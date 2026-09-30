"""T1 acceptance: nse.py's HTTP client (throttle, retries, caps, cookie jar) and
safe zip extraction. No network — `NseClient._opener.open` is replaced with a
fake in-memory transport (see `_install_fake_opener`)."""

from __future__ import annotations

import io
import urllib.error
import zipfile

import pytest

from momentum_backtesting.stocks import nse


class _FakeResponse:
    """Minimal stand-in for `http.client.HTTPResponse`: context-manager + a
    chunked `.read(n)`, which is all `_read_capped` needs."""

    def __init__(self, body: bytes):
        self._buf = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://x", code, f"status {code}", None, None)


def _install_fake_opener(client: nse.NseClient, responses: list):
    """`responses` is a list of callables (req, timeout) -> bytes | Exception,
    consumed in order, one per underlying `opener.open` call."""
    calls: list[str] = []

    def fake_open(req, timeout=None):  # noqa: ARG001 - matches OpenerDirector.open
        calls.append(req.full_url)
        outcome = responses.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return _FakeResponse(outcome)

    client._opener.open = fake_open
    return calls


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    """Keep retry/backoff/throttle tests fast without changing the production
    THROTTLE_SECONDS/backoff constants themselves."""
    monkeypatch.setattr(nse.time, "sleep", lambda _seconds: None)


# --------------------------------------------------------------------------
# get_bytes: success, 404, retryable failures, non-retryable failures
# --------------------------------------------------------------------------


def test_get_bytes_success_uses_browser_user_agent_and_referer():
    client = nse.NseClient()
    seen_requests = []

    def fake_open(req, timeout=None):  # noqa: ARG001
        seen_requests.append(req)
        return _FakeResponse(b"hello")

    client._opener.open = fake_open
    body = client.get_bytes("http://example/a.zip", referer="http://example/page")

    assert body == b"hello"
    assert len(seen_requests) == 1
    assert seen_requests[0].get_header("User-agent") == nse.USER_AGENT
    assert seen_requests[0].get_header("Referer") == "http://example/page"


def test_get_bytes_404_raises_not_found_without_retry():
    client = nse.NseClient(max_retries=3)
    calls = _install_fake_opener(client, [_http_error(404)])

    with pytest.raises(nse.NseNotFoundError):
        client.get_bytes("http://example/missing.zip")

    assert len(calls) == 1  # never retried


@pytest.mark.parametrize("code", [403, 429, 500, 503])
def test_get_bytes_retries_on_retryable_statuses_then_succeeds(code):
    client = nse.NseClient(max_retries=3)
    _install_fake_opener(client, [_http_error(code), _http_error(code), b"ok-body"])

    body = client.get_bytes("http://example/a.zip")

    assert body == b"ok-body"


@pytest.mark.parametrize("code", [403, 429, 500])
def test_get_bytes_gives_up_after_max_retries(code):
    client = nse.NseClient(max_retries=2)
    calls = _install_fake_opener(client, [_http_error(code)] * 3)

    with pytest.raises(nse.NseError):
        client.get_bytes("http://example/a.zip")

    assert len(calls) == 3  # initial attempt + 2 retries


def test_get_bytes_does_not_retry_non_retryable_http_error():
    client = nse.NseClient(max_retries=3)
    calls = _install_fake_opener(client, [_http_error(401)])

    with pytest.raises(nse.NseError):
        client.get_bytes("http://example/a.zip")

    assert len(calls) == 1


def test_get_bytes_retries_on_timeout():
    client = nse.NseClient(max_retries=2)
    _install_fake_opener(client, [TimeoutError("timed out"), b"ok-body"])

    assert client.get_bytes("http://example/a.zip") == b"ok-body"


def test_get_bytes_response_over_cap_raises_and_is_not_retried():
    client = nse.NseClient(max_retries=3)
    big = b"x" * (nse.MAX_ZIP_RESPONSE_BYTES + 1)
    calls = _install_fake_opener(client, [big])

    with pytest.raises(nse.NseResponseTooLargeError):
        client.get_bytes("http://example/a.zip")

    assert len(calls) == 1  # not treated as a transient failure


# --------------------------------------------------------------------------
# get_json
# --------------------------------------------------------------------------


def test_get_json_parses_body_and_appends_params():
    client = nse.NseClient()
    seen_requests = []

    def fake_open(req, timeout=None):  # noqa: ARG001
        seen_requests.append(req.full_url)
        return _FakeResponse(b'{"ok": true, "n": 3}')

    client._opener.open = fake_open
    result = client.get_json("http://example/api", params={"a": "1", "b": "two"})

    assert result == {"ok": True, "n": 3}
    assert "a=1" in seen_requests[0]
    assert "b=two" in seen_requests[0]


def test_get_json_invalid_json_raises_nse_error():
    client = nse.NseClient()
    _install_fake_opener(client, [b"not json"])

    with pytest.raises(nse.NseError):
        client.get_json("http://example/api")


def test_get_json_over_cap_raises():
    client = nse.NseClient()
    _install_fake_opener(client, [b"x" * (nse.MAX_JSON_RESPONSE_BYTES + 1)])

    with pytest.raises(nse.NseResponseTooLargeError):
        client.get_json("http://example/api")


# --------------------------------------------------------------------------
# Throttle
# --------------------------------------------------------------------------


def test_throttle_enforces_minimum_gap_between_requests(monkeypatch):
    client = nse.NseClient()
    _install_fake_opener(client, [b"a", b"b"])

    sleep_calls: list[float] = []
    monkeypatch.setattr(nse.time, "sleep", lambda s: sleep_calls.append(s))

    fake_clock = {"t": 0.0}
    monkeypatch.setattr(nse.time, "monotonic", lambda: fake_clock["t"])

    client.get_bytes("http://example/a")
    fake_clock["t"] += 0.1  # well under THROTTLE_SECONDS
    client.get_bytes("http://example/b")

    assert any(s >= nse.THROTTLE_SECONDS - 0.1 - 1e-9 for s in sleep_calls)


# --------------------------------------------------------------------------
# Cookie jar: in-memory only, populated from warm_up, never persisted
# --------------------------------------------------------------------------


def test_warm_up_populates_cookie_jar_in_memory_only(tmp_path):
    client = nse.NseClient()

    def fake_open(req, timeout=None):  # noqa: ARG001
        # Simulate NSE setting a session cookie on the homepage response by
        # inserting directly into the jar, exactly as HTTPCookieProcessor would.
        import http.cookiejar

        cookie = http.cookiejar.Cookie(
            0,
            "nsit",
            "abc123",
            None,
            False,
            "example",
            False,
            False,
            "/",
            False,
            False,
            None,
            False,
            None,
            None,
            {},
        )
        client.cookie_jar.set_cookie(cookie)
        return _FakeResponse(b"<html></html>")

    client._opener.open = fake_open
    client.warm_up()

    assert len(client.cookie_jar) == 1
    # Nothing on disk represents the jar — it truly only lives in the process.
    assert list(tmp_path.iterdir()) == []


# --------------------------------------------------------------------------
# extract_single_member (zip safety)
# --------------------------------------------------------------------------


def _zip_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_extract_single_member_happy_path():
    zbytes = _zip_bytes({"a.csv": b"hello,world"})
    assert nse.extract_single_member(zbytes) == b"hello,world"


def test_extract_single_member_rejects_non_pk_body():
    with pytest.raises(nse.NseZipFormatError):
        nse.extract_single_member(b"not a zip at all")


def test_extract_single_member_rejects_multiple_members():
    zbytes = _zip_bytes({"a.csv": b"1", "b.csv": b"2"})
    with pytest.raises(nse.NseZipFormatError):
        nse.extract_single_member(zbytes)


def test_extract_single_member_rejects_zero_members():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w"):
        pass
    with pytest.raises(nse.NseZipFormatError):
        nse.extract_single_member(buf.getvalue())


def test_extract_single_member_caps_decompressed_read_not_header_size():
    # The zip's own local-file-header will claim the true (small) uncompressed
    # size; extract_single_member must not trust that -- it must cap the
    # *actual* bytes read back out during decompression against `max_bytes`.
    zbytes = _zip_bytes({"a.csv": b"y" * 1000})
    with pytest.raises(nse.NseResponseTooLargeError):
        nse.extract_single_member(zbytes, max_bytes=10)


# --------------------------------------------------------------------------
# atomic_write_bytes
# --------------------------------------------------------------------------


def test_atomic_write_bytes_writes_final_file_and_leaves_no_tmp(tmp_path):
    target = tmp_path / "sub" / "out.bin"
    nse.atomic_write_bytes(target, b"payload")

    assert target.read_bytes() == b"payload"
    leftovers = [p for p in target.parent.iterdir() if p != target]
    assert leftovers == []


def test_atomic_write_bytes_cleans_up_tmp_file_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "out.bin"

    def boom(_src, _dst):
        raise OSError("simulated failure")

    monkeypatch.setattr(nse.os, "replace", boom)

    with pytest.raises(OSError):
        nse.atomic_write_bytes(target, b"payload")

    assert not target.exists()
    assert list(tmp_path.iterdir()) == []  # tmp file was cleaned up, not left behind
