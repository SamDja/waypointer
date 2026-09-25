"""PostGIS-backed POI lookups, replacing the old Overpass-based osm.py.

Waypointer no longer queries the public Overpass API live. Instead, a
pre-built PostGIS database (see postgis/) holds only the OSM nodes/ways/
relations matching poi_types.py's searchable tag filters, imported ahead of
time via osm2pgsql (postgis/import_pois.lua mirrors poi_types.py's tag
filters in Lua - see that file's own docstring for the hand-mirroring
tradeoff, same one this repo already accepts for
frontend/src/lib/poiTypes.ts). This module is just the query layer against
that table - no HTTP, no remote rate limits, so unlike osm.py there's no
TTL cache here: repeat queries just hit local Postgres (backed by its own
shared_buffers/OS page cache), which is fast enough that an extra
application-level cache isn't worth the complexity.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

POSTGIS_URL_ENV = "POSTGIS_URL"

LatLon = tuple[float, float]


class PoiDbError(RuntimeError):
    """Raised when a PostGIS query fails, or POSTGIS_URL isn't configured."""


@dataclass(frozen=True)
class OsmNode:
    id: int
    lat: float
    lon: float
    tags: dict[str, str]
    # "node", "way", or "relation" - which kind of OSM element this is.
    # Defaults to "node" so call sites that synthesize an OsmNode from a
    # previously-selected Candidate (which never carried this field) don't
    # need to pass it explicitly.
    osm_type: str = "node"
    # Populated only for way/relation results: every vertex of the
    # element's own geometry (its building outline, area boundary, or
    # member ways), so the caller can pick whichever vertex sits closest to
    # the route instead of relying on a single bounding-box centroid. None
    # for plain node results.
    way_points: list[LatLon] | None = None
    # ISO 8601 timestamp of this element's last edit on OSM, imported via
    # osm2pgsql's --extra-attributes. None if the import didn't capture it.
    timestamp: str | None = None


_pool: ConnectionPool | None = None


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        url = os.environ.get(POSTGIS_URL_ENV)
        if not url:
            raise PoiDbError(
                f"{POSTGIS_URL_ENV} is not set - see CLAUDE.md's "
                "\"PostGIS POI database\" section for how to bring one up."
            )
        _pool = ConnectionPool(url, min_size=1, max_size=8, open=True)
    return _pool


def _iso(timestamp: datetime | int | float | str | None) -> str | None:
    """Normalizes osm_timestamp to the ISO 8601 string
    schemas.PoiLookupResult and the frontend expect, matching what
    Overpass's own `out meta` used to hand back directly as text.
    osm_timestamp comes back from psycopg as either a datetime
    (tests/test_poi_db.py's synthetic table declares it as a real
    timestamptz) or a plain int - the production import_pois.lua stores it
    as int8 Unix epoch seconds, since osm2pgsql's flex object.timestamp is
    an epoch number, not a string, despite its name."""
    if timestamp is None or isinstance(timestamp, str):
        return timestamp
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
    return timestamp.isoformat()


def _route_geog_wkt(route_coords: list[LatLon]) -> str:
    if not route_coords:
        raise ValueError("route_coords must contain at least one point")
    if len(route_coords) == 1:
        lat, lon = route_coords[0]
        return f"SRID=4326;POINT({lon} {lat})"
    points = ",".join(f"{lon} {lat}" for lat, lon in route_coords)
    return f"SRID=4326;LINESTRING({points})"


_NEAR_ROUTE_SQL = """
    SELECT p.osm_type, p.osm_id, p.tags, p.osm_timestamp,
           ST_Y(d.geom) AS lat, ST_X(d.geom) AS lon
    FROM pois p
    CROSS JOIN LATERAL ST_DumpPoints(p.geom) AS d(path, geom)
    WHERE p.poi_type = %(poi_type)s
      AND ST_DWithin(p.geom::geography, ST_GeogFromText(%(route_wkt)s), %(radius_m)s)
"""

_NEAR_POINT_SQL = """
    SELECT p.osm_type, p.osm_id, p.tags, p.osm_timestamp,
           ST_Y(ST_ClosestPoint(p.geom, c.pt)) AS lat,
           ST_X(ST_ClosestPoint(p.geom, c.pt)) AS lon
    FROM pois p, (SELECT ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326) AS pt) c
    WHERE p.poi_type = %(poi_type)s
      AND ST_DWithin(p.geom::geography, c.pt::geography, %(radius_m)s)
    ORDER BY p.geom::geography <-> c.pt::geography
    LIMIT 1
"""


_IN_BOUNDS_SQL = """
    SELECT p.osm_type, p.osm_id, p.poi_type, p.tags, p.osm_timestamp,
           ST_Y(ST_PointOnSurface(p.geom)) AS lat,
           ST_X(ST_PointOnSurface(p.geom)) AS lon
    FROM pois p
    WHERE p.poi_type = ANY(%(poi_types)s)
      AND (%(tag_matches)s::jsonb[] IS NULL OR p.tags @> ANY(%(tag_matches)s::jsonb[]))
      AND p.geom && ST_MakeEnvelope(
            %(min_lon)s, %(min_lat)s, %(max_lon)s, %(max_lat)s, 4326)
    LIMIT %(limit)s
"""


