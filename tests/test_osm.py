import pytest
import responses

from waypointer.osm import (
    OVERPASS_URL,
    OsmNode,
    OverpassError,
    build_overpass_query,
    query_overpass,
)


def test_build_overpass_query_contains_around_clause():
    coords = [(48.0, 2.0), (48.001, 2.001)]
    query = build_overpass_query(coords, radius_m=50)
    assert "around:50,48.0,2.0,48.001,2.001" in query
    assert 'node["amenity"="drinking_water"]' in query
    assert "out body;" in query


def test_build_overpass_query_requires_coords():
    with pytest.raises(ValueError):
        build_overpass_query([])


@responses.activate
def test_query_overpass_parses_nodes(overpass_response_json):
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    nodes = query_overpass("fake query", use_cache=False)
    assert len(nodes) == 2
    assert all(isinstance(n, OsmNode) for n in nodes)
    assert nodes[0].tags.get("amenity") == "drinking_water"


@responses.activate
def test_query_overpass_raises_on_bad_status():
    responses.add(responses.POST, OVERPASS_URL, body="Server error", status=500)
    with pytest.raises(OverpassError):
        query_overpass("fake query", use_cache=False)


@responses.activate
def test_query_overpass_raises_on_malformed_json():
    responses.add(responses.POST, OVERPASS_URL, body="not json", status=200)
    with pytest.raises(OverpassError):
        query_overpass("fake query", use_cache=False)


@responses.activate
def test_query_overpass_uses_cache(overpass_response_json):
    responses.add(responses.POST, OVERPASS_URL, json=overpass_response_json, status=200)
    query = "identical query text"
    first = query_overpass(query, use_cache=True)
    second = query_overpass(query, use_cache=True)
    assert first == second
    assert len(responses.calls) == 1
