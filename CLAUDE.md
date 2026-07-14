# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Waypointer is a web app: a visitor uploads a GPX route, the backend finds OpenStreetMap drinking-water fountains within 50m of it via the Overpass API, the visitor reviews/selects them on a map + checklist, and downloads a new route file with the selected fountains added — either as GPX waypoints (generic devices) or as a FIT course file (Wahoo ELEMNT ROAM v3, so the water icon renders correctly while navigating; see "FIT export" below for why this needs a whole separate code path).

Two halves in one repo, one Docker image:
- **Backend**: `src/waypointer/` — stateless FastAPI app (Python, managed with `uv`).
- **Frontend**: `frontend/` — React + TypeScript SPA (Vite, shadcn/ui, react-leaflet), built to static assets that the backend serves.

## Commands

### Backend
```bash
uv sync                                          # install deps
uv run pytest                                    # run all tests
uv run pytest tests/test_fit_io.py                # run one test file
uv run pytest tests/test_fit_io.py::test_build_course_fit_bytes_round_trip   # run one test
uv run uvicorn waypointer.main:app --reload      # dev server at :8000
```

### Frontend
```bash
cd frontend
npm install
npm run dev       # Vite dev server at :5173, proxies /api/* to localhost:8000 (see vite.config.ts)
npm run build     # tsc -b && vite build -> frontend/dist/
npm run lint       # oxlint
```
Run the backend (`uv run uvicorn ... --reload`) and `npm run dev` side by side for frontend work — the Vite proxy forwards API calls, so no CORS setup is needed. `uv run uvicorn` alone (no Vite) only serves the frontend correctly if `frontend/dist/` already exists from a prior `npm run build`; otherwise the catch-all mount in `main.py` is skipped entirely (see below) and only `/api/*` routes work.

### Docker (production shape)
```bash
docker build -t waypointer .
docker run -p 8000:8000 waypointer
```
Multi-stage: a `node` stage runs `npm ci && npm run build`, then the `python:3.11-slim` + `uv` stage copies that build output in. Deployed to Render via `render.yaml` (`dockerfilePath: ./Dockerfile`).

## Backend architecture (`src/waypointer/`)
Two endpoints only, both stateless — no DB, no session, no server-side memory between requests. The frontend holds all state client-side and resubmits the original GPX file on every request.

- `main.py` — `POST /api/find-fountains` and `POST /api/save`. Also mounts the built SPA (`frontend/dist/`, `StaticFiles(html=True)`) at `/` as a catch-all — **this mount must stay the last thing registered in the file**, after both API route decorators, or it shadows `/api/*` entirely (Starlette matches routes in registration order). The mount is skipped if `frontend/dist/` doesn't exist, so backend-only dev without a frontend build doesn't crash on startup.
- `geometry.py` — pure-stdlib haversine/point-to-segment/point-to-polyline distance, and `simplify_rdp` (Ramer-Douglas-Peucker). `simplify_rdp`'s output is used **only** to keep the Overpass query small and for the map's route line — the authoritative "is this fountain within 50m" check in `main.py` always runs against the full-resolution, unsimplified route.
- `osm.py` — Overpass QL query builder + HTTP client. Two non-obvious things: (1) Overpass expects the raw query text as the POST body, not wrapped in a `data=` form field — the latter gets rejected with 406 by at least the `overpass-api.de` mirror; (2) a custom `User-Agent` is required or Overpass rejects the default `python-requests` UA. There's also a small in-process TTL cache to avoid hammering the shared public Overpass instance from a public deployment.
- `gpx_io.py` — GPX parsing/merging via `gpxpy`, operating on bytes only (no filesystem I/O anywhere in the request path). Dedup of previously-added fountains works by stamping a custom `<extensions><waypointer:osm_id>` marker on GPX waypoints and checking for it on re-upload, with a proximity fallback for waypoints that lack the marker (hand-edited files, other tools).
- `fit_io.py` — builds a full ridable FIT course (not just isolated waypoints) using the `fit-tool` library. **The water icon on a Wahoo does not come from the standard FIT `course_point.type` enum** — reverse-engineering a real Komoot→Wahoo-generated FIT file (see `dev_tools/`) showed the icon is driven by a custom developer field named `course_point_type` (uint8), with `16` = water. This was later confirmed against the device for the full 0-99 range (`dev_tools/wahoo_poi_mapping.json`). The native `type` field is left as `CoursePoint.GENERIC` to match the confirmed-working reference file.
- `device_profiles.py` — small registry (`DEVICE_PROFILES`, not a plugin system) mapping a device key to an `OutputFormat` (`GPX` or `FIT`) and the values each format needs (`water_symbol` for GPX, `water_course_point_type` for FIT).
- `rate_limit.py` — in-memory per-IP sliding window, applied only to `/api/find-fountains` (the only endpoint that calls Overpass). Single-process only, not meant to survive multiple workers/restarts.
- `schemas.py` — the two Pydantic response/request shapes shared with the frontend's TS types
  (`frontend/src/types/candidate.ts` mirrors `Candidate`/`FindFountainsResponse` by hand — keep them in sync manually when changing one side).

`dev_tools/` is exploratory tooling, not part of the shipped app: `generate_test_waypoints.py` builds a FIT file with all 100 `course_point_type` values laid out in a grid for manual on-device icon testing; `wahoo_poi_mapping.json` and `POIs.csv` are the resulting reverse-engineered value→icon mapping (cross-referenced against Strava/RideWithGPS/komoot's own POI category names). Useful reference if extending FIT export to more POI types beyond water.

## Frontend architecture (`frontend/src/`)

- `App.tsx` owns all cross-cutting state via plain `useState` (no Redux/Context — intentionally, the tree is shallow). The one piece of state worth understanding: `selectedIds: Set<number>` is shared between `RouteMap` (map marker popups) and `CandidateChecklist` (the list) — both are just different views over the same state and call the same `onToggle`, which is what keeps map-popup and checklist selection in sync with no extra glue code.
- `RouteMap.tsx` always renders (a `MapContainer` with a neutral world-view default before any route is loaded) — the map is meant to be persistently visible, not conditionally mounted. Before `/api/find-fountains` returns, it shows a route line parsed client-side (`lib/gpx.ts`, via the browser's `DOMParser`, no library) purely for instant visual feedback on import; once the backend responds, it switches to the backend's authoritative `route_coords` + candidate markers. Uses `CircleMarker` (SVG circles) rather than `Marker` specifically to avoid Leaflet's default-icon-path-under-bundlers problem.
- Layout is a persistent left-hand map + a fixed-width (`380px`) right sidebar holding the step cards, in order: `ImportCard` (drag-and-drop or click-to-browse) → `FindFountainsCard` (button + route summary) → `CandidateChecklist` (only once results exist) → `SaveCard` (device/format selection + save, only once results exist — device selection lives here because it only affects export format). Stacks vertically below the `md` breakpoint instead of side-by-side.
- `lib/api.ts` — thin typed `fetch` wrappers, one function per backend endpoint, no abstraction beyond that.
- `lib/settings.ts` — persists `{device, waterSymbol}` to `localStorage` under key `"waypointer.settings"`.
- shadcn/ui components live in `components/ui/` (generated source, not an npm package) — add more via `npx shadcn@latest add <name>` from `frontend/`, not by hand-writing them.
