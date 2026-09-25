from typing import Literal

from pydantic import BaseModel


class Candidate(BaseModel):
    osm_id: int
    poi_type: str
    name: str | None = None
    lat: float
    lon: float
    distance_m: float
    distance_from_start_m: float


class CandidateDetails(BaseModel):
    # Full OSM tags/edit-metadata for a Candidate, keyed by osm_id on
    # FindPoisResponse.candidate_details rather than added to Candidate
    # itself - Candidate round-trips through /api/save and
    # /api/wahoo/route-payload's request bodies, so bloating it with tags
    # would bloat every save/export round trip too, not just the search
    # response. Same shape as PoiLookupResult's tags/last_edited fields.
    tags: dict[str, str]
    last_edited: str | None = None


class PoiSearchConfig(BaseModel):
    poi_type: str
    max_distance_m: float


class SearchRange(BaseModel):
    # An inclusive index range into the submitted route's coordinate list
    # (gpx_io.route_coordinates order). When given, /api/find-pois/route runs
    # its PostGIS query against only this slice of the route - used by the
    # route planner after extending a route, so a re-search only returns POIs
    # along the newly added stretch, which the frontend merges into what it
    # already has.
    #
    # Deliberately scopes *only* the database query: every distance in the
    # response is still measured against the full route, so there remains
    # exactly one place (geometry.project_onto_polyline_indexed_m) that
    # computes distance-from-route and distance-from-start.
    start_index: int
    end_index: int


class MapPoi(BaseModel):
    # One of our own imported POIs, drawn on the map for its own sake rather
    # than as a candidate near a route - hence no distances (see main.py's
    # /api/map-pois). Deliberately lighter than PoiLookupResult: these come
    # back hundreds at a time per viewport, and the full tag dict is only
    # needed once a visitor actually clicks one, which goes through
    # /api/find-pois/location as before.
    osm_id: int
    osm_type: str = "node"
    poi_type: str
    name: str | None = None
    lat: float
    lon: float


class MapPoiResponse(BaseModel):
    pois: list[MapPoi]


class PoiLookupResult(BaseModel):
    # Resolves a single basemap POI icon click (see main.py's
    # /api/find-pois/location) to a real OSM element - carries the full raw
    # tag dict, unlike Candidate, so the frontend can render "as much info
    # as OSM has" plus an edit link. Kept separate from Candidate (rather
    # than adding `tags` there) since Candidate round-trips through
    # /api/save's request body.
    osm_id: int
    osm_type: str = "node"  # "node", "way", or "relation" - see poi_db.OsmNode
    poi_type: str
    name: str | None = None
    lat: float
    lon: float
    tags: dict[str, str]
    # ISO 8601 timestamp of this element's last edit on OSM (imported via
    # osm2pgsql's --extra-attributes - see poi_db.py), None if unavailable -
    # distinct from a `check_date`/`survey:date` tag, which is a mapper-set
    # field in `tags` rather than OSM's own edit-history metadata.
    last_edited: str | None = None


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
    # One requested POI type whose PostGIS query errored - /api/find-pois/
    # route still returns 200 with results for the types that succeeded
    # (see main.py's find_pois()), unless every requested type failed, in
    # which case the whole request 502s instead.
    poi_type: str
    error: str


class FindPoisResponse(BaseModel):
    candidates: list[Candidate]
    point_count: int
    existing_waypoints: list[ExistingWaypoint]
    route_coords: list[tuple[float, float]]
    failed_poi_types: list[FailedPoiType] = []
    candidate_details: dict[int, CandidateDetails] = {}


class SurfaceRunResponse(BaseModel):
    category: Literal["paved", "cobbles", "unpaved", "unknown"]
    distance_m: float


class RouteLegResponse(BaseModel):
    # One road-snapped leg between two planner anchors. coords/elevations are
    # index-parallel (see routing.RoutedLeg); elevations carries None where
    # the routing engine gave a 2D point, matching route_elevations().
    coords: list[tuple[float, float]]
    elevations: list[float | None]
    distance_m: float
    # Surface along the leg, in order (see routing.surface_category), and how
    # much of it is on dedicated cycleways - for the planner's surface band.
    surface: list[SurfaceRunResponse] = []
    cycleway_m: float = 0.0


class PlaceResult(BaseModel):
    # One /api/geocode match - see geocode.Place.
    name: str
    context: str
    kind: str
    lat: float
    lon: float
    # [west, south, east, north] for an area; None for a point.
    bbox: tuple[float, float, float, float] | None


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
