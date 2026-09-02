# Route planner — decisions & open questions

This is an exploration doc, not an implementation plan. Nothing gets built from this session — the goal is to lay out what has to be decided before we scope the actual work.

## Context

Today the app only has two ways to get a route in: upload a GPX file, or import one from a connected Wahoo account (which itself downloads a FIT file and converts it to GPX, then re-enters the normal pipeline). Both endpoints (`/api/find-pois`, `/api/save`) require an actual GPX file upload server-side — there's no path for raw coordinates. The idea is to add a third way in: let a visitor draw a route directly on the map, with no source file at all, and have it flow into the exact same POI-enrichment/export pipeline.

Two decisions are already made (per your answers):
- **Road-snapped routing**: clicked points get connected via a real routing engine, not straight lines.
- **Entry point**: "Plan a route" becomes a third option in `ImportCard`, alongside GPX upload and Wahoo import, converging into the same downstream flow.

Everything below is what still needs deciding.

## What exists today (grounding)

- Frontend map is **MapLibre GL / react-map-gl** (`RouteMap.tsx`), not Leaflet — display-only right now. No click-to-add-point, no draggable markers, no `map.on("click")` handler anywhere.
- Backend has **no routing/directions engine** at all (`geometry.py` only measures/simplifies an already-given polyline — haversine, RDP simplify, point-to-polyline projection). No OSRM/GraphHopper/Valhalla/Mapbox/ORS integration exists.
- Both POI-search and save endpoints take a required `gpx_file: UploadFile` and parse it server-side via `gpxpy` — there's no "give me raw coords" path.
- The Wahoo import flow already establishes a precedent for "synthesize/convert to GPX client- or server-side, then reuse the existing GPX-only pipeline unchanged" rather than building parallel endpoints.
- App is fully stateless — no DB, no session, everything lives in frontend state and gets resubmitted each call. A route-planning feature should preserve that.

## Open questions

### 1. Routing engine choice
Which routing provider/engine, and how is it hosted?
- Self-hosted OSRM/Valhalla (own infra, own OSM extract, no per-request cost, but ops burden — extra container, data updates)
- Managed API (Mapbox Directions, GraphHopper Cloud, OpenRouteService) — no infra to run, but adds an API key, usage limits/cost, and another external dependency alongside Overpass
- This also decides how `render.yaml`/Docker changes (new service? new env var/secret?)

### 2. Activity profile
Routing engines need a mode (cycling / walking / driving) to snap correctly.
- Does the planner need a profile selector, or is one fixed default (e.g. cycling) good enough for v1?
- If selectable, does it need to match/inform the existing POI search-distance defaults per type (currently water-only, one registry)?

### 3. How routed segments get requested
- One routing call per pair of consecutive clicked points (simple, chatty, easy to reroute a single segment on drag), or one call for the whole route recomputed on every edit (simpler client logic, more redundant requests)?
- Rate limiting: `rate_limit.py` currently only guards `/api/find-pois` (Overpass). Does a new routing-backed endpoint need its own limiter?

### 4. New backend surface
- New endpoint(s) needed: e.g. `POST /api/route-segment` (start/end/profile → polyline) called live while drawing, and something that turns the final drawn route into a GPX file (server-side synthesis, or client-side using something like the existing `lib/gpx.ts`/synthesized `<trk>` and reuse `/api/find-pois` unchanged, mirroring how Wahoo import converts FIT→GPX before handing off)?
- Where do elevations come from for a hand-drawn route — omitted entirely (0/absent `<ele>`), pulled from the routing engine's response (some do return elevation), or a separate elevation/DEM lookup? This matters for FIT course export, which is elevation-profile-aware on the Wahoo.

### 5. Map editing interactions (net-new frontend work)
None of this exists in `RouteMap.tsx` today:
- Click-to-add a point (append to end vs insert into an existing segment)
- Drag an existing point to move it (and re-request the routing for its adjacent segments)
- Delete a point / undo
- Visual distinction between "confirmed route" and "in-progress draft"
- Touch/mobile support for point placement
- Loop / out-and-back detection already exists for uploaded routes (`RouteEndpointMarkers` collapses coincident start/end) — does drawn-route UX need an explicit "close the loop" action, or does it fall out naturally from clicking back on the start point?

### 6. Interaction with existing "already in file" waypoints
A drawn route has no pre-existing `<wpt>` entries, so `CandidateChecklist`'s "Already in this file" subsection is naturally empty — no special-casing needed there. Worth confirming this assumption holds once the synthesized GPX shape is decided (point 4).

### 7. Scale/practicality limits
- Max number of points / route length for a drawn route, both for routing-API cost and Overpass query size (the existing RDP-simplify + padding logic in `geometry.py`/`main.py` assumes a route that came from a real GPX track, likely already reasonably dense — a sparse hand-drawn route may behave differently).
- Should route planning have its own distinct rate limit given it now depends on two external APIs (routing + Overpass) instead of one?

### 8. Naming/export parity
- Does a planned route need a name/title before save (currently `route_name` is an optional form field on `/api/save`)? Should it be required when there's no source filename to default to?

## Suggested next step (not started)

Once the routing-provider and profile questions (1–2) are answered, the natural next move is a `Plan` pass focused specifically on the map-editing UX in `RouteMap.tsx` plus the new routing endpoint — those two are the actual net-new surface; everything downstream (POI search, checklist, save/export) should need little to no change since it already only cares about a `route_coords: [lat,lon][]` list plus an eventual GPX/FIT file.
