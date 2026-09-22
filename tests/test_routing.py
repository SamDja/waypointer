import pytest
import responses

from urllib.parse import parse_qs, urlparse

from waypointer.routing import (
    ALLOWED_PROFILES,
    PROFILE_OPTIONS,
    ROUTING_URL,
    BoolOption,
    ChoiceOption,
    RoutingError,
    build_routing_params,
    resolve_options,
    route_leg,
    surface_category,
)

START = (47.376899, 8.541699)
END = (47.380000, 8.550000)


def test_build_routing_params_flips_to_lon_lat():
    params = build_routing_params(START, END, "fastbike")
    # BRouter takes lon,lat pairs; this codebase stores (lat, lon) everywhere.
    assert params["lonlats"] == "8.541699,47.376899|8.55,47.38"
    assert params["profile"] == "fastbike"
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


def test_resolve_options_fills_every_default_explicitly():
    # Ferries and steps are deliberately off, unlike the profile's own defaults.
    assert resolve_options("fastbike", None) == {
        "allow_ferries": "0",
        "allow_steps": "0",
        "consider_forest": "0",
        "consider_noise": "0",
        "consider_river": "0",
        "consider_town": "0",
        "consider_traffic": "0.1",
    }


def test_resolve_options_fills_every_hiking_default_explicitly():
    # Steps and ferries stay on here, unlike fastbike above - both are
    # ordinary parts of a walking route.
    assert resolve_options("hiking-mountain", None) == {
        "SAC_scale_preferred": "1",
        "allow_ferries": "1",
        "allow_steps": "1",
        "consider_elevation": "0",
        "hiking_routes_preference": "0.2",
        "iswet": "0",
    }


def test_every_allowed_profile_declares_its_options():
    # A profile reachable from the frontend but missing from PROFILE_OPTIONS
    # would silently route with none of its options sent, since
    # resolve_options falls back to an empty allowlist for an unknown one.
    assert set(PROFILE_OPTIONS) == set(ALLOWED_PROFILES)


@pytest.mark.parametrize("profile", sorted(ALLOWED_PROFILES))
def test_resolve_options_rejects_another_profiles_options(profile):
    # Each profile's options are its own: fastbike's traffic knob doesn't
    # exist in hiking-mountain and vice versa, so sending one to the wrong
    # profile has to be a 400 rather than a parameter BRouter ignores.
    foreign = {name for other, opts in PROFILE_OPTIONS.items() if other != profile for name in opts}
    for name in sorted(foreign - set(PROFILE_OPTIONS[profile])):
        with pytest.raises(ValueError):
            resolve_options(profile, {name: True})


@pytest.mark.parametrize("profile", sorted(ALLOWED_PROFILES))
def test_every_option_default_is_itself_valid(profile):
    # Guards the hand-mirroring: a default that isn't one of its own choices
    # would make an untouched planner panel unroutable.
    for name, spec in PROFILE_OPTIONS[profile].items():
        if isinstance(spec, ChoiceOption):
            assert spec.default in spec.choices, f"{profile}.{name}"
        else:
            assert isinstance(spec, BoolOption) and isinstance(spec.default, bool)


def test_resolve_options_encodes_booleans_as_1_0_and_numbers_as_decimals():
    encoded = resolve_options("fastbike", {"allow_ferries": True, "consider_traffic": 0.1})
    # BRouter answers `true` with an empty body - it has to be 1/0.
    assert encoded["allow_ferries"] == "1"
    assert encoded["consider_traffic"] == "0.1"


@pytest.mark.parametrize(
    "options",
    [
        {"allow_motorways": True},  # not in the allowlist
        {"allow_ferries": 1},  # a number where a boolean is expected
        {"consider_traffic": True},  # a boolean where a number is expected
        {"consider_traffic": 0.7},  # not one of the offered choices
        {"consider_traffic": "1"},  # a string
    ],
)
def test_resolve_options_rejects_invalid_options(options):
    with pytest.raises(ValueError):
        resolve_options("fastbike", options)


def test_build_routing_params_passes_options_as_profile_overrides():
    params = build_routing_params(START, END, "fastbike", {"allow_ferries": "1"})
    assert params["profile:allow_ferries"] == "1"


@responses.activate
def test_route_leg_sends_every_option(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    route_leg(START, END, options={"consider_town": True}, use_cache=False)

    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert query["profile:consider_town"] == ["1"]
    assert query["profile:allow_ferries"] == ["0"]
    assert query["profile:consider_traffic"] == ["0.1"]


@responses.activate
def test_route_leg_cache_is_keyed_on_options(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    route_leg(START, END, options={"consider_traffic": 0.1}, use_cache=True)
    route_leg(START, END, options={"consider_traffic": 0.3}, use_cache=True)
    # Same options spelled differently (explicit default vs omitted) share an entry.
    route_leg(START, END, options={}, use_cache=True)
    assert len(responses.calls) == 2


@responses.activate
def test_route_leg_parses_surface_runs_and_cycleway(brouter_response_json):
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    leg = route_leg(START, END, use_cache=False)

    # The fixture's rows: primary asphalt 600, untagged secondary 300, cycleway
    # asphalt 150 (all paved, merged), sett 200, untagged grade3 track 250 and
    # gravel 90 (unpaved, merged), untagged unclassified 250.
    assert [(run.category, run.distance_m) for run in leg.surface] == [
        ("paved", 1050.0),
        ("cobbles", 200.0),
        ("unpaved", 340.0),
        ("unknown", 250.0),
    ]
    assert sum(run.distance_m for run in leg.surface) == pytest.approx(leg.distance_m)
    assert leg.cycleway_m == 150.0


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"highway": "residential", "surface": "asphalt"}, "paved"),
        ({"highway": "residential", "surface": "cobblestone"}, "cobbles"),
        ({"highway": "track", "surface": "compacted"}, "unpaved"),
        ({"highway": "primary"}, "paved"),  # untagged main road
        ({"highway": "track", "tracktype": "grade1"}, "paved"),
        ({"highway": "track", "tracktype": "grade4"}, "unpaved"),
        ({"highway": "residential"}, "unknown"),  # untagged minor road: no guessing
        ({"highway": "residential", "surface": "some_new_value"}, "unknown"),
    ],
)
def test_surface_category(tags, expected):
    assert surface_category(tags) == expected


@responses.activate
def test_route_leg_without_messages_has_no_surface(brouter_response_json):
    del brouter_response_json["features"][0]["properties"]["messages"]
    responses.add(responses.GET, ROUTING_URL, json=brouter_response_json, status=200)
    leg = route_leg(START, END, use_cache=False)
    assert leg.surface == ()
    assert leg.cycleway_m == 0.0
