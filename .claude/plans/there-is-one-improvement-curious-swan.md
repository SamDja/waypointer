# Plan: fix `/api/find-pois` timeouts on long routes / many POI types

## Context

`/api/find-pois` frequently exceeds its timeout on long routes, and the user
observed three contributing variables: number of POI types, per-type search
distance, and route length. Investigation confirmed all three, plus two
mechanisms the user hadn't named:

1. **Overpass calls are fully sequential and blocking.** `find_pois()`
   (`src/waypointer/main.py:112`) loops over every requested POI type and
   calls `query_overpass()` (`src/waypointer/osm.py`) one at a time, via a
   plain sync `requests.post` invoked directly inside an `async def`
   endpoint. N requested types means N sequential HTTP round-trips (each up
   to Overpass's own 90s server-side timeout, bounded by a 30s client
   timeout), and the blocking call also freezes the event loop for other
   concurrent visitors for that whole duration. `DEFAULT_VISIBLE_POI_TYPES`
   is 6 types out of 33 searchable ones — a visitor enabling more types
   multiplies worst-case latency roughly linearly.
2. **The authoritative in-range check has no spatial index.**
   `project_onto_polyline_m` (`src/waypointer/geometry.py:78-99`) is a linear
   scan over every segment of the full-resolution route, called once per
   Overpass-returned candidate (`main.py:145`) and once per existing GPX
   waypoint (`main.py:162`). This is O(route_points × candidates) with no
   bounding-box/grid prefilter, so long routes (tens of thousands of track
   points) compound with dense POI types.
3. Distance and route length individually inflate Overpass's own `around`
   query cost, as the user already suspected — that part is inherent to
   Overpass and not something to fight directly; the two structural fixes
   above are what actually move the needle.

Goal of this change: make `/api/find-pois` scale close to the *slowest
single* Overpass call rather than the *sum* of all calls, make the
CPU-bound in-range check near-constant-time per candidate instead of linear
in route length, and degrade gracefully (partial results) instead of
failing the whole request when one POI type's Overpass call is slow or
errors.

Decisions below were confirmed with the user directly (not left as open
questions):
- Primary fix is **parallelizing** the N Overpass calls, not merging them
  into a single Overpass query.
- The O(route × candidates) distance check **is in scope** — add a spatial
  index.
- **Partial results are acceptable**: one POI type failing/timing out
  should not fail the whole request.
- **Exception**: if *every* requested type fails, the endpoint should
  return **502**, not a 200 with an all-empty result — this is meant to
  distinguish "total Overpass outage" from "one flaky type."
- The failed-type banner is rendered **inside `CandidateChecklist`**,
  consistent with that component already owning all "how do we describe
  search results" messaging (it already builds the empty-state message the
  same way, at `CandidateChecklist.tsx:29-35`).

## 1. Concurrent Overpass calls

