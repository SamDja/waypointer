"""Overpass API query construction and HTTP client for OSM POI lookups."""

import hashlib
import os
import threading
import time
from dataclasses import dataclass

import requests

from waypointer.geometry import haversine_m

# Defaults to the official public instance; set OVERPASS_URL to point at a
# self-hosted one instead (e.g. http://overpass:80/api/interpreter in Docker
# Compose). Previously defaulted to a third-party mirror
# (maps.mail.ru/osm/tools/overpass/api/interpreter) which measured a
# consistent 13-18s per query (sometimes timing out outright) against
# identical requests that overpass-api.de answers in well under a second -
# not a load/rate-limit artifact of this app, since a single ad-hoc query
# from an idle connection showed the same gap.
OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")

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


class _TTLCache:
    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._lock = threading.Lock()
        self._store: dict[str, tuple[float, list[OsmNode]]] = {}

    def get(self, key: str) -> list[OsmNode] | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: list[OsmNode]) -> None:
        with self._lock:
            self._store[key] = (time.monotonic() + self._ttl_s, value)


_cache = _TTLCache(CACHE_TTL_S)
# A shared, process-wide session so repeated calls reuse one keep-alive HTTPS
# connection instead of paying a fresh TCP+TLS handshake every time - real
# savings once a query actually needs to reach Overpass (a cache hit skips
# this either way). The bare `requests` module used as query_overpass's
# default doesn't pool connections across separate top-level calls the way a
# Session does.
_session = requests.Session()


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

    http = session or _session
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


def nearest_node(nodes: list[OsmNode], lat: float, lon: float) -> OsmNode | None:
    """Picks the closest node to (lat, lon) from an Overpass result set -
    used by /api/lookup-poi to resolve a basemap POI icon click (which only
    has a click coordinate, not an OSM id) to the real node it represents."""
    if not nodes:
        return None
    return min(nodes, key=lambda n: haversine_m(lat, lon, n.lat, n.lon))
