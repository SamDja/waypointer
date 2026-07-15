"""Registry of searchable POI types: each entry names its Overpass tag
filter, its allowed/default search-distance bounds, and a fallback name for
OSM nodes that have no `name` tag. A plain registry, not a plugin system,
mirroring device_profiles.py's style - only "water" is registered today, but
`main.py` and the frontend's hand-mirrored `lib/poiTypes.ts` are both written
against this shape so a second entry doesn't require touching the request/
response flow.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PoiTypeConfig:
    key: str
    label: str
    tag_filter: str
    default_max_distance_m: float
    min_distance_m: float
    max_distance_m: float
    default_name: str


POI_TYPES: dict[str, PoiTypeConfig] = {
    "water": PoiTypeConfig(
        key="water",
        label="Water Fountains",
        tag_filter='node["amenity"="drinking_water"]',
        default_max_distance_m=10.0,
        min_distance_m=1.0,
        max_distance_m=500.0,
        default_name="Water Fountain",
    ),
}


def clamp_distance_m(poi_type: str, requested_m: float) -> float:
    cfg = POI_TYPES[poi_type]
    return max(cfg.min_distance_m, min(cfg.max_distance_m, requested_m))
