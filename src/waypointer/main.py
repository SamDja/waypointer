"""FastAPI app: two stateless endpoints plus the static frontend.

No server-side session/user state is kept between requests - the frontend
holds candidate data from /api/find-fountains and resubmits the selected
ones (plus the original file) to /api/save, so one visitor's data never
touches another's and a second Overpass query isn't needed on save.
"""

import dataclasses
import os
import re
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from gpxpy.gpx import GPX, GPXException
from pydantic import TypeAdapter, ValidationError

from waypointer.device_profiles import DEFAULT_DEVICE_KEY, DEVICE_PROFILES, OutputFormat
from waypointer.fit_io import FitFountain, build_course_fit_bytes
from waypointer.geometry import LatLon, point_to_polyline_distance_m, simplify_rdp
from waypointer.gpx_io import (
    add_waypoints,
    is_duplicate_candidate,
    make_waypoint,
    parse_gpx,
    route_coordinates,
    to_xml_bytes,
)
from waypointer.osm import OsmNode, OverpassError, build_overpass_query, query_overpass
from waypointer.rate_limit import rate_limit
from waypointer.schemas import Candidate, FindFountainsResponse

# Built by `npm run build` in frontend/ (or the Docker image's Node build
# stage) - not present until that's run, so the frontend mount below is
# guarded rather than assumed to exist for backend-only local dev.
FRONTEND_DIST_DIR = Path(__file__).parent.parent.parent / "frontend" / "dist"
SIMPLIFY_TOLERANCE_M = 8.0
MATCH_RADIUS_M = 50.0

app = FastAPI(title="Waypointer")

_selected_candidates_adapter = TypeAdapter(list[Candidate])


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


@app.post("/api/find-fountains", response_model=FindFountainsResponse, dependencies=[Depends(rate_limit)])
async def find_fountains(gpx_file: UploadFile) -> FindFountainsResponse:
    gpx, coords = await _read_gpx_upload(gpx_file)

    simplified = simplify_rdp(coords, tolerance_m=SIMPLIFY_TOLERANCE_M)
    query = build_overpass_query(simplified, radius_m=int(MATCH_RADIUS_M))
    try:
        nodes = query_overpass(query)
    except OverpassError as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to query OpenStreetMap: {exc}"
        ) from exc

    candidates: list[Candidate] = []
    for node in nodes:
        if is_duplicate_candidate(node, gpx):
            continue
        # Authoritative distance check against the full-resolution route,
        # never the simplified one used only to build the Overpass query.
        distance_m = point_to_polyline_distance_m((node.lat, node.lon), coords)
        if distance_m <= MATCH_RADIUS_M:
            candidates.append(
                Candidate(
                    osm_id=node.id,
                    name=node.tags.get("name"),
                    lat=node.lat,
                    lon=node.lon,
                    distance_m=distance_m,
                )
            )

    candidates.sort(key=lambda c: c.distance_m)
    return FindFountainsResponse(
        candidates=candidates,
        point_count=len(coords),
        existing_waypoint_count=len(gpx.waypoints),
        route_coords=simplified,
    )


def _safe_filename_stem(filename: str | None) -> str:
    stem = Path(os.path.basename(filename or "route")).stem
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem).strip("_")
    return stem or "route"


@app.post("/api/save")
async def save(
    gpx_file: UploadFile,
    selected_candidates: str = Form(...),
    device: str = Form(DEFAULT_DEVICE_KEY),
    water_symbol: str = Form("Water"),
) -> Response:
    gpx, coords = await _read_gpx_upload(gpx_file)

    try:
        selected = _selected_candidates_adapter.validate_json(selected_candidates)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid selection data: {exc}") from exc

    profile = DEVICE_PROFILES.get(device)
    if profile is None:
        raise HTTPException(status_code=400, detail=f"Unknown device: {device}")

    if profile.output_format is OutputFormat.GPX:
        effective_profile = dataclasses.replace(profile, water_symbol=water_symbol.strip() or "Water")
        waypoints = [
            make_waypoint(
                OsmNode(id=c.osm_id, lat=c.lat, lon=c.lon, tags={"name": c.name} if c.name else {}),
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
        fountains = [FitFountain(lat=c.lat, lon=c.lon, name=c.name) for c in selected]
        content = build_course_fit_bytes(
            coords, fountains, course_name=_safe_filename_stem(gpx_file.filename)
        )
        media_type = "application/octet-stream"
        extension = "fit"

    filename = f"{_safe_filename_stem(gpx_file.filename)}_waypoints.{extension}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Catch-all mount for the built SPA - MUST be registered last. StaticFiles
# matches any path not already claimed by a route above it, so mounting
# this before the /api/* routes would shadow them entirely.
if FRONTEND_DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
