"""FastAPI app: stateless endpoints plus the static frontend.

No server-side session/user state is kept between requests - the frontend
holds candidate data from /api/find-pois and resubmits the selected ones
(plus the original file) to /api/save or /api/wahoo/route-payload, so one
visitor's data never touches another's and a second Overpass query isn't
needed afterwards.
"""

import asyncio
import base64
import math
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import requests
from fastapi import Depends, FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from gpxpy.gpx import GPX, GPXException, GPXWaypoint
from prometheus_fastapi_instrumentator import Instrumentator
from pydantic import TypeAdapter, ValidationError

from waypointer.device_profiles import DEFAULT_DEVICE_KEY, DEVICE_PROFILES, OutputFormat
from waypointer.fit_io import FitCoursePoint, build_course_fit_bytes
from waypointer.fit_read import fit_route_to_gpx_bytes
from waypointer.geometry import (
    LatLon,
    build_polyline_index,
    project_onto_polyline_indexed_m,
    simplify_rdp,
    total_distance_m,
)
from waypointer.gpx_io import (
    add_waypoints,
    discard_waypoints,
    infer_poi_type,
    is_duplicate_candidate,
    make_waypoint,
    parse_gpx,
    route_coordinates,
    route_elevations,
    to_xml_bytes,
    total_ascent_m,
)
from waypointer.osm import (
    USER_AGENT,
    OsmNode,
    OverpassError,
    build_overpass_query,
    nearest_node,
    query_overpass,
)
from waypointer.poi_types import DEFAULT_VISIBLE_POI_TYPES, POI_TYPES, clamp_distance_m
from waypointer.rate_limit import lookup_poi_rate_limit, rate_limit
from waypointer.schemas import (
    Candidate,
    ExistingWaypoint,
    FailedPoiType,
    FindPoisResponse,
    PoiLookupResult,
    PoiSearchConfig,
    WahooRoutePayload,
)

# Built by `npm run build` in frontend/ (or the Docker image's Node build
# stage) - not present until that's run, so the frontend mount below is
# guarded rather than assumed to exist for backend-only local dev.
FRONTEND_DIST_DIR = Path(__file__).parent.parent.parent / "frontend" / "dist"
# How far simplify_rdp is allowed to let the simplified route wander from
# the true route - see the Overpass radius padding in find_pois() below,
# which depends on this bound to avoid missing genuinely-in-range nodes.
SIMPLIFY_TOLERANCE_M = 8.0
# The Wahoo route FIT file lives on their CDN; /api/wahoo/import-route only
# ever fetches from Wahoo, so it restricts the caller-supplied URL to this
# host suffix rather than fetching arbitrary URLs (SSRF guard).
WAHOO_FILE_HOST_SUFFIX = ".wahooligan.com"

app = FastAPI(title="Sulla Via")

# Exposes GET /metrics (request count, latency histogram, in-progress gauge,
# labeled by method/path/status) for the docker-compose Prometheus service to
# scrape. Registered here, ahead of every route, though placement doesn't
# actually matter for it - LAN-only, no auth on /metrics, matching this app's
# existing trust model (self-signed TLS, no login anywhere else; see
# CLAUDE.md's Telemetry section). Single uvicorn process, so the default
# in-memory prometheus_client registry is fine - no multiprocess mode needed,
# same reasoning as rate_limit.py's in-process design.
Instrumentator().instrument(app).expose(app)

_selected_candidates_adapter = TypeAdapter(list[Candidate])
_poi_config_adapter = TypeAdapter(list[PoiSearchConfig])
_discarded_indices_adapter = TypeAdapter(list[int])
_existing_waypoint_types_adapter = TypeAdapter(dict[str, str])


async def _read_gpx_upload(gpx_file: UploadFile) -> tuple[GPX, list[LatLon]]:
    content = await gpx_file.read()
    try:
        gpx = parse_gpx(content)
    except GPXException as exc:
        raise HTTPException(status_code=400, detail=f"Invalid GPX file: {exc}") from exc

    coords = route_coordinates(gpx)
    if not coords:
        raise HTTPException(
            status_code=400, detail="No track or route points found in the GPX file."
        )
    return gpx, coords


