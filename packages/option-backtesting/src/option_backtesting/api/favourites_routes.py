"""`/legwise/favourites`: the lists and strategies the owner starred on the Strategies and baskets
page (`favourites.py`).

    GET /legwise/favourites   {lists, strategies, updated_at, is_default, warning}
    PUT /legwise/favourites   {lists: [...], strategies: [...]} replaces them; returns the same

The only write is the one small file `options_lab/favourites.json`; no ranking, journal entry or
result reads it. Errors come back as `{"error": ...}` (what the dashboard's api.ts reads), as in
`correlation_routes.py`.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .. import favourites

router = APIRouter(prefix="/legwise/favourites")


class FavouritesBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lists: list[str] = Field(max_length=len(favourites.LIST_KEYS))
    strategies: list[str] = Field(max_length=favourites.MAX_STRATEGIES * 2)


@router.get("")
def get_favourites() -> dict:
    return favourites.read().as_dict()


@router.put("", response_model=None)
def put_favourites(body: FavouritesBody) -> dict | JSONResponse:
    try:
        saved = favourites.write(body.lists, body.strategies)
    except favourites.FavouritesError as error:
        return JSONResponse(status_code=422, content={"error": str(error)})
    except OSError as error:
        return JSONResponse(
            status_code=503, content={"error": f"the favourites could not be saved: {error}"}
        )
    return saved.as_dict()
