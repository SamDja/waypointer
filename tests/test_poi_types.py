from waypointer.poi_types import POI_TYPES, clamp_distance_m


def test_registry_has_water_type():
    water = POI_TYPES["water"]
    assert water.key == "water"
    assert water.tag_filter == 'node["amenity"="drinking_water"]'
    assert water.min_distance_m <= water.default_max_distance_m <= water.max_distance_m


def test_clamp_distance_m_bounds():
    assert clamp_distance_m("water", 1.0) == POI_TYPES["water"].min_distance_m
    assert clamp_distance_m("water", 999999.0) == POI_TYPES["water"].max_distance_m
    assert clamp_distance_m("water", 75.0) == 75.0
