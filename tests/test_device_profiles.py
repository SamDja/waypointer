from waypointer.device_profiles import (
    DEFAULT_WAYPOINT_NAME,
    DEVICE_PROFILES,
    DeviceProfile,
    OutputFormat,
    build_waypoint,
)
from waypointer.osm import OsmNode

GENERIC_PROFILE = DEVICE_PROFILES["generic"]


def test_registry_has_expected_devices():
    assert DEVICE_PROFILES["generic"].output_format is OutputFormat.GPX
    assert DEVICE_PROFILES["wahoo_elemnt_roam_v3"].output_format is OutputFormat.FIT


def test_build_waypoint_uses_osm_name():
    node = OsmNode(id=1, lat=1.0, lon=2.0, tags={"name": "Cool Fountain"})
    wpt = build_waypoint(node, GENERIC_PROFILE, distance_m=10.0)
    assert wpt.name == "Cool Fountain"
    assert wpt.symbol == "Water"
    assert "10m" in wpt.description


def test_build_waypoint_falls_back_to_default_name():
    node = OsmNode(id=2, lat=1.0, lon=2.0, tags={})
    wpt = build_waypoint(node, GENERIC_PROFILE, distance_m=5.0)
    assert wpt.name == DEFAULT_WAYPOINT_NAME


def test_build_waypoint_uses_profile_symbol():
    node = OsmNode(id=3, lat=1.0, lon=2.0, tags={})
    profile = DeviceProfile(
        key="custom", name="Custom", output_format=OutputFormat.GPX, water_symbol="Potable Water"
    )
    wpt = build_waypoint(node, profile, distance_m=1.0)
    assert wpt.symbol == "Potable Water"
