"""Device output profiles: turns an OSM node into a GPX waypoint, and
declares which output format each supported device uses.

Wahoo's GPX <sym> mapping is undocumented and, per investigation, isn't
even what drives icon selection during navigation on a Wahoo ELEMNT ROAM v3
- that comes from a FIT course_point developer field instead (see
fit_io.py). So devices aren't just a tunable symbol string anymore: each
one picks an OutputFormat, and only the GPX-producing profiles need a
water_symbol at all. This stays a plain registry, not a plugin system,
since there are exactly two entries.
"""

from dataclasses import dataclass
from enum import Enum

import gpxpy.gpx

from waypointer.osm import OsmNode

DEFAULT_WAYPOINT_NAME = "Water Fountain"


class OutputFormat(Enum):
    GPX = "gpx"
    FIT = "fit"


@dataclass(frozen=True)
class DeviceProfile:
    key: str
    name: str
    output_format: OutputFormat
    water_symbol: str = "Water"          # only meaningful for OutputFormat.GPX
    water_course_point_type: int = 16    # only meaningful for OutputFormat.FIT; confirmed value


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
    node: OsmNode, profile: DeviceProfile, distance_m: float
) -> gpxpy.gpx.GPXWaypoint:
    """Pure OSM node + profile -> populated GPXWaypoint. Does not attach the
    dedup marker extension - that's gpx_io's concern, keeping this module
    unaware of GPX extension/dedup mechanics. Only called for GPX profiles.
    """
    name = node.tags.get("name") or DEFAULT_WAYPOINT_NAME
    return gpxpy.gpx.GPXWaypoint(
        latitude=node.lat,
        longitude=node.lon,
        name=name,
        symbol=profile.water_symbol,
        description=f"{distance_m:.0f}m from route",
    )
