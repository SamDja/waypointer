"""Device output profiles: turns an OSM node into a GPX waypoint, and
declares which output format each supported device uses.

Wahoo's GPX <sym> mapping is undocumented and, per investigation, isn't
even what drives icon selection during navigation on a Wahoo ELEMNT ROAM v3
- that comes from a FIT course_point developer field instead (see
fit_io.py). So devices aren't a tunable symbol string at all: each one
just picks an OutputFormat. The GPX <sym> value itself is resolved
per-POI-type by the caller (main.py's _resolve_symbol, using
poi_types.py's PoiTypeConfig.default_gpx_symbol) and passed into
build_waypoint directly - this stays a plain registry, not a plugin
system, since there are exactly two entries.
"""

from dataclasses import dataclass
from enum import Enum

import gpxpy.gpx

from waypointer.osm import OsmNode


class OutputFormat(Enum):
    GPX = "gpx"
    FIT = "fit"


@dataclass(frozen=True)
class DeviceProfile:
    key: str
    name: str
    output_format: OutputFormat


DEVICE_PROFILES: dict[str, DeviceProfile] = {
    "generic": DeviceProfile(key="generic", name="Generic", output_format=OutputFormat.GPX),
    "wahoo_elemnt_roam_v3": DeviceProfile(
        key="wahoo_elemnt_roam_v3",
        name="Wahoo ELEMNT ROAM v3",
        output_format=OutputFormat.FIT,
    ),
}
DEFAULT_DEVICE_KEY = "generic"


def build_waypoint(
    node: OsmNode, symbol: str, distance_m: float
) -> gpxpy.gpx.GPXWaypoint:
    """Pure OSM node + symbol -> populated GPXWaypoint. Does not attach the
    dedup marker extension - that's gpx_io's concern, keeping this module
    unaware of GPX extension/dedup mechanics. Only called for GPX profiles.
    The caller (main.py) always resolves a non-empty name via the POI type
    registry before constructing the node, so no fallback is needed here.
    """
    name = node.tags.get("name", "")
    return gpxpy.gpx.GPXWaypoint(
        latitude=node.lat,
        longitude=node.lon,
        name=name,
        symbol=symbol,
        description=f"{distance_m:.0f}m from route",
    )