def _default_poi_config() -> list[PoiSearchConfig]:
    return [
        PoiSearchConfig(poi_type=key, max_distance_m=POI_TYPES[key].default_max_distance_m)
        for key in DEFAULT_VISIBLE_POI_TYPES
    ]


@app.post("/api/find-pois", response_model=FindPoisResponse, dependencies=[Depends(rate_limit)])
async def find_pois(
    gpx_file: UploadFile,
    poi_config: str | None = Form(None),
) -> FindPoisResponse:
    gpx, coords = await _read_gpx_upload(gpx_file)

    if poi_config is None:
        requested = _default_poi_config()
    else:
        try:
            requested = _poi_config_adapter.validate_json(poi_config)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid poi_config: {exc}") from exc

    simplified = simplify_rdp(coords, tolerance_m=SIMPLIFY_TOLERANCE_M)
    route_index = build_polyline_index(coords)

    # Validate and build every query up front - bad poi_type/tag_filter
    # input must still 400 before any Overpass call fires, matching the
    # previous sequential behavior.
    prepared: list[tuple[PoiSearchConfig, float, str]] = []
    for entry in requested:
        cfg = POI_TYPES.get(entry.poi_type)
        if cfg is None:
            raise HTTPException(status_code=400, detail=f"Unknown poi_type: {entry.poi_type}")
        if cfg.tag_filter is None:
            raise HTTPException(status_code=400, detail=f"{entry.poi_type} is not searchable")
        radius_m = clamp_distance_m(entry.poi_type, entry.max_distance_m)

        # The Overpass query runs against the simplified route, which can
        # sit up to SIMPLIFY_TOLERANCE_M away from the true route at any
        # given point (that's the RDP tolerance). Searching Overpass at the
        # exact requested radius would miss nodes that are genuinely within
        # radius_m of the true route but happen to be farther than that from
        # the simplified line - so the Overpass-side radius is padded by the
        # simplification tolerance. The authoritative check below still uses
        # the exact radius_m against the full-resolution route, so this
        # can't introduce false positives, only prevents false negatives.
        overpass_radius_m = radius_m + SIMPLIFY_TOLERANCE_M
        query = build_overpass_query(simplified, tag_filter=cfg.tag_filter, radius_m=math.ceil(overpass_radius_m))
        prepared.append((entry, radius_m, query))

    # Fire all Overpass calls concurrently instead of one-at-a-time - N
    # requested POI types used to mean N sequential blocking HTTP round
    # trips; asyncio.to_thread offloads each of query_overpass's blocking
    # requests.post calls to a worker thread so they run in parallel and
    # stop hogging the event loop. Errors are caught per-call so one type
    # failing/timing out doesn't take the others down with it.
    async def _fetch_one(
        entry: PoiSearchConfig, query: str
    ) -> tuple[PoiSearchConfig, list[OsmNode], OverpassError | None]:
        try:
            nodes = await asyncio.to_thread(query_overpass, query)
            return entry, nodes, None
        except OverpassError as exc:
            return entry, [], exc

    fetch_results = await asyncio.gather(
        *(_fetch_one(entry, query) for entry, _radius_m, query in prepared)
    )

    if prepared and all(error is not None for _entry, _nodes, error in fetch_results):
        raise HTTPException(
            status_code=502, detail=f"Failed to query OpenStreetMap: {fetch_results[0][2]}"
        )

    candidates: list[Candidate] = []
    failed_poi_types: list[FailedPoiType] = []
    for (entry, radius_m, _query), (_entry, nodes, error) in zip(prepared, fetch_results):
        if error is not None:
            failed_poi_types.append(FailedPoiType(poi_type=entry.poi_type, error=str(error)))
            continue

        for node in nodes:
            if is_duplicate_candidate(node, gpx):
                continue
            # Authoritative distance check against the full-resolution
            # route, never the simplified one used only to build the
            # Overpass query - and against this type's own clamped radius,
            # not a global constant.
            distance_m, distance_from_start_m = project_onto_polyline_indexed_m(
                (node.lat, node.lon), route_index
            )
            if distance_m <= radius_m:
                candidates.append(
                    Candidate(
                        osm_id=node.id,
                        poi_type=entry.poi_type,
                        name=node.tags.get("name"),
                        lat=node.lat,
                        lon=node.lon,
                        distance_m=distance_m,
                        distance_from_start_m=distance_from_start_m,
                    )
                )

    candidates.sort(key=lambda c: c.distance_m)
    existing_waypoints = []
    for i, w in enumerate(gpx.waypoints):
        distance_from_route_m, distance_from_start_m = project_onto_polyline_indexed_m(
            (w.latitude, w.longitude), route_index
        )
        existing_waypoints.append(
            ExistingWaypoint(
                index=i,
                name=w.name,
                lat=w.latitude,
                lon=w.longitude,
                poi_type=infer_poi_type(w),
                distance_from_route_m=distance_from_route_m,
                distance_from_start_m=distance_from_start_m,
            )
        )
    return FindPoisResponse(
        candidates=candidates,
        point_count=len(coords),
        existing_waypoints=existing_waypoints,
        route_coords=simplified,
        failed_poi_types=failed_poi_types,
    )


