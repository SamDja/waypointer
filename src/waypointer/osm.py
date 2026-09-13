"""Overpass API query construction and HTTP client for OSM POI lookups."""

import hashlib
import os
import threading
import time
from dataclasses import dataclass

import requests

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
    # Populated only for way/relation results: every vertex of the element's
    # own geometry (its building outline, area boundary, or member ways), so
    # the caller can pick whichever vertex sits closest to the route instead
    # of relying on a single bounding-box centroid - see query_overpass.
    # None for plain node results.
    way_points: list[tuple[float, float]] | None = None


def build_overpass_query(
    coords: list[tuple[float, float]],
    tag_filter: str = 'nwr["amenity"="drinking_water"]',
    radius_m: int = 10,
    timeout_s: int = 90,
) -> str:
    """Builds an Overpass QL query matching tag_filter within radius_m of the
    polyline formed by coords, using the `around` distance-to-line operator.

    tag_filter should select the `nwr` (node/way/relation) type where the
    underlying OSM tag can genuinely appear on more than a node - many
    real-world POIs (e.g. a mountain hut mapped as a building outline) are
    tagged on a way or relation, not a point. `out body geom;` returns full
    tags for every element, plus each way/relation's full vertex geometry
    (nodes already carry their own lat/lon).
    """
    if not coords:
        raise ValueError("coords must contain at least one point")
    coord_pairs = ",".join(f"{lat},{lon}" for lat, lon in coords)
    return (
        f"[out:json][timeout:{timeout_s}];\n"
        f"{tag_filter}(around:{radius_m},{coord_pairs});\n"
        "out body geom;"
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


def _cache_key(query: str, url: str) -> str:
    return hashlib.sha256(f"{url}\n{query}".encode()).hexdigest()


def _geometry_points(geometry: list[dict] | None) -> list[tuple[float, float]]:
    """Extracts (lat, lon) tuples from an Overpass `out geom;` geometry
    array, skipping any entry missing a coordinate (Overpass emits a null
    placeholder for a way member it couldn't resolve)."""
    if not geometry:
        return []
    return [(pt["lat"], pt["lon"]) for pt in geometry if pt and "lat" in pt and "lon" in pt]


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
        nodes = []
        for el in payload["elements"]:
            el_type = el.get("type")
            if el_type == "node":
                nodes.append(
                    OsmNode(id=el["id"], lat=el["lat"], lon=el["lon"], tags=el.get("tags", {}))
                )
                continue

            if el_type == "way":
                way_points = _geometry_points(el.get("geometry"))
            elif el_type == "relation":
                # `out geom;` nests each member's own geometry rather than
                # giving the relation one geometry list - flatten every
                # member's points (way members' "geometry" arrays, plus any
                # node members' own lat/lon) into one candidate list. Role
                # (inner/outer) doesn't matter here: any vertex is a valid
                # candidate position to test against the route.
                way_points = []
                for member in el.get("members", []):
                    way_points.extend(_geometry_points(member.get("geometry")))
                    if member.get("type") == "node" and "lat" in member and "lon" in member:
                        way_points.append((member["lat"], member["lon"]))
            else:
                continue

            if not way_points:
                # No usable geometry at all (e.g. an unresolved relation
                # member) - skip rather than error the whole query out over
                # one malformed element.
                continue
            nodes.append(
                OsmNode(
                    id=el["id"],
                    lat=way_points[0][0],
                    lon=way_points[0][1],
                    tags=el.get("tags", {}),
                    way_points=way_points,
                )
            )
    except (ValueError, KeyError, TypeError) as exc:
        raise OverpassError(f"Overpass API returned malformed data: {exc}") from exc

    if use_cache:
        _cache.set(key, nodes)
    return nodes
