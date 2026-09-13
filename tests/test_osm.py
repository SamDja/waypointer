import pytest
import responses

from waypointer.osm import (
    OVERPASS_URL,
    OsmNode,
    OverpassError,
    build_overpass_query,
    nearest_node,
    query_overpass,
)


def test_build_overpass_query_contains_around_clause():
    coords = [(48.0, 2.0), (48.001, 2.001)]
    query = build_overpass_query(coords, radius_m=50)
    assert "around:50,48.0,2.0,48.001,2.001" in query
    assert 'nwr["amenity"="drinking_water"]' in query
    assert "out body geom;" in query


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
def test_query_overpass_captures_way_geometry():
    payload = {
        "elements": [
            {
                "type": "way",
                "id": 175901590,
                "geometry": [
                    {"lat": 45.9, "lon": 11.5},
                    {"lat": 45.901, "lon": 11.501},
                    {"lat": 45.9, "lon": 11.5},
                ],
                "tags": {"tourism": "alpine_hut", "name": "Malga Larici di Sotto"},
            }
        ]
    }
    responses.add(responses.POST, OVERPASS_URL, json=payload, status=200)
    nodes = query_overpass("fake query", use_cache=False)
    assert len(nodes) == 1
    assert nodes[0].way_points == [(45.9, 11.5), (45.901, 11.501), (45.9, 11.5)]
    assert (nodes[0].lat, nodes[0].lon) == (45.9, 11.5)
    assert nodes[0].tags.get("name") == "Malga Larici di Sotto"


@responses.activate
def test_query_overpass_flattens_relation_member_geometry():
    payload = {
        "elements": [
            {
                "type": "relation",
                "id": 99,
                "tags": {"leisure": "park"},
                "members": [
                    {
                        "type": "way",
                        "role": "outer",
                        "geometry": [{"lat": 45.9, "lon": 11.5}, {"lat": 45.91, "lon": 11.51}],
                    },
                    {"type": "node", "role": "label", "lat": 45.905, "lon": 11.505},
                ],
            }
        ]
    }
    responses.add(responses.POST, OVERPASS_URL, json=payload, status=200)
    nodes = query_overpass("fake query", use_cache=False)
    assert len(nodes) == 1
    assert nodes[0].way_points == [
        (45.9, 11.5),
        (45.91, 11.51),
        (45.905, 11.505),
    ]


@responses.activate
def test_query_overpass_skips_way_without_geometry():
    payload = {
        "elements": [
            {"type": "way", "id": 2, "tags": {"tourism": "alpine_hut"}},
        ]
    }
    responses.add(responses.POST, OVERPASS_URL, json=payload, status=200)
    nodes = query_overpass("fake query", use_cache=False)
    assert nodes == []


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


def test_nearest_node_returns_none_for_empty_list():
    assert nearest_node([], 48.0, 2.0) is None


def test_nearest_node_returns_only_node():
    node = OsmNode(id=1, lat=48.0, lon=2.0, tags={})
    assert nearest_node([node], 48.001, 2.001) is node


def test_nearest_node_picks_closest_of_several():
    near = OsmNode(id=1, lat=48.0001, lon=2.0001, tags={})
    far = OsmNode(id=2, lat=48.01, lon=2.01, tags={})
    assert nearest_node([far, near], 48.0, 2.0) is near
