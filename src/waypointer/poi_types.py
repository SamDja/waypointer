"""Registry of all POI types Waypointer knows how to classify/export, plus
which of them Overpass can be searched for. A plain registry, not a plugin
system, mirroring device_profiles.py's style. Only "water" is searchable
today (has a tag_filter and search-distance bounds) - the rest exist purely
for classifying/labeling pre-existing waypoints (see gpx_io.infer_poi_type
and the frontend's AssignWaypointTypesDialog) and for FIT export icon
selection (course_point_type, see fit_io.py). The full key set and each
key's course_point_type mirror dev_tools/wahoo_poi_mapping.json exactly -
that file is the reverse-engineered source of truth for which icon a Wahoo
ELEMNT ROAM v3 renders for a given course_point_type value.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PoiTypeConfig:
    key: str
    label: str
    # Wahoo FIT icon code - dev_tools/wahoo_poi_mapping.json.
    course_point_type: int
    default_name: str
    # Lowercase substrings matched against a pre-existing waypoint's <sym>/
    # <type> text to best-effort infer its POI type when it wasn't added by
    # us (no osm_id marker) - see gpx_io.infer_poi_type. Not exhaustive by
    # design: the AssignWaypointTypesDialog lets the visitor correct a wrong
    # or missing guess, so this only needs to catch the common cases.
    sym_hints: tuple[str, ...] = ()
    # None means "not searchable" - Find POIs / Overpass only ever queries
    # for types that set these (today, only "water").
    tag_filter: str | None = None
    default_max_distance_m: float = 10.0
    min_distance_m: float = 1.0
    max_distance_m: float = 500.0
    # Suggested default for the GPX <sym> tag when exporting this POI type
    # to a generic (non-Wahoo) device - see main.py's _resolve_symbol. None
    # means "fall back to label", which is a fine default for most types;
    # only water needs an explicit override since "Water Fountains" (its
    # label) isn't the conventional Garmin/Basecamp symbol name.
    default_gpx_symbol: str | None = None


POI_TYPES: dict[str, PoiTypeConfig] = {
    "water": PoiTypeConfig(
        key="water",
        label="Water Fountains",
        course_point_type=16,
        default_name="Water Fountain",
        sym_hints=("water", "fountain"),
        tag_filter='node["amenity"="drinking_water"]',
        default_max_distance_m=10.0,
        min_distance_m=1.0,
        max_distance_m=500.0,
        default_gpx_symbol="Water",
    ),
    "warning": PoiTypeConfig(
        key="warning", label="Warning", course_point_type=13,
        default_name="Warning", sym_hints=("warning", "hazard", "danger"),
    ),
    "first_aid": PoiTypeConfig(
        key="first_aid", label="First Aid", course_point_type=18,
        default_name="First Aid", sym_hints=("first aid", "first-aid", "medical"),
    ),
    "hospital": PoiTypeConfig(
        key="hospital", label="Hospital", course_point_type=46,
        default_name="Hospital", sym_hints=("hospital",),
        tag_filter='node["amenity"="hospital"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "pharmacy": PoiTypeConfig(
        key="pharmacy", label="Pharmacy", course_point_type=56,
        default_name="Pharmacy", sym_hints=("pharmacy", "drug store", "drugstore"),
        tag_filter='node["amenity"="pharmacy"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "bar": PoiTypeConfig(
        key="bar", label="Bar", course_point_type=30,
        default_name="Bar", sym_hints=("bar", "pub"),
        tag_filter='node["amenity"="bar"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "bike_shop": PoiTypeConfig(
        key="bike_shop", label="Bike Shop", course_point_type=34,
        default_name="Bike Shop", sym_hints=("bike shop", "bicycle shop"),
        tag_filter='node["shop"="bicycle"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "coffee": PoiTypeConfig(
        key="coffee", label="Coffee", course_point_type=38,
        default_name="Coffee Shop", sym_hints=("coffee", "cafe"),
        tag_filter='node["amenity"="cafe"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "food": PoiTypeConfig(
        key="food", label="Food", course_point_type=17,
        default_name="Restaurant", sym_hints=("food", "restaurant", "dining"),
        tag_filter='node["amenity"="restaurant"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "gas_station": PoiTypeConfig(
        key="gas_station", label="Gas Station", course_point_type=43,
        default_name="Gas Station", sym_hints=("gas station", "fuel", "petrol"),
        tag_filter='node["amenity"="fuel"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "groceries": PoiTypeConfig(
        key="groceries", label="Groceries", course_point_type=45,
        default_name="Grocery Store", sym_hints=("grocery", "groceries", "supermarket"),
        tag_filter='node["shop"~"^(supermarket|convenience|grocery)$"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "shopping": PoiTypeConfig(
        key="shopping", label="Shopping", course_point_type=58,
        default_name="Shop", sym_hints=("shopping", "shop", "store"),
        tag_filter='node["shop"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "winery": PoiTypeConfig(
        key="winery", label="Winery", course_point_type=65,
        default_name="Winery", sym_hints=("winery", "vineyard"),
        tag_filter='node["shop"="wine"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "info": PoiTypeConfig(
        key="info", label="Info Point", course_point_type=47,
        default_name="Info Point", sym_hints=("info", "information"),
        tag_filter='node["tourism"="information"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "internet": PoiTypeConfig(
        key="internet", label="Internet", course_point_type=48,
        default_name="Internet", sym_hints=("internet", "wifi"),
    ),
    "library": PoiTypeConfig(
        key="library", label="Library", course_point_type=50,
        default_name="Library", sym_hints=("library",),
    ),
    "lodging": PoiTypeConfig(
        key="lodging", label="Lodging", course_point_type=51,
        default_name="Lodging", sym_hints=("lodging", "hotel", "hostel", "motel"),
        tag_filter='node["tourism"~"^(hotel|hostel|guest_house|motel)$"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "shower": PoiTypeConfig(
        key="shower", label="Shower", course_point_type=60,
        default_name="Shower", sym_hints=("shower",),
        tag_filter='node["amenity"="shower"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "toilet": PoiTypeConfig(
        key="toilet", label="Toilet", course_point_type=59,
        default_name="Toilet", sym_hints=("toilet", "restroom", "wc"),
        tag_filter='node["amenity"="toilets"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "bike_parking": PoiTypeConfig(
        key="bike_parking", label="Bike Parking", course_point_type=32,
        default_name="Bike Parking", sym_hints=("bike parking", "bicycle parking"),
        tag_filter='node["amenity"="bicycle_parking"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "bike_share": PoiTypeConfig(
        key="bike_share", label="Bike Share", course_point_type=33,
        default_name="Bike Share", sym_hints=("bike share", "bike sharing"),
        tag_filter='node["amenity"="bicycle_rental"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "chairlift": PoiTypeConfig(
        key="chairlift", label="Chairlift", course_point_type=36,
        default_name="Chairlift", sym_hints=("chairlift", "chair lift"),
        tag_filter='node["aerialway"="chair_lift"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "e_bike_charging": PoiTypeConfig(
        key="e_bike_charging", label="E-Bike Charging", course_point_type=41,
        default_name="E-Bike Charging", sym_hints=("e-bike", "ebike charging", "charging"),
        tag_filter='node["amenity"="charging_station"]["bicycle"="yes"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "ferry": PoiTypeConfig(
        key="ferry", label="Ferry", course_point_type=42,
        default_name="Ferry", sym_hints=("ferry",),
        tag_filter='node["amenity"="ferry_terminal"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "parking": PoiTypeConfig(
        key="parking", label="Parking", course_point_type=55,
        default_name="Parking", sym_hints=("parking",),
        tag_filter='node["amenity"="parking"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "transit": PoiTypeConfig(
        key="transit", label="Transit", course_point_type=63,
        default_name="Transit Stop", sym_hints=("transit", "bus stop", "train station", "station"),
        tag_filter='node["highway"="bus_stop"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "campsite": PoiTypeConfig(
        key="campsite", label="Campsite", course_point_type=35,
        default_name="Campsite", sym_hints=("campsite", "camping", "camp ground", "campground"),
        tag_filter='node["tourism"="camp_site"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "dog_park": PoiTypeConfig(
        key="dog_park", label="Dog Park", course_point_type=40,
        default_name="Dog Park", sym_hints=("dog park",),
        tag_filter='node["leisure"="dog_park"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "geocache": PoiTypeConfig(
        key="geocache", label="Geocache", course_point_type=44,
        default_name="Geocache", sym_hints=("geocache",),
    ),
    "park": PoiTypeConfig(
        key="park", label="Park", course_point_type=54,
        default_name="Park", sym_hints=("park",),
        tag_filter='node["leisure"="park"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "rest_area": PoiTypeConfig(
        key="rest_area", label="Rest Area", course_point_type=57,
        default_name="Rest Area", sym_hints=("rest area", "picnic"),
        tag_filter='node["highway"="rest_area"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "swimming": PoiTypeConfig(
        key="swimming", label="Swimming", course_point_type=31,
        default_name="Swimming", sym_hints=("swimming", "swim", "pool"),
        # swimming_pool covers built pools; bathing_place is OSM's tag for
        # a designated/informal swimming spot at a lake, river, or coast.
        tag_filter='node["leisure"~"^(swimming_pool|bathing_place)$"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "trailhead": PoiTypeConfig(
        key="trailhead", label="Trailhead", course_point_type=61,
        default_name="Trailhead", sym_hints=("trailhead", "trail head"),
    ),
    "summit": PoiTypeConfig(
        key="summit", label="Summit", course_point_type=14,
        default_name="Summit", sym_hints=("summit", "peak"),
        tag_filter='node["natural"="peak"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "valley": PoiTypeConfig(
        key="valley", label="Valley", course_point_type=15,
        default_name="Valley", sym_hints=("valley",),
    ),
    "checkpoint": PoiTypeConfig(
        key="checkpoint", label="Checkpoint", course_point_type=37,
        default_name="Checkpoint", sym_hints=("checkpoint",),
    ),
    "climb_4th_cat": PoiTypeConfig(
        key="climb_4th_cat", label="Climb (Cat. 4)", course_point_type=19,
        default_name="Climb (Cat. 4)",
    ),
    "climb_3rd_cat": PoiTypeConfig(
        key="climb_3rd_cat", label="Climb (Cat. 3)", course_point_type=20,
        default_name="Climb (Cat. 3)",
    ),
    "climb_2nd_cat": PoiTypeConfig(
        key="climb_2nd_cat", label="Climb (Cat. 2)", course_point_type=21,
        default_name="Climb (Cat. 2)",
    ),
    "climb_1st_cat": PoiTypeConfig(
        key="climb_1st_cat", label="Climb (Cat. 1)", course_point_type=22,
        default_name="Climb (Cat. 1)",
    ),
    "climb_hors_cat": PoiTypeConfig(
        key="climb_hors_cat", label="Climb (HC)", course_point_type=23,
        default_name="Climb (HC)", sym_hints=("hors categorie", "hc climb"),
    ),
    "distance_marker": PoiTypeConfig(
        key="distance_marker", label="Distance Marker", course_point_type=39,
        default_name="Distance Marker", sym_hints=("distance marker", "mile marker", "km marker"),
    ),
    "meeting_spot": PoiTypeConfig(
        key="meeting_spot", label="Meeting Spot", course_point_type=52,
        default_name="Meeting Spot", sym_hints=("meeting spot", "meeting point"),
    ),
    "segment_start": PoiTypeConfig(
        key="segment_start", label="Segment Start", course_point_type=9,
        default_name="Segment Start", sym_hints=("segment start",),
    ),
    "segment_end": PoiTypeConfig(
        key="segment_end", label="Segment End", course_point_type=10,
        default_name="Segment End", sym_hints=("segment end",),
    ),
    "sprint": PoiTypeConfig(
        key="sprint", label="Sprint", course_point_type=24,
        default_name="Sprint", sym_hints=("sprint",),
    ),
    "transition": PoiTypeConfig(
        key="transition", label="Transition", course_point_type=62,
        default_name="Transition", sym_hints=("transition",),
    ),
    "atm": PoiTypeConfig(
        key="atm", label="ATM", course_point_type=27,
        default_name="ATM", sym_hints=("atm", "cash machine", "bank"),
        tag_filter='node["amenity"="atm"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "art": PoiTypeConfig(
        key="art", label="Art", course_point_type=28,
        default_name="Art", sym_hints=("art", "sculpture"),
        tag_filter='node["tourism"="artwork"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "attraction": PoiTypeConfig(
        key="attraction", label="Attraction", course_point_type=29,
        default_name="Attraction", sym_hints=("attraction",),
        tag_filter='node["tourism"="attraction"]',
        default_max_distance_m=50.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "for_kids": PoiTypeConfig(
        key="for_kids", label="Kid Friendly", course_point_type=49,
        default_name="Kid Friendly", sym_hints=("for kids", "kid friendly"),
    ),
    "monument": PoiTypeConfig(
        key="monument", label="Monument", course_point_type=53,
        default_name="Monument", sym_hints=("monument", "memorial"),
        tag_filter='node["historic"="monument"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "viewpoint": PoiTypeConfig(
        key="viewpoint", label="Viewpoint", course_point_type=64,
        default_name="Viewpoint", sym_hints=("viewpoint", "scenic view", "overlook"),
        tag_filter='node["tourism"="viewpoint"]',
        default_max_distance_m=10.0, min_distance_m=1.0, max_distance_m=500.0,
    ),
    "generic": PoiTypeConfig(
        key="generic", label="Other", course_point_type=0,
        default_name="Point of Interest",
    ),
}

# Shown as checkable search options without the visitor needing to add
# them first (frontend/src/lib/poiTypes.ts mirrors this list by hand) -
# every other searchable type is only reachable via the "add a POI type"
# picker. Order here is display order in FindPoisCard.
DEFAULT_VISIBLE_POI_TYPES: tuple[str, ...] = (
    "water",
    "viewpoint",
    "groceries",
    "campsite",
    "bike_parking",
    "rest_area",
)

# Reverse of POI_TYPES' course_point_type - lets fit_read.py recover the
# exact POI type of a FIT course point instead of guessing from <sym> text.
# Safe to build as a plain dict comprehension: course_point_type values are
# unique per entry, asserted by test_poi_types.py's exhaustive comparison
# against dev_tools/wahoo_poi_mapping.json.
POI_TYPE_BY_COURSE_POINT_TYPE: dict[int, str] = {
    cfg.course_point_type: key for key, cfg in POI_TYPES.items()
}


def clamp_distance_m(poi_type: str, requested_m: float) -> float:
    cfg = POI_TYPES[poi_type]
    assert cfg.min_distance_m is not None and cfg.max_distance_m is not None, (
        f"{poi_type} is not searchable"
    )
    return max(cfg.min_distance_m, min(cfg.max_distance_m, requested_m))
