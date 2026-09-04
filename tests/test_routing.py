import pytest
import responses

from waypointer.routing import (
    ROUTING_URL,
    RoutingError,
    build_routing_params,
    route_leg,
)

START = (47.376899, 8.541699)
END = (47.380000, 8.550000)


def test_build_routing_params_flips_to_lon_lat():
    params = build_routing_params(START, END, "fastbike-lowtraffic")
    # BRouter takes lon,lat pairs; this codebase stores (lat, lon) everywhere.
    assert params["lonlats"] == "8.541699,47.376899|8.55,47.38"
    assert params["profile"] == "fastbike-lowtraffic"
    assert params["format"] == "geojson"


def test_route_leg_rejects_unknown_profile():
    with pytest.raises(ValueError):
        route_leg(START, END, profile="car-fast", use_cache=False)


@responses.activate
def test_route_leg_parses_coords_and_elevations(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    leg = route_leg(START, END, use_cache=False)

    assert len(leg.coords) == 12
    assert len(leg.elevations) == len(leg.coords)
    # First fixture coordinate is [8.541699, 47.376899, 407.75] - it must come
    # back as (lat, lon) with the elevation split off into its own list.
    assert leg.coords[0] == pytest.approx((47.376899, 8.541699))
    assert leg.elevations[0] == pytest.approx(407.75)
    assert leg.distance_m == pytest.approx(1840.0)


@responses.activate
def test_route_leg_treats_2d_coordinates_as_unknown_elevation(brouter_response_json):
    """A 2D point must yield None, not 0 - an explicit 0m would read as
    sea level to the FIT/GPX elevation math instead of "no data"."""
    brouter_response_json["features"][0]["geometry"]["coordinates"] = [
        [8.541699, 47.376899],
        [8.542085, 47.376881],
    ]
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    leg = route_leg(START, END, use_cache=False)

    assert leg.elevations == [None, None]


@responses.activate
def test_route_leg_raises_on_bad_status():
    responses.add(responses.GET, ROUTING_URL, body="server error", status=500)
    with pytest.raises(RoutingError):
        route_leg(START, END, use_cache=False)


@responses.activate
def test_route_leg_raises_on_non_json_body():
    # BRouter answers some failures with a plain-text body and a 200.
    responses.add(responses.GET, ROUTING_URL, body="operation killed by thread", status=200)
    with pytest.raises(RoutingError):
        route_leg(START, END, use_cache=False)


@responses.activate
def test_route_leg_raises_on_malformed_geojson():
    responses.add(responses.GET, ROUTING_URL, json={"type": "FeatureCollection"}, status=200)
    with pytest.raises(RoutingError):
        route_leg(START, END, use_cache=False)


@responses.activate
def test_route_leg_raises_when_route_has_too_few_points(brouter_response_json):
    brouter_response_json["features"][0]["geometry"]["coordinates"] = [[8.5417, 47.3769, 407.0]]
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    with pytest.raises(RoutingError):
        route_leg(START, END, use_cache=False)


@responses.activate
def test_route_leg_uses_cache(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    first = route_leg(START, END, use_cache=True)
    second = route_leg(START, END, use_cache=True)
    assert first == second
    assert len(responses.calls) == 1


@responses.activate
def test_route_leg_cache_is_keyed_on_endpoints(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    route_leg(START, END, use_cache=True)
    route_leg(START, (47.9, 8.9), use_cache=True)
    assert len(responses.calls) == 2
