import re
from typing import Literal

from pydantic import BaseModel, field_validator


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
    # response. Same shape as PoiLookupResult's osm_type/tags/last_edited
    # fields. osm_type is here, not on Candidate, because only the popup's
    # "Edit on OpenStreetMap" link needs it.
    osm_type: str = "node"  # "node", "way", or "relation" - see poi_db.OsmNode
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


class PoiPhoto(BaseModel):
    # One photo of an OSM element, resolved from its tags by photos.py.
    # source is "commons", "panoramax", "mapillary" or "web" (an `image` URL
    # the browser loads straight from its own host).
    source: str
    thumb_url: str
    full_url: str
    page_url: str
    # ISO 8601 UTC - when taken where the service says, else when uploaded.
    taken_at: str | None = None
    author: str | None = None
    license: str | None = None


class PhotoLink(BaseModel):
    # A photo the app can only link to: a Mapillary image with no
    # MAPILLARY_TOKEN configured, or an `image` URL that isn't an image file.
    source: str
    url: str


class PoiPhotosResponse(BaseModel):
    # Newest first, undated last.
    photos: list[PoiPhoto]
    links: list[PhotoLink]
    # Services that failed; the others' photos are still in `photos`.
    failed_sources: list[str]


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


class AuthorizeUrl(BaseModel):
    # Where a connect popup goes (Strava or Wahoo) - built server-side
    # because the client ids live in the server's env (see connections.py).
    url: str


class ConnectionResponse(BaseModel):
    # One fitness app connected to the signed-in account. Never carries a
    # token - those stay on the server (connections.py).
    provider: Literal["strava", "wahoo"]
    # The other app's display name for the account, if it gave one.
    label: str | None
    # What the visitor granted, as the app reports it (space- or
    # comma-separated, per app).
    scope: str | None
    connected_at: str


class WahooRouteResponse(BaseModel):
    # One of the visitor's Wahoo routes - see wahoo.WahooRoute.
    id: int
    name: str
    distance_m: float
    ascent_m: float
    created_at: str
    # Wahoo's CDN URL for the route's FIT file, for /api/wahoo/import-route.
    file_url: str


class StravaRouteResponse(BaseModel):
    # One of the visitor's Strava routes - see strava.StravaRoute. `id` is a
    # string because Strava's route ids overflow a JS number.
    id: str
    name: str
    distance_m: float
    ascent_m: float
    created_at: str


class StravaActivityResponse(BaseModel):
    # One of the visitor's recorded Strava activities with a GPS track - see
    # strava.StravaActivity. Imported as a route to follow again.
    id: str
    name: str
    # Strava's sport_type, e.g. "Ride", "GravelRide", "Hike".
    sport_type: str
    distance_m: float
    ascent_m: float
    start_date: str


class StravaActivitiesPage(BaseModel):
    # One page of /api/strava/activities - the dialog asks for the next one
    # only while `has_more` and the visitor wants more.
    activities: list[StravaActivityResponse]
    has_more: bool


class AccountResponse(BaseModel):
    # The signed-in visitor's account - /api/auth/me and every endpoint that
    # signs someone in. Never carries the password hash.
    id: str
    email: str
    # What to call them - asked at sign-up; None for an account made before.
    name: str | None
    email_verified: bool
    # While the email isn't confirmed: when the account will be deleted
    # (cleanup.UNVERIFIED_ACCOUNT_TTL after sign-up), so the visitor can be
    # told. None once verified.
    delete_unverified_at: str | None
    # Opt-in features switched on by hand for a test phase (e.g. "llm").
    features: list[str]
    created_at: str


class AccountStatus(BaseModel):
    # /api/auth/me. `account` is null for an anonymous visitor; `enabled` is
    # false when this server has no account database (DATABASE_URL unset),
    # so the frontend can hide sign-in entirely rather than offer a broken one.
    enabled: bool
    account: AccountResponse | None
    captcha_required: bool


class ProfileSettings(BaseModel):
    # Settings kept with the account rather than in the browser
    # (/api/account/settings). Keyed by activity (the frontend's map style
    # key), like the browser's own per-activity preferences.
    avg_speed_kmh: dict[str, float] = {}

    @field_validator("avg_speed_kmh")
    @classmethod
    def _check_speeds(cls, value: dict[str, float]) -> dict[str, float]:
        if len(value) > 20:
            raise ValueError("too many activities")
        for key, speed in value.items():
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", key):
                raise ValueError(f"not an activity key: {key!r}")
            if not 0.5 <= speed <= 100:
                raise ValueError(f"speed out of range for {key}")
        return value
