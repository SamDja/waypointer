from pydantic import BaseModel


class Candidate(BaseModel):
    osm_id: int
    poi_type: str
    name: str | None = None
    lat: float
    lon: float
    distance_m: float
    distance_from_start_m: float


class PoiSearchConfig(BaseModel):
    poi_type: str
    max_distance_m: float


class SearchRange(BaseModel):
    # An inclusive index range into the submitted route's coordinate list
    # (gpx_io.route_coordinates order). When given, /api/find-pois builds its
    # Overpass query from only this slice of the route - used by the route
    # planner after extending a route, so re-searching costs a query covering
    # the newly added stretch instead of the whole route.
    #
    # Deliberately scopes *only* the upstream query: every distance in the
    # response is still measured against the full route, so there remains
    # exactly one place (geometry.project_onto_polyline_indexed_m) that
    # computes distance-from-route and distance-from-start.
    start_index: int
    end_index: int


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
    # Best-effort inferred POI type key (see gpx_io.infer_poi_type),
    # "generic" at worst - never unset. Lets the frontend group/iconize
    # these the same way as freshly-found candidates, and is editable by the
    # visitor via the AssignWaypointTypesDialog before it ever affects
    # export (see main.py's /api/save existing_waypoint_types field).
    poi_type: str = "generic"
    # Distance from the route/track, and cumulative distance along it from
    # the start - see geometry.project_onto_polyline_m. Computed against
    # the same full-resolution polyline as Candidate.distance_m.
    distance_from_route_m: float
    distance_from_start_m: float


class FailedPoiType(BaseModel):
    # One requested POI type whose Overpass call errored or timed out -
    # /api/find-pois still returns 200 with results for the types that
    # succeeded (see main.py's find_pois()), unless every requested type
    # failed, in which case the whole request 502s instead.
    poi_type: str
    error: str


class FindPoisResponse(BaseModel):
    candidates: list[Candidate]
    point_count: int
    existing_waypoints: list[ExistingWaypoint]
    route_coords: list[tuple[float, float]]
    failed_poi_types: list[FailedPoiType] = []


class RouteLegResponse(BaseModel):
    # One road-snapped leg between two planner anchors. coords/elevations are
    # index-parallel (see routing.RoutedLeg); elevations carries None where
    # the routing engine gave a 2D point, matching route_elevations().
    coords: list[tuple[float, float]]
    elevations: list[float | None]
    distance_m: float


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