def _safe_filename_stem(filename: str | None) -> str:
    stem = Path(os.path.basename(filename or "route")).stem
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_")
    return stem or "route"


def _display_name(route_name: str | None, fallback_filename: str | None) -> str:
    """Human-readable name for FIT course_name / Wahoo route[name] - kept
    separate from _safe_filename_stem, which sanitizes for filesystem safety
    (spaces -> underscores) and would otherwise mangle a user-typed name
    when reused as a display title."""
    if route_name and route_name.strip():
        return route_name.strip()
    stem = Path(os.path.basename(fallback_filename or "route")).stem
    return stem or "route"


def _resolved_name(c: Candidate) -> str:
    cfg = POI_TYPES.get(c.poi_type, POI_TYPES["generic"])
    return c.name or cfg.default_name


def _build_fit_course_points(
    selected: list[Candidate],
    original_waypoints: list[GPXWaypoint],
    discarded_indices: set[int],
    existing_types: dict[str, str],
) -> list[FitCoursePoint]:
    """Combines newly-selected candidates with kept (non-discarded)
    pre-existing waypoints into one course-point list for FIT export -
    shared by /api/save's FIT branch and /api/wahoo/route-payload, both of
    which now treat existing and newly-found POIs identically. Each kept
    waypoint's type comes from existing_types (the visitor's
    AssignWaypointTypesDialog choice, keyed by original index as a string
    since it arrives as JSON), defaulting to "generic" if missing/unknown -
    original_waypoints must be the pre-discard snapshot so indices line up
    with ExistingWaypoint.index."""
    candidate_points = [
        FitCoursePoint(lat=c.lat, lon=c.lon, name=_resolved_name(c), poi_type=c.poi_type) for c in selected
    ]
    existing_points = [
        FitCoursePoint(
            lat=w.latitude,
            lon=w.longitude,
            name=w.name,
            poi_type=existing_types.get(str(i), "generic"),
        )
        for i, w in enumerate(original_waypoints)
        if i not in discarded_indices
    ]
    return candidate_points + existing_points


def _resolve_symbol(poi_type: str, symbols: dict[str, str]) -> str:
    """The visitor's chosen GPX <sym> for this POI type, if any, else the
    registry's suggested default, else the type's own label - always
    resolves to a non-empty string. Only meaningful for GPX exports; FIT
    course points get their icon from course_point_type instead (see
    fit_io.py)."""
    cfg = POI_TYPES[poi_type]
    return symbols.get(poi_type) or cfg.default_gpx_symbol or cfg.label


