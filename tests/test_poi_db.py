"""Integration tests for poi_db.py against a real PostGIS instance, via
testcontainers - these exercise the actual SQL (ST_DWithin/ST_DumpPoints/
ST_ClosestPoint), unlike test_api.py's monkeypatched poi_db functions.
Skipped cleanly if Docker isn't available in the current environment.
"""

import psycopg
import pytest
from psycopg.types.json import Jsonb

from waypointer import poi_db
from waypointer.poi_db import PoiDbError, query_poi_near_point, query_pois_near_route

try:
    from testcontainers.community.postgres import PostgresContainer
except ImportError:  # pragma: no cover - dev dependency, see pyproject.toml
    PostgresContainer = None

_CREATE_TABLE_SQL = """
    CREATE TABLE pois (
        db_id serial PRIMARY KEY,
        osm_type text NOT NULL,
        osm_id bigint NOT NULL,
        poi_type text NOT NULL,
        tags jsonb,
        osm_timestamp timestamptz,
        geom geometry NOT NULL
    );
"""


@pytest.fixture(scope="module")
def postgis_url():
    if PostgresContainer is None:
        pytest.skip("testcontainers is not installed")
    try:
        container = PostgresContainer("postgis/postgis:16-3.4")
        container.start()
    except Exception as exc:  # noqa: BLE001 - Docker unavailable in this environment
        pytest.skip(f"Docker/testcontainers unavailable: {exc}")
        return

    url = container.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
        conn.execute(_CREATE_TABLE_SQL)
    yield url
    container.stop()


@pytest.fixture(autouse=True)
def _configure_and_reset(postgis_url, monkeypatch):
    monkeypatch.setenv(poi_db.POSTGIS_URL_ENV, postgis_url)
    poi_db._pool = None
    with psycopg.connect(postgis_url, autocommit=True) as conn:
        conn.execute("TRUNCATE pois RESTART IDENTITY;")
    yield
    if poi_db._pool is not None:
        poi_db._pool.close()
        poi_db._pool = None


def _insert_point(conn, osm_type, osm_id, poi_type, lat, lon, tags=None, timestamp=None):
    conn.execute(
        "INSERT INTO pois (osm_type, osm_id, poi_type, tags, osm_timestamp, geom) "
        "VALUES (%s, %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))",
        (osm_type, osm_id, poi_type, Jsonb(tags or {}), timestamp, lon, lat),
    )


def _insert_linestring(conn, osm_type, osm_id, poi_type, points, tags=None):
    wkt = "LINESTRING(" + ",".join(f"{lon} {lat}" for lat, lon in points) + ")"
    conn.execute(
        "INSERT INTO pois (osm_type, osm_id, poi_type, tags, geom) "
        "VALUES (%s, %s, %s, %s, ST_GeomFromText(%s, 4326))",
        (osm_type, osm_id, poi_type, Jsonb(tags or {}), wkt),
    )


def _connect(postgis_url):
    return psycopg.connect(postgis_url, autocommit=True)


def test_query_pois_near_route_finds_node_within_radius(postgis_url):
    with _connect(postgis_url) as conn:
        _insert_point(
            conn, "node", 1, "water", 48.8567, 2.3524,
            tags={"name": "Fontaine Wallace"}, timestamp="2023-05-01T12:00:00Z",
        )
    route = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    nodes = query_pois_near_route("water", route, radius_m=50)
    assert len(nodes) == 1
    node = nodes[0]
    assert node.id == 1
    assert node.osm_type == "node"
    assert node.tags == {"name": "Fontaine Wallace"}
    assert node.timestamp == "2023-05-01T12:00:00+00:00"
    assert node.way_points is None


def test_query_pois_near_route_excludes_node_outside_radius(postgis_url):
    with _connect(postgis_url) as conn:
        _insert_point(conn, "node", 2, "water", 49.5, 3.5)  # far from the route
    route = [(48.8566, 2.3522), (48.857, 2.353)]
    nodes = query_pois_near_route("water", route, radius_m=50)
    assert nodes == []


def test_query_pois_near_route_only_returns_matching_poi_type(postgis_url):
    with _connect(postgis_url) as conn:
        _insert_point(conn, "node", 3, "toilet", 48.8567, 2.3524)
    route = [(48.8566, 2.3522), (48.857, 2.353)]
    assert query_pois_near_route("water", route, radius_m=50) == []
    assert len(query_pois_near_route("toilet", route, radius_m=50)) == 1


def test_query_pois_near_route_returns_way_vertices(postgis_url):
    near_point = (48.857, 2.35301)
    far_point = (49.5, 3.5)
    with _connect(postgis_url) as conn:
        _insert_linestring(conn, "way", 100, "water", [far_point, near_point])
    route = [(48.8566, 2.3522), (48.857, 2.353), (48.8575, 2.354)]
    nodes = query_pois_near_route("water", route, radius_m=50)
    assert len(nodes) == 1
    node = nodes[0]
    assert node.osm_type == "way"
    assert node.way_points is not None
    assert set(node.way_points) == {far_point, near_point}


def test_query_poi_near_point_returns_nearest_within_radius(postgis_url):
    with _connect(postgis_url) as conn:
        _insert_point(conn, "node", 1, "water", 48.8567, 2.3524, tags={"name": "Near"})
        _insert_point(conn, "node", 2, "water", 48.9, 2.5, tags={"name": "Far"})
    node = query_poi_near_point("water", lat=48.8567, lon=2.3524, radius_m=40)
    assert node is not None
    assert node.id == 1
    assert node.tags == {"name": "Near"}


def test_query_poi_near_point_returns_none_when_out_of_radius(postgis_url):
    with _connect(postgis_url) as conn:
        _insert_point(conn, "node", 1, "water", 49.5, 3.5)
    node = query_poi_near_point("water", lat=48.8567, lon=2.3524, radius_m=40)
    assert node is None


def test_query_pois_near_route_raises_poi_db_error_when_unconfigured(monkeypatch):
    monkeypatch.delenv(poi_db.POSTGIS_URL_ENV, raising=False)
    poi_db._pool = None
    with pytest.raises(PoiDbError):
        query_pois_near_route("water", [(48.0, 2.0), (48.001, 2.001)], radius_m=10)
