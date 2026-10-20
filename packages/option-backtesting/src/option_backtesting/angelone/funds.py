"""
The Angel One account's funds, read-only (BL-143, the 09:05 margin check): SmartAPI's `getRMS`
(`GET /rest/secure/angelbroking/user/v1/getRMS`), one call after one guarded login
(`check.session(source="margin")`), the session dropped. Never places or changes anything.

A SmartAPI session is scoped to the API key and the client code: Angel One's SmartAPI FAQ on
AB1010 says one session is active per API key and client, a new one replacing the earlier one
with the same key. `ANGELONE_API_KEY` is this repo's own SmartAPI app; Quantiply logs in through
Angel's publisher login with its own key, so this login does not replace Quantiply's session.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .auth import AngelCredentialsError, Get, Session, get_json, request_headers

RMS_PATH = "/rest/secure/angelbroking/user/v1/getRMS"


@dataclass(frozen=True)
class Funds:
    #: what the account can still use for new positions (SmartAPI's `net`)
    net: float
    available_cash: float | None
    utilised: float | None

    def as_dict(self) -> dict:
        return asdict(self)


def _number(value: object) -> float | None:
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def parse_rms(payload: dict) -> Funds:
    """`getRMS`'s answer -> Funds. Raises AngelCredentialsError when it is not a success."""
    if not payload.get("status"):
        code = str(payload.get("errorcode") or "")
        message = str(payload.get("message") or "no status")[:160]
        raise AngelCredentialsError(f"Angel One funds: {code} {message}".strip())
    data = payload.get("data") or {}
    net = _number(data.get("net"))
    if net is None:
        raise AngelCredentialsError("Angel One funds: the answer has no `net` figure")
    return Funds(
        net=net,
        available_cash=_number(data.get("availablecash")),
        utilised=_number(data.get("utiliseddebits")),
    )


def read_funds(session: Session, get: Get = get_json) -> Funds:
    headers = request_headers(session.api_key, session.public_ip, session.jwt)
    status, payload = get(RMS_PATH, headers)
    if status == 0:
        raise AngelCredentialsError(f"Angel One funds: not reached ({payload.get('message')})")
    return parse_rms(payload)