@app.post("/api/save")
async def save(
    gpx_file: UploadFile,
    selected_candidates: str = Form(...),
    device: str = Form(DEFAULT_DEVICE_KEY),
    symbols: str = Form("{}"),
    discarded_waypoint_indices: str = Form("[]"),
    existing_waypoint_types: str = Form("{}"),
    route_name: str | None = Form(None),
) -> Response:
    gpx, coords = await _read_gpx_upload(gpx_file)

    try:
        selected = _selected_candidates_adapter.validate_json(selected_candidates)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid selection data: {exc}") from exc

    try:
        discarded_indices = set(_discarded_indices_adapter.validate_json(discarded_waypoint_indices))
    except ValidationError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid discarded waypoint indices: {exc}"
        ) from exc

    try:
        existing_types = _existing_waypoint_types_adapter.validate_json(existing_waypoint_types)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid existing waypoint types: {exc}") from exc

    try:
        symbol_overrides = _existing_waypoint_types_adapter.validate_json(symbols)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid symbols: {exc}") from exc

    # Snapshot before discard_waypoints mutates gpx.waypoints in place -
    # _build_fit_course_points needs the original, pre-discard indices to
    # line up with ExistingWaypoint.index/existing_types' keys.
    original_waypoints = list(gpx.waypoints)
    # Only meaningful for the GPX branch below, but harmless either way -
    # mutates the same waypoint objects discard_waypoints then filters.
    for i, w in enumerate(original_waypoints):
        if i not in discarded_indices:
            w.symbol = _resolve_symbol(existing_types.get(str(i), "generic"), symbol_overrides)
    # Indices refer to gpx.waypoints' original, pre-discard order, so this
    # must run before add_waypoints appends any newly selected candidates.
    discard_waypoints(gpx, discarded_indices)

    profile = DEVICE_PROFILES.get(device)
    if profile is None:
        raise HTTPException(status_code=400, detail=f"Unknown device: {device}")

    name_stem = _safe_filename_stem(route_name or gpx_file.filename)

    if profile.output_format is OutputFormat.GPX:
        waypoints = [
            make_waypoint(
                OsmNode(id=c.osm_id, lat=c.lat, lon=c.lon, tags={"name": _resolved_name(c)}),
                _resolve_symbol(c.poi_type, symbol_overrides),
                c.distance_m,
            )
            for c in selected
        ]
        add_waypoints(gpx, waypoints)
        content = to_xml_bytes(gpx)
        media_type = "application/gpx+xml"
        extension = "gpx"
    else:
        course_points = _build_fit_course_points(selected, original_waypoints, discarded_indices, existing_types)
        content = build_course_fit_bytes(
            coords,
            course_points,
            course_name=_display_name(route_name, gpx_file.filename),
            elevations_m=route_elevations(gpx),
        )
        media_type = "application/octet-stream"
        extension = "fit"

    filename = f"{name_stem}_waypoints.{extension}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/wahoo/route-payload", response_model=WahooRoutePayload)
async def wahoo_route_payload(
    gpx_file: UploadFile,
    selected_candidates: str = Form(...),
    discarded_waypoint_indices: str = Form("[]"),
    existing_waypoint_types: str = Form("{}"),
    route_name: str | None = Form(None),
) -> WahooRoutePayload:
    """Builds the FIT bytes + metadata needed for a browser-side push to
    Wahoo's POST /v1/routes. Distance and ascent are computed here rather
    than client-side because only the backend ever sees the full-resolution,
    elevation-carrying route - /api/find-pois only ever sends the frontend a
    simplified, elevation-stripped polyline for map rendering. Always
    produces FIT regardless of the visitor's local-download device
    selection, since Wahoo's route push has no GPX equivalent - and, like
    /api/save's FIT branch, includes kept pre-existing GPX <wpt> entries as
    course points too (see _build_fit_course_points)."""
    gpx, coords = await _read_gpx_upload(gpx_file)

    try:
        selected = _selected_candidates_adapter.validate_json(selected_candidates)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid selection data: {exc}") from exc

    try:
        discarded_indices = set(_discarded_indices_adapter.validate_json(discarded_waypoint_indices))
    except ValidationError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid discarded waypoint indices: {exc}"
        ) from exc

    try:
        existing_types = _existing_waypoint_types_adapter.validate_json(existing_waypoint_types)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid existing waypoint types: {exc}") from exc

    # This endpoint never mutates gpx.waypoints, so gpx.waypoints itself
    # (not a pre-mutation snapshot, unlike /api/save) already reflects the
    # original document order.
    course_points = _build_fit_course_points(selected, gpx.waypoints, discarded_indices, existing_types)
    name_stem = _safe_filename_stem(route_name or gpx_file.filename)
    display_name = _display_name(route_name, gpx_file.filename)
    fit_bytes = build_course_fit_bytes(
        coords, course_points, course_name=display_name, elevations_m=route_elevations(gpx)
    )

    return WahooRoutePayload(
        fit_base64=base64.b64encode(fit_bytes).decode("ascii"),
        filename=f"{name_stem}.fit",
        route_name=display_name,
        distance_m=total_distance_m(coords),
        ascent_m=total_ascent_m(gpx),
        start_lat=coords[0][0],
        start_lng=coords[0][1],
    )


