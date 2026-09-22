"""Place search for the map's search box (/api/geocode).

Turns a typed name ("Vattaro", "Passo Manghen") into places to jump the map
to. Photon (komoot's public, OSM-based geocoder) because it's built for
search-as-you-type and needs no API key; Nominatim's usage policy forbids
autocomplete.

Structured like routing.py - an "external HTTP dependency with a cache":
env-overridable URL, a shared TTLCache, the same descriptive User-Agent,
and one error type the endpoint maps to a 502.
"""

import os
from dataclasses import dataclass

import requests

from waypointer.geometry import LatLon
from waypointer.routing import USER_AGENT
from waypointer.ttl_cache import TTLCache

GEOCODE_URL = os.environ.get("GEOCODE_URL", "https://photon.komoot.io/api/")

CACHE_TTL_S = 3600.0
MAX_RESULTS = 6
MIN_QUERY_LENGTH = 3
MAX_QUERY_LENGTH = 200

# Only places a rider would jump the map to: settlements and localities
# (`place`), natural features like peaks, saddles and lakes (`natural`), and
# mountain passes. Photon ORs repeated include filters. Without them, a
# search for a village also returns its bus stops, shops elsewhere with the
# same name, and its cemetery (checked 2026-09-22).
PLACE_TAG_FILTERS = ("place", "natural", "mountain_pass")


class GeocodeError(RuntimeError):
    """Raised when the geocoding request fails or returns malformed data."""


@dataclass(frozen=True)
class Place:
    name: str
    # Where it is, for telling same-named places apart: "Altopiano della
    # Vigolana, Provincia di Trento, Italy".
    context: str
    # What it is, from its OSM tag value: "village", "peak", "saddle", ...
    kind: str
    lat: float
    lon: float
    # [west, south, east, north] for an area, so the map can frame it
    # whole; None for a point.
    bbox: tuple[float, float, float, float] | None


_cache: TTLCache[list[Place]] = TTLCache(CACHE_TTL_S)


def _place(feature: dict) -> Place | None:
    """One Photon GeoJSON feature as a Place, or None if it's unusable."""
    try:
        props = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"][:2]
        name = props.get("name")
    except (KeyError, TypeError, ValueError):
        return None
    if not name:
        return None
    parts = [props.get(key) for key in ("city", "county", "state", "country")]
    context = ", ".join(dict.fromkeys(p for p in parts if p and p != name))
    bbox = None
    extent = props.get("extent")
    if isinstance(extent, list) and len(extent) == 4:
        # Photon's extent is [west, north, east, south].
        west, north, east, south = (float(v) for v in extent)
        bbox = (west, south, east, north)
    return Place(
        name=str(name),
        context=context,
        kind=str(props.get("osm_value") or props.get("osm_key") or "place"),
        lat=float(lat),
        lon=float(lon),
        bbox=bbox,
    )


def search_places(
    query: str,
    near: LatLon | None = None,
    session: requests.Session | None = None,
    url: str = GEOCODE_URL,
    use_cache: bool = True,
) -> list[Place]:
    """Places matching `query`, the best first, biased towards `near` (the
    map's centre) so the Trento you mean comes before the one in Rovigo.

    Raises ValueError for a query too short or too long, GeocodeError if the
    geocoder fails.
    """
    query = query.strip()
    if not MIN_QUERY_LENGTH <= len(query) <= MAX_QUERY_LENGTH:
        raise ValueError(f"A search needs {MIN_QUERY_LENGTH} to {MAX_QUERY_LENGTH} characters.")

    # The bias is rounded to ~10km, so panning the map a little still hits
    # the cache for the same query.
    bias = (round(near[0], 1), round(near[1], 1)) if near else None
    key = f"{url}\n{query.lower()}\n{bias}"
    if use_cache:
        cached = _cache.get(key)
        if cached is not None:
            return cached

    params: list[tuple[str, str]] = [("q", query), ("limit", str(MAX_RESULTS))]
    if bias:
        params += [("lat", str(bias[0])), ("lon", str(bias[1]))]
    params += [("osm_tag", tag) for tag in PLACE_TAG_FILTERS]

    http = session or requests
    try:
        response = http.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=15)
    except requests.RequestException as exc:
        raise GeocodeError(f"Place search failed: {exc}") from exc
    if response.status_code != 200:
        raise GeocodeError(f"Place search returned status {response.status_code}: {response.text[:200]}")
    try:
        features = response.json()["features"]
    except (ValueError, KeyError, TypeError) as exc:
        raise GeocodeError(f"Place search returned malformed data: {exc}") from exc

    places = [place for place in (_place(f) for f in features if isinstance(f, dict)) if place]
    if use_cache:
        _cache.set(key, places)
    return places
