import json
from pathlib import Path

from waypointer.poi_types import POI_TYPES, clamp_distance_m

WAHOO_POI_MAPPING_PATH = Path(__file__).parent.parent / "dev_tools" / "wahoo_poi_mapping.json"


def test_registry_matches_wahoo_poi_mapping():
    # Guards against a transcription slip across the registry's ~55
    # hand-entered course_point_type values - the mapping file is the
    # reverse-engineered source of truth (see poi_types.py's docstring).
    expected = json.loads(WAHOO_POI_MAPPING_PATH.read_text())
    assert set(POI_TYPES.keys()) == set(expected.keys())
    for key, course_point_type in expected.items():
        assert POI_TYPES[key].course_point_type == course_point_type


def test_registry_has_water_type():
    water = POI_TYPES["water"]
    assert water.key == "water"
    assert water.tag_filter == 'node["amenity"="drinking_water"]'
    assert water.min_distance_m <= water.default_max_distance_m <= water.max_distance_m


def test_clamp_distance_m_bounds():
    assert clamp_distance_m("water", 1.0) == POI_TYPES["water"].min_distance_m
    assert clamp_distance_m("water", 999999.0) == POI_TYPES["water"].max_distance_m
    assert clamp_distance_m("water", 75.0) == 75.0