@app.post("/api/wahoo/import-route")
def wahoo_import_route(file_url: str = Form(...)) -> Response:
    """Downloads a Wahoo route's FIT file (server-side, avoiding the CDN's
    lack of CORS headers) and converts it to GPX so it can be imported into
    the same GPX-only pipeline a user upload flows through. The FIT file URL
    comes from GET /v1/routes' `file.url`; the host is restricted to Wahoo's
    to avoid turning this into an open proxy (SSRF). No Wahoo access token is
    sent - the CDN URL is expected to be publicly fetchable, keeping the
    backend free of any Wahoo credentials as elsewhere."""
    host = urlparse(file_url).hostname or ""
    if host != WAHOO_FILE_HOST_SUFFIX.lstrip(".") and not host.endswith(WAHOO_FILE_HOST_SUFFIX):
        raise HTTPException(status_code=400, detail="file_url must be a Wahoo-hosted URL.")

    try:
        response = requests.get(file_url, headers={"User-Agent": USER_AGENT}, timeout=30)
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to download route from Wahoo: {exc}"
        ) from exc
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Wahoo returned status {response.status_code} for the route file.",
        )

    try:
        gpx_bytes = fit_route_to_gpx_bytes(response.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Could not read the Wahoo route: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - fit-tool raises bare exceptions on malformed input
        raise HTTPException(status_code=400, detail=f"Invalid Wahoo route file: {exc}") from exc

    return Response(
        content=gpx_bytes,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": 'attachment; filename="wahoo_route.gpx"'},
    )


# Resolves *this specific rendered basemap icon*, independent of the poi
# type's own (usually much larger) find-pois search-distance bounds.
LOOKUP_POI_RADIUS_M = 40


@app.post(
    "/api/lookup-poi",
    response_model=PoiLookupResult,
    dependencies=[Depends(lookup_poi_rate_limit)],
)
async def lookup_poi(
    lat: float = Form(...), lon: float = Form(...), poi_type: str = Form(...)
) -> PoiLookupResult:
    """Resolves a click on one of the basemap's own POI icons to the real OSM
    node behind it - those icons carry only a class/subclass/name, no OSM id
    or tags, so the frontend can't build a Candidate (or show tags/an edit
    link) without this round trip. Deliberately takes no gpx_file: this is
    click-driven and must work before any route is loaded.
    """
    cfg = POI_TYPES.get(poi_type)
    if cfg is None or cfg.tag_filter is None:
        raise HTTPException(status_code=400, detail=f"{poi_type} is not searchable")

    query = build_overpass_query(
        [(lat, lon)], tag_filter=cfg.tag_filter, radius_m=LOOKUP_POI_RADIUS_M
    )
    try:
        nodes = await asyncio.to_thread(query_overpass, query)
    except OverpassError as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to query OpenStreetMap: {exc}"
        ) from exc

    node = nearest_node(nodes, lat, lon)
    if node is None:
        raise HTTPException(
            status_code=404, detail="No matching OpenStreetMap node found near this point."
        )

    return PoiLookupResult(
        osm_id=node.id,
        poi_type=poi_type,
        name=node.tags.get("name"),
        lat=node.lat,
        lon=node.lon,
        tags=node.tags,
    )


# Catch-all mount for the built SPA - MUST be registered last. StaticFiles
# matches any path not already claimed by a route above it, so mounting
# this before the /api/* routes would shadow them entirely.
if FRONTEND_DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
