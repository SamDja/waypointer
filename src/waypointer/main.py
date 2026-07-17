"""FastAPI app: stateless endpoints plus the static frontend.

No server-side session/user state is kept between requests - the frontend
holds candidate data from /api/find-pois and resubmits the selected ones
(plus the original file) to /api/save or /api/wahoo/route-payload, so one
visitor's data never touches another's and a second Overpass query isn't
needed afterwards.
"""

import base64
import dataclasses
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
from pydantic import TypeAdapter, ValidationError

from waypointer.device_profiles import DEFAULT_DEVICE_KEY, DEVICE_PROFILES, OutputFormat
from waypointer.fit_io import FitCoursePoint, build_course_fit_bytes
from waypointer.fit_read import fit_route_to_gpx_bytes
from waypointer.geometry import LatLon, project_onto_polyline_m, simplify_rdp, total_distance_m
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
from waypointer.osm import USER_AGENT, OsmNode, OverpassError, build_overpass_query, query_overpass
from waypointer.poi_types import POI_TYPES, clamp_distance_m
from waypointer.rate_limit import rate_limit
from waypointer.schemas import (
    Candidate,
    ExistingWaypoint,
    FindPoisResponse,
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

app = FastAPI(title="Waypointer")

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
    water = POI_TYPES["water"]
    return [PoiSearchConfig(poi_type=water.key, max_distance_m=water.default_max_distance_m)]


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

    candidates: list[Candidate] = []
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
        try:
            nodes = query_overpass(query)
        except OverpassError as exc:
            raise HTTPException(
                status_code=502, detail=f"Failed to query OpenStreetMap: {exc}"
            ) from exc

        for node in nodes:
            if is_duplicate_candidate(node, gpx):
                continue
            # Authoritative distance check against the full-resolution
            # route, never the simplified one used only to build the
            # Overpass query - and against this type's own clamped radius,
            # not a global constant.
            distance_m, distance_from_start_m = project_onto_polyline_m((node.lat, node.lon), coords)
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
        distance_from_route_m, distance_from_start_m = project_onto_polyline_m((w.latitude, w.longitude), coords)
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


@app.post("/api/save")
async def save(
    gpx_file: UploadFile,
    selected_candidates: str = Form(...),
    device: str = Form(DEFAULT_DEVICE_KEY),
    water_symbol: str = Form("Water"),
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

    # Snapshot before discard_waypoints mutates gpx.waypoints in place -
    # _build_fit_course_points needs the original, pre-discard indices to
    # line up with ExistingWaypoint.index/existing_types' keys.
    original_waypoints = list(gpx.waypoints)
    # Indices refer to gpx.waypoints' original, pre-discard order, so this
    # must run before add_waypoints appends any newly selected candidates.
    discard_waypoints(gpx, discarded_indices)

    profile = DEVICE_PROFILES.get(device)
    if profile is None:
        raise HTTPException(status_code=400, detail=f"Unknown device: {device}")

    name_stem = _safe_filename_stem(route_name or gpx_file.filename)

    if profile.output_format is OutputFormat.GPX:
        effective_profile = dataclasses.replace(profile, water_symbol=water_symbol.strip() or "Water")
        waypoints = [
            make_waypoint(
                OsmNode(id=c.osm_id, lat=c.lat, lon=c.lon, tags={"name": _resolved_name(c)}),
                effective_profile,
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


# Catch-all mount for the built SPA - MUST be registered last. StaticFiles
# matches any path not already claimed by a route above it, so mounting
# this before the /api/* routes would shadow them entirely.
if FRONTEND_DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
