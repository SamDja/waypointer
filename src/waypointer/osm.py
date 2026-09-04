"""Overpass API query construction and HTTP client for OSM POI lookups."""

import hashlib
import os
from dataclasses import dataclass

import requests

from waypointer.ttl_cache import TTLCache

# Defaults to a public mirror; set OVERPASS_URL to point at a self-hosted
# instance instead (e.g. http://overpass:80/api/interpreter in Docker Compose).
OVERPASS_URL = os.environ.get(
    "OVERPASS_URL", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
)

CACHE_TTL_S = 600.0
# Overpass's server rejects requests carrying the default python-requests
# User-Agent (406 Not Acceptable) and Overpass's usage policy asks clients
# to identify themselves anyway, so a descriptive UA is required, not optional.
USER_AGENT = "waypointer/0.1 (+https://github.com/SamDja/waypointer)"


class OverpassError(RuntimeError):
    """Raised when the Overpass API request fails or returns malformed data."""


@dataclass(frozen=True)
class OsmNode:
    id: int
    lat: float
    lon: float
    tags: dict[str, str]


def build_overpass_query(
    coords: list[tuple[float, float]],
    tag_filter: str = 'node["amenity"="drinking_water"]',
    radius_m: int = 10,
    timeout_s: int = 90,
) -> str:
    """Builds an Overpass QL query matching tag_filter within radius_m of the
    polyline formed by coords, using the `around` distance-to-line operator.
    """
    if not coords:
        raise ValueError("coords must contain at least one point")
    coord_pairs = ",".join(f"{lat},{lon}" for lat, lon in coords)
    return (
        f"[out:json][timeout:{timeout_s}];\n"
        f"{tag_filter}(around:{radius_m},{coord_pairs});\n"
        "out body;"
    )


_cache: TTLCache[list[OsmNode]] = TTLCache(CACHE_TTL_S)


def _cache_key(query: str, url: str) -> str:
    return hashlib.sha256(f"{url}\n{query}".encode()).hexdigest()


def query_overpass(
    query: str,
    session: requests.Session | None = None,
    url: str = OVERPASS_URL,
    use_cache: bool = True,
) -> list[OsmNode]:
    """Runs an Overpass QL query via POST and returns matching nodes.

    Uses a short-lived in-process cache keyed on the exact query text so that
    repeated searches for the same route within a short window (a public
    deployment can see this from a single visitor re-clicking, or from
    multiple visitors on overlapping routes) don't re-hit the shared,
    rate-limit-sensitive public Overpass instance.
    """
    key = _cache_key(query, url)
    if use_cache:
        cached = _cache.get(key)
        if cached is not None:
            return cached

    http = session or requests
    try:
        # Overpass expects the raw query text as the POST body, not a
        # `data=<query>` form field - the latter gets rejected (406) by
        # at least the overpass-api.de mirror.
        response = http.post(
            url, data=query, headers={"User-Agent": USER_AGENT}, timeout=30
        )
    except requests.RequestException as exc:
        raise OverpassError(f"Overpass request failed: {exc}") from exc

    if response.status_code != 200:
        raise OverpassError(
            f"Overpass API returned status {response.status_code}: {response.text[:200]}"
        )

    try:
        payload = response.json()
        nodes = [
            OsmNode(id=el["id"], lat=el["lat"], lon=el["lon"], tags=el.get("tags", {}))
            for el in payload["elements"]
            if el.get("type") == "node"
        ]
    except (ValueError, KeyError, TypeError) as exc:
        raise OverpassError(f"Overpass API returned malformed data: {exc}") from exc

    if use_cache:
        _cache.set(key, nodes)
    return nodes