def query_pois_in_bounds(
    poi_types: list[str],
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int,
    tag_matches: list[dict[str, str]] | None = None,
) -> list[tuple[str, OsmNode]]:
    """Every imported POI of any of poi_types inside the bounding box, as
    (poi_type, node) pairs.

    For drawing our own POIs on the map, where the basemap's tiles simply
    don't carry them - `tourism=wilderness_hut` isn't in OpenMapTiles' POI
    mapping at all, so a bivouac can't come from the basemap however the
    style is written. Unlike the route and point queries this is driven by
    the viewport rather than by a route, hence the bbox and the hard limit:
    a whole-continent view would otherwise ask for every row in the table.

    `tag_matches` narrows within those types, as an OR of jsonb containment
    tests. It exists because a registry type is coarser than a map wants to
    draw: `lodging` covers hotels and hostels as well as mountain huts, and
    an overlay that drew every hotel in a town would be noise. Passing
    `[{"tourism": "alpine_hut"}, {"tourism": "wilderness_hut"}]` asks for
    the huts alone.

    `ST_PointOnSurface` rather than a centroid, because a POI imported as a
    way or a relation (a hut building, a park) needs a representative point
    that's actually *on* the feature.
    """
    if not poi_types:
        return []
    try:
        with _get_pool().connection() as conn:
            rows = conn.execute(
                _IN_BOUNDS_SQL,
                {
                    "poi_types": poi_types,
                    "min_lat": min_lat,
                    "min_lon": min_lon,
                    "max_lat": max_lat,
                    "max_lon": max_lon,
                    "limit": limit,
                    # psycopg adapts a list of dicts to jsonb[]; None makes
                    # the guard in the SQL skip the test entirely.
                    "tag_matches": (
                        [Jsonb(match) for match in tag_matches] if tag_matches else None
                    ),
                },
            ).fetchall()
    except psycopg.Error as exc:
        raise PoiDbError(f"PostGIS query failed: {exc}") from exc

    return [
        (
            poi_type,
            OsmNode(
                id=osm_id,
                lat=lat,
                lon=lon,
                tags=tags or {},
                osm_type=osm_type,
                timestamp=_iso(osm_timestamp),
            ),
        )
        for osm_type, osm_id, poi_type, tags, osm_timestamp, lat, lon in rows
    ]


def query_pois_near_route(
    poi_type: str, route_coords: list[LatLon], radius_m: float
) -> list[OsmNode]:
    """Every imported POI of poi_type within radius_m of the polyline formed
    by route_coords - the PostGIS equivalent of the old Overpass `around`
    query. Runs against the exact route_coords passed in - the caller can
    (and, for correctness, should) pass the full-resolution route rather
    than a simplified one: unlike the old remote Overpass query, there's no
    query-size reason to simplify first, and no radius-padding workaround
    is needed as a result.
    """
    route_wkt = _route_geog_wkt(route_coords)
    try:
        with _get_pool().connection() as conn:
            rows = conn.execute(
                _NEAR_ROUTE_SQL,
                {"poi_type": poi_type, "route_wkt": route_wkt, "radius_m": radius_m},
            ).fetchall()
    except psycopg.Error as exc:
        raise PoiDbError(f"PostGIS query failed: {exc}") from exc

    points_by_feature: dict[tuple[str, int], list[LatLon]] = {}
    meta_by_feature: dict[tuple[str, int], tuple[dict[str, str], str | None]] = {}
    for osm_type, osm_id, tags, osm_timestamp, lat, lon in rows:
        key = (osm_type, osm_id)
        points_by_feature.setdefault(key, []).append((lat, lon))
        meta_by_feature[key] = (tags or {}, osm_timestamp)

    nodes = []
    for (osm_type, osm_id), points in points_by_feature.items():
        tags, timestamp = meta_by_feature[(osm_type, osm_id)]
        nodes.append(
            OsmNode(
                id=osm_id,
                lat=points[0][0],
                lon=points[0][1],
                tags=tags,
                osm_type=osm_type,
                way_points=points if osm_type != "node" else None,
                timestamp=_iso(timestamp),
            )
        )
    return nodes


def query_poi_near_point(poi_type: str, lat: float, lon: float, radius_m: float) -> OsmNode | None:
    """The single imported POI of poi_type closest to (lat, lon), within
    radius_m - used to resolve a click on the basemap's own POI icon to the
    real OSM element behind it (see main.py's find_poi_at_location)."""
    try:
        with _get_pool().connection() as conn:
            row = conn.execute(
                _NEAR_POINT_SQL,
                {"poi_type": poi_type, "lat": lat, "lon": lon, "radius_m": radius_m},
            ).fetchone()
    except psycopg.Error as exc:
        raise PoiDbError(f"PostGIS query failed: {exc}") from exc

    if row is None:
        return None
    osm_type, osm_id, tags, osm_timestamp, r_lat, r_lon = row
    return OsmNode(
        id=osm_id,
        lat=r_lat,
        lon=r_lon,
        tags=tags or {},
        osm_type=osm_type,
        timestamp=_iso(osm_timestamp),
    )
