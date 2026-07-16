from pydantic import BaseModel


class Candidate(BaseModel):
    osm_id: int
    poi_type: str
    name: str | None = None
    lat: float
    lon: float
    distance_m: float


class PoiSearchConfig(BaseModel):
    poi_type: str
    max_distance_m: float


class ExistingWaypoint(BaseModel):
    # index is this waypoint's position in the uploaded GPX's <wpt> list,
    # in document order - stable within one find/save round trip since the
    # frontend always resubmits the exact same original file bytes, and
    # gpxpy parses waypoints deterministically. Used to let the visitor
    # choose which pre-existing waypoints to keep vs discard on save.
    index: int
    name: str | None = None
    lat: float
    lon: float


class FindPoisResponse(BaseModel):
    candidates: list[Candidate]
    point_count: int
    existing_waypoints: list[ExistingWaypoint]
    route_coords: list[tuple[float, float]]


class WahooRoutePayload(BaseModel):
    # Everything Wahoo's POST /v1/routes needs alongside the FIT file itself
    # - computed server-side since only the backend has the full-resolution,
    # elevation-carrying GPX in hand (see main.py's wahoo_route_payload()).
    fit_base64: str
    filename: str
    # Human-readable name for Wahoo's route[name] field - deliberately kept
    # separate from `filename`, which is sanitized for filesystem safety
    # (spaces etc. become underscores) and would otherwise mangle a
    # user-typed route name when reused as the display title.
    route_name: str
    distance_m: float
    ascent_m: float
    start_lat: float
    start_lng: float
