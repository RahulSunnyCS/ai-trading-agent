"""Shared NSE HTTP client: cookie jar, throttling, and safe zip/JSON extraction.

nse.py carries no bhavcopy- or corporate-actions-specific logic — bhavcopy.py (T1)
and corporate_actions.py (T2) both build on it. See plan.md §5 for the security
requirements this module exists to enforce: the cookie jar lives in memory only
(never persisted or logged), downloads are capped before and after decompression,
and requests are throttled and bounded-retry.
"""

from __future__ import annotations

import io
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass, field
from http.cookiejar import CookieJar
from pathlib import Path
from typing import IO
from urllib.request import HTTPCookieProcessor

#: NSE's bot-detection is UA-sensitive; a plain browser UA avoids the 403s a bare
#: urllib default UA gets.
USER_AGENT = "Mozilla/5.0 (compatible; momentum-backtesting research fetch)"

#: Minimum seconds between requests to the same host (plan.md §5: "≥0.35 s throttle").
THROTTLE_SECONDS = 0.35

#: Response-body caps, enforced while streaming (plan.md §5), independent of the
#: post-decompression cap in extract_single_member.
MAX_ZIP_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024

#: Cap on the decompressed size read out of a zip member (zip-bomb guard).
MAX_EXTRACTED_BYTES = 50 * 1024 * 1024

#: Bounded retries for transient failures (connection reset, 5xx, throttled 403).
MAX_RETRIES = 3

#: HTTP status codes worth retrying (rate limiting / bot-block); anything >=500
#: is retried too (see _request below). Everything else fails immediately.
_RETRYABLE_STATUSES = (403, 429)

#: Read/backoff chunk size used by both the HTTP streaming cap and the zip
#: member cap, so neither trusts a length claimed up front (Content-Length or
#: the zip local-file-header's uncompressed size).
_CHUNK_SIZE = 65536


class NseError(Exception):
    """Base class for every error this module raises."""


class NseNotFoundError(NseError):
    """The server returned 404 — there is no file at this URL (e.g. a market
    holiday's bhavcopy). Never retried: a 404 is not a transient failure.
    """


class NseResponseTooLargeError(NseError):
    """A response body (or a zip member once decompressed) exceeded its size
    cap. Never retried — a legitimately oversized response is not transient.
    """


class NseZipFormatError(NseError):
    """The bytes handed to `extract_single_member` are not a well-formed,
    single-member zip.
    """


def _backoff_seconds(attempt: int) -> float:
    """Exponential backoff for retry `attempt` (0-indexed), capped at 30s."""
    return min(2.0**attempt, 30.0)