Use `asyncio.to_thread` to wrap the existing sync `query_overpass`, rather
than switching to `httpx.AsyncClient`. `httpx` is currently a dev-only
dependency (only used for FastAPI's `TestClient`); switching `osm.py` to it
would force promoting it to a runtime dependency and rewriting all of
`tests/test_osm.py`'s and `tests/test_api.py`'s Overpass mocking (`responses`
patches `requests`, not `httpx`) — no behavioral gain over `to_thread` for
this problem. `asyncio.to_thread` offloads the exact same blocking call to
the default executor, freeing the event loop, and needs zero changes to
`osm.py`.

In `main.py`'s `find_pois()`:
- Split the current single loop into (a) a synchronous validation +
  query-building pass over `requested` (unchanged 400-on-bad-`poi_type`
  semantics, still happens before any network calls), and (b) a concurrent
  fetch phase:
  ```python
  async def _fetch_one(entry, query):
      try:
          return entry, await asyncio.to_thread(query_overpass, query), None
      except OverpassError as exc:
          return entry, [], exc

  results = await asyncio.gather(*(_fetch_one(e, q) for e, q in prepared))
  ```
  Per-task try/except (not `gather(..., return_exceptions=True)`) keeps the
  return shape uniform and keeps one failing type from affecting the others.
  `gather` preserves input order, so downstream processing stays in
  `requested`'s order exactly as today.
- Add `import asyncio` to `main.py`.
- After gather: if **every** entry in `results` has a non-`None` error,
  raise `HTTPException(502, detail=...)` (preserves current all-fail
  behavior). Otherwise proceed, building `candidates` from the succeeding
  entries and a new `failed_poi_types` list from the failing ones.

**`rate_limit.py`**: no code change needed. It's a `Depends` evaluated once
per HTTP request to the endpoint, before the handler body runs — it already
governs "requests to `/api/find-pois`," not "Overpass calls issued," and
that relationship doesn't change when the internal calls go from sequential
to concurrent. Worth a one-line clarifying comment only.

## 2. Spatial index for the in-range check

Add a grid index over the full-resolution route in `geometry.py`, additive
alongside the existing `project_onto_polyline_m` (kept unchanged, used as
the correctness oracle in tests and for any other call sites):

- `PolylineIndex` (frozen dataclass): holds the polyline, a `cell_size_m`,
  a `dict[(cell_x, cell_y), list[int]]` mapping grid cells to segment
  indices, the local-projection reference point, and a precomputed
  cumulative-distance-to-segment-start array (so indexed lookups don't need
  to re-walk from the route start to compute `distance_from_start_m`).
- `build_polyline_index(polyline, cell_size_m=250.0)`: projects every
  vertex to local x/y via the existing `_to_local_xy` helper (reused, not
  duplicated), registers each segment in every grid cell its bounding box
  touches. `cell_size_m=250.0` is a tuning knob (roughly a quarter of the
  largest registered `max_distance_m` clamp bound, 1000m, per
  `poi_types.py`) — it only affects speed, never correctness.
- `project_onto_polyline_indexed_m(p, index)`: projects `p` into the same
  frame, checks its own grid cell, then expands outward ring by ring until
  at least one segment has been found *and* one extra ring beyond that has
  been checked (the standard grid-NN safety margin — guarantees the true
  nearest segment can't be missed), then takes the true minimum over the
  candidate set using the same per-segment projection math as the naive
  version.
- Correctness requirement: must return **bit-identical** results to
  `project_onto_polyline_m` for every input — this is what the new test
  suite (Section 4) asserts directly against real and synthetic routes.

In `main.py`:
- Build the index once per request, right after `coords` is obtained:
  `route_index = build_polyline_index(coords)` — independent of
  `simplify_rdp`'s output, which is unaffected and still computed the same
  way for the Overpass query and `route_coords` in the response.
- Replace both call sites of `project_onto_polyline_m(..., coords)` (the
  candidate check at `main.py:145` and the existing-waypoint check at
  `main.py:162`) with `project_onto_polyline_indexed_m(..., route_index)`.

## 3. Partial-result handling

- `schemas.py`: add
  ```python
  class FailedPoiType(BaseModel):
      poi_type: str
      error: str

  class FindPoisResponse(BaseModel):
      ...
      failed_poi_types: list[FailedPoiType] = []
  ```
  Default `[]` keeps this additive/backward-compatible.
- `main.py`: on partial failure (some but not all types failed), return 200
  with `candidates` built only from succeeding types and `failed_poi_types`
  populated for the rest. On total failure (every type failed), raise
  `HTTPException(502, ...)` as today — this replaces the current single
  `except OverpassError: raise HTTPException(502, ...)` block
  (`main.py:131-136`), which becomes unreachable per-type and is instead
  evaluated once after the gather completes.
- `frontend/src/types/candidate.ts`: mirror `FailedPoiType` and the new
  `FindPoisResponse.failed_poi_types` field, per this repo's existing
  manual-sync convention between `schemas.py` and `candidate.ts`.
- `frontend/src/components/CandidateChecklist.tsx`: add a
  `failedPoiTypes: FailedPoiType[]` prop; render a warning banner above the
  results when non-empty, resolving each failed type's label via
  `POI_TYPES.find((cfg) => cfg.key === ...)`, the same lookup pattern
  already used for the empty-state message (`CandidateChecklist.tsx:29-35`)
  and marker rendering (`:114`).
- `frontend/src/App.tsx`: pass `findResult.failed_poi_types` into
  `CandidateChecklist` — `findResult` already holds the full response
  (no new state needed).
- `frontend/src/lib/api.ts`: no change — `findPois()`'s return type is
  already `Promise<FindPoisResponse>`; the new field flows through once the
  type is updated.

## 4. Files to modify, in order

1. `src/waypointer/geometry.py` — add `PolylineIndex`,
   `build_polyline_index`, `project_onto_polyline_indexed_m` (additive;
   `project_onto_polyline_m` untouched).
2. `src/waypointer/schemas.py` — add `FailedPoiType`, extend
   `FindPoisResponse`.
3. `src/waypointer/main.py` — `import asyncio`; import the new geometry
   functions; restructure `find_pois()` per Sections 1–3 (validation pass →
   concurrent gather → all-fail 502 / partial-success 200 with
   `failed_poi_types` → indexed distance checks at both call sites).
4. `frontend/src/types/candidate.ts` — add `FailedPoiType`, extend
   `FindPoisResponse`.
5. `frontend/src/components/CandidateChecklist.tsx` — `failedPoiTypes` prop
   + banner.
6. `frontend/src/App.tsx` — pass `findResult.failed_poi_types` through.

`osm.py`, `rate_limit.py`, and `poi_types.py` need no functional changes.

## 5. Tests

- `tests/test_geometry.py` (new): assert
  `project_onto_polyline_indexed_m` matches `project_onto_polyline_m`
  exactly (`pytest.approx` on both distance and `distance_from_start_m`)
  across a synthetic multi-hundred-point route with corners, at many query
  points — near the route, far outside `cell_size_m`, on vertices, on
  shared segment endpoints, and in an empty region — plus small-route edge
  cases (1–2 point polylines, mirroring the naive function's existing
  special case).
- `tests/test_api.py` (new):
  - Concurrency: mock N ≥ 3 POI types' Overpass calls with a small
    artificial delay each (`responses.add_callback`); assert total wall
    time is close to one delay, not N delays.
  - Partial failure: one type's mocked call returns an error, others
    succeed → 200, successful candidates present, `failed_poi_types`
    contains exactly the failed type.
  - Total failure: all mocked calls error → 502 (matches current
    all-fail behavior, now reached after the gather instead of on the
    first failing call).
  - Default-path regression: existing `test_find_pois_defaults_to_default_visible_types`
    gets an explicit assertion that `failed_poi_types == []`.
  - Confirm no existing test asserts cross-type Overpass call *ordering*
    from `responses.calls` (checked: none does — the two-type test only
    asserts `len(responses.calls)`), so switching to concurrent dispatch
    doesn't require rewriting existing assertions.
- Frontend: no automated test runner currently in `frontend/` for this kind
  of change — verify manually via `npm run dev` (trigger a real or mocked
  partial-failure response and confirm the banner renders) plus
  `npm run build` for type-check correctness of the new fields.

## Verification

1. `uv run pytest` — full backend suite, including new geometry/API tests.
2. Manually time `/api/find-pois` before/after on a long real GPX route
   with several POI types enabled (e.g. the default 6) to confirm wall
   time drops from ~N× a single call to close to 1×.
3. `cd frontend && npm run build` — type-check the new `FailedPoiType`
   field end-to-end.
4. Manual UI check via `npm run dev` + `uv run uvicorn ... --reload`:
   trigger a partial-failure response (temporarily force one Overpass call
   to fail, or use a mock) and confirm the `CandidateChecklist` banner
   renders with the right type label, while the other results still show.
