from waypointer.device_profiles import (
    DEVICE_PROFILES,
    OutputFormat,
    build_waypoint,
)
from waypointer.osm import OsmNode


def test_registry_has_expected_devices():
    assert DEVICE_PROFILES["generic"].output_format is OutputFormat.GPX
    assert DEVICE_PROFILES["wahoo_elemnt_roam_v3"].output_format is OutputFormat.FIT


def test_build_waypoint_uses_osm_name():
    node = OsmNode(id=1, lat=1.0, lon=2.0, tags={"name": "Cool Fountain"})
    wpt = build_waypoint(node, "Water", distance_m=10.0)
    assert wpt.name == "Cool Fountain"
    assert wpt.symbol == "Water"
    assert "10m" in wpt.description


def test_build_waypoint_has_no_fallback_name():
    # Fallback-name resolution (POI_TYPES[...].default_name) is main.py's
    # responsibility now, so build_waypoint just reflects whatever name tag
    # it was given - including an absent one.
    node = OsmNode(id=2, lat=1.0, lon=2.0, tags={})
    wpt = build_waypoint(node, "Water", distance_m=5.0)
    assert wpt.name == ""


def test_build_waypoint_uses_given_symbol():
    node = OsmNode(id=3, lat=1.0, lon=2.0, tags={})
    wpt = build_waypoint(node, "Potable Water", distance_m=1.0)
    assert wpt.symbol == "Potable Water"