def _read_capped(resp: IO[bytes], max_bytes: int) -> bytes:
    """Read `resp` in chunks, raising as soon as more than `max_bytes` have
    arrived — never trusts a Content-Length header, since that's attacker-
    controlled input just like the body itself.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = resp.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise NseResponseTooLargeError(
                f"response body exceeded the {max_bytes}-byte cap while streaming"
            )
        chunks.append(chunk)
    return b"".join(chunks)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write `data` to `path` atomically: write to a sibling temp file first,
    then `os.replace` it into place, so a process killed mid-write never
    leaves a partial file visible at `path` (plan.md §5).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    try:
        tmp_path.write_bytes(data)
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


@dataclass
class NseClient:
    """A polite, cookie-persisting HTTP client for nseindia.com and niftyindices.com.

    Construct one instance per fetch run (`mbt stocks fetch`) and reuse it for every
    request that run makes, so the cookie jar and throttle state are shared. The
    cookie jar is in-memory only — it is never written to disk, logged, or included
    in any error message (plan.md §5).
    """

    cookie_jar: CookieJar = field(default_factory=CookieJar)
    user_agent: str = USER_AGENT
    max_retries: int = MAX_RETRIES
    _last_request_at: float | None = field(default=None, init=False, repr=False)
    #: Built once in __post_init__. Tests substitute `client._opener.open` with a
    #: fake to avoid any real network access — this is the one seam this module
    #: exposes for that purpose; every retry/throttle/cap rule still runs.
    _opener: urllib.request.OpenerDirector = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._opener = urllib.request.build_opener(HTTPCookieProcessor(self.cookie_jar))

    def _throttle(self) -> None:
        if self._last_request_at is not None:
            remaining = THROTTLE_SECONDS - (time.monotonic() - self._last_request_at)
            if remaining > 0:
                time.sleep(remaining)
        self._last_request_at = time.monotonic()

    def warm_up(self) -> None:
        """Prime the cookie jar with an initial GET of the NSE homepage.

        NSE's API/zip endpoints 403 without a same-session cookie from a prior
        homepage visit. Call this once before the first get_bytes/get_json call
        of a run.
        """
        self._throttle()
        req = urllib.request.Request(
            "https://www.nseindia.com/",
            headers={"User-Agent": self.user_agent, "Accept": "text/html,application/xhtml+xml"},
        )
        with self._opener.open(req, timeout=30.0) as resp:
            _read_capped(resp, MAX_JSON_RESPONSE_BYTES)

    def _request(self, url: str, *, referer: str | None, timeout: float, max_bytes: int) -> bytes:
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            self._throttle()
            headers = {"User-Agent": self.user_agent, "Accept": "*/*"}
            if referer:
                headers["Referer"] = referer
            req = urllib.request.Request(url, headers=headers)
            try:
                with self._opener.open(req, timeout=timeout) as resp:
                    return _read_capped(resp, max_bytes)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise NseNotFoundError(f"404 Not Found: {url}") from e
                last_exc = e
                if (e.code in _RETRYABLE_STATUSES or e.code >= 500) and attempt < self.max_retries:
                    time.sleep(_backoff_seconds(attempt))
                    continue
                raise NseError(f"HTTP {e.code} fetching {url}") from e
            except (TimeoutError, urllib.error.URLError, ConnectionError, OSError) as e:
                last_exc = e
                if attempt < self.max_retries:
                    time.sleep(_backoff_seconds(attempt))
                    continue
                raise NseError(f"request failed for {url}: {e}") from e
        raise NseError(f"request failed for {url}") from last_exc  # pragma: no cover

    def get_bytes(self, url: str, *, referer: str | None = None, timeout: float = 60.0) -> bytes:
        """GET raw bytes, throttled (THROTTLE_SECONDS between requests to the same
        client), capped at MAX_ZIP_RESPONSE_BYTES, retried up to max_retries times
        on a transient failure. Raises on a non-2xx status after retries are exhausted.
        """
        return self._request(
            url, referer=referer, timeout=timeout, max_bytes=MAX_ZIP_RESPONSE_BYTES
        )

    def get_json(
        self,
        url: str,
        *,
        params: dict[str, str] | None = None,
        referer: str | None = None,
        timeout: float = 60.0,
    ) -> dict:
        """GET and parse a JSON body, capped at MAX_JSON_RESPONSE_BYTES. Same
        throttle/retry behaviour as get_bytes. Raises if the body isn't valid JSON
        or exceeds the size cap.
        """
        full_url = f"{url}?{urllib.parse.urlencode(params)}" if params else url
        body = self._request(
            full_url, referer=referer, timeout=timeout, max_bytes=MAX_JSON_RESPONSE_BYTES
        )
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as e:
            raise NseError(f"non-UTF-8 JSON body from {url}") from e
        try:
            import json

            return json.loads(text)
        except json.JSONDecodeError as e:
            raise NseError(f"invalid JSON body from {url}: {e}") from e


def extract_single_member(zip_bytes: bytes, *, max_bytes: int = MAX_EXTRACTED_BYTES) -> bytes:
    """Safely extract the one member of a single-file zip (an NSE bhavcopy zip
    always has exactly one member).

    Validates the zip magic bytes before handing the buffer to `zipfile`, refuses
    an archive with zero or more than one member, and caps the decompressed read
    at `max_bytes` — a truncated/zip-bomb read raises rather than exhausting memory.
    """
    if zip_bytes[:2] != b"PK":
        raise NseZipFormatError("not a zip file (missing PK magic bytes)")
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise NseZipFormatError(f"invalid zip: {e}") from e
    names = zf.namelist()
    if len(names) != 1:
        raise NseZipFormatError(f"expected exactly one zip member, found {len(names)}")
    # zf.open().read(n) decompresses in chunks as requested — it never trusts the
    # local-file-header's declared uncompressed size, so a hostile header claiming
    # a small size cannot be used to smuggle a larger payload past this cap.
    with zf.open(names[0]) as member:
        return _read_capped(member, max_bytes)
