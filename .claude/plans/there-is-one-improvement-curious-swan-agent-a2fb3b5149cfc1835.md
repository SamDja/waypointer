# Plan: fix /api/find-pois timeouts (concurrency + spatial index + partial results)

## 1. Concurrent Overpass calls

**Decision: `asyncio.to_thread` wrapping the existing sync `query_overpass`, not `httpx.AsyncClient`.**

Why:
- `httpx` is currently a **dev-only** dependency (`pyproject.toml` `[dependency-groups].dev`), pulled in only for FastAPI's `TestClient`. Switching `osm.py` to `httpx.AsyncClient` would need to promote it to a runtime dependency and rewrite `query_overpass`'s HTTP call, error handling (`httpx.HTTPError` vs `requests.RequestException`), and — critically — **all of `tests/test_osm.py` and the Overpass-mocking parts of `tests/test_api.py`**, which use the `responses` library (`responses.activate`, `responses.add(responses.POST, ...)`). `responses` patches `requests`/`urllib3` at the socket layer; it does **not** intercept `httpx`. Moving to `httpx` means also adding `respx` (or similar) and rewriting every Overpass-mocking test. That's a large, high-risk diff for no behavioral gain here.
- `asyncio.to_thread` keeps `osm.py`'s `query_overpass` function, its signature, its `requests.Session`/`requests` usage, and its 30s HTTP timeout completely untouched. It only changes *how main.py calls it*. All existing `test_osm.py` tests keep working unmodified (`responses` still mocks the sync `requests` calls, which now just happen to run on worker threads via `run_in_executor`'s default `ThreadPoolExecutor` — `responses`' patching is process-global via `unittest.mock`/monkeypatching of `requests.adapters`, not thread-local, so it works across threads transparently — this can be verified in the new concurrency test in Section 5).
- Effect on the event loop: today the sync `requests.post` call blocks the event loop directly since it runs inline inside `async def find_pois`. `asyncio.to_thread` (Python 3.9+, thin wrapper over `loop.run_in_executor(None, func)`) moves the blocking call to the default executor's thread pool, freeing the event loop for other concurrent requests/visitors — this addresses the "blocks the event loop for other concurrent visitors" complaint even independent of the N-calls-in-parallel win.
- Downside acknowledged: `asyncio.to_thread` uses the default `ThreadPoolExecutor`, whose default size is `min(32, os.cpu_count() + 4)` — plenty of headroom for the ≤33 POI types today, and shared safely with any other sync work FastAPI offloads (route handlers marked `def` rather than `async def`, of which this app currently has one: `wahoo_import_route`). No dedicated executor needed at this scale; note this as a place to revisit only if POI type count grows dramatically.

**Concrete changes:**

- `osm.py`: no changes needed to `query_overpass` itself. Optionally (not required) add a doc-comment noting it's now invoked from worker threads via `asyncio.to_thread`.
- `main.py`, inside `find_pois`:
  - Replace the `for entry in requested:` loop's Overpass-calling portion with:
    1. A synchronous pre-pass over `requested` that resolves `cfg`, validates `poi_type`/`tag_filter`, computes `radius_m` and `overpass_radius_m`, and builds each `query` string via `build_overpass_query` — this is all pure/cheap and must stay eagerly validated so `HTTPException`s for bad `poi_type` still surface before any network calls fire (keeps current 400-vs-502 semantics: bad input never has an Overpass call issued for it, matching `test_find_pois_rejects_unknown_poi_type`).
    2. Fire the actual Overpass calls concurrently:
       ```python
       async def _fetch_one(entry, query):
           try:
               nodes = await asyncio.to_thread(query_overpass, query)
               return entry, nodes, None
           except OverpassError as exc:
               return entry, [], exc
       results = await asyncio.gather(*(_fetch_one(e, q) for e, q in prepared))
       ```
       Using per-task try/except (not `asyncio.gather(..., return_exceptions=True)`) so the return type stays uniform (`(entry, nodes, error)` tuples) rather than having to `isinstance`-check `BaseException` results afterward — simpler to reason about and keeps `OverpassError` handling colocated with the call site, matching the existing single-call try/except style.
    3. Iterate `results` in the same order as `requested` (gather preserves input order) to build `candidates` exactly as today, but now: on `error is not None`, skip that type's candidates and record it in a new "failed types" list instead of raising `HTTPException(502, ...)` for the whole request (see Section 3).
  - `import asyncio` needs adding to `main.py`'s imports.

**rate_limit.py interaction — no semantic change.** `rate_limit` is a FastAPI `Depends` on the endpoint itself, evaluated **once per HTTP request to `/api/find-pois`**, before the handler body (and thus before any Overpass calls, sequential or concurrent) runs. It counts *visitor requests to the endpoint*, not *Overpass calls* — that's already true today even with 6+ sequential Overpass calls per request. Parallelizing the internal Overpass calls doesn't touch `_requests_by_ip` accounting at all; `REQUESTS_PER_WINDOW = 10` per IP per 60s continues to mean "10 `/api/find-pois` calls", each of which may issue up to ~33 Overpass calls internally (now concurrently instead of serially) — this was already true, just slower before. Worth a one-line comment in `rate_limit.py` or `main.py` noting explicitly that this dependency doesn't govern Overpass-call fan-out, since a future reader parallelizing further might assume otherwise. No code change required, just a clarifying comment.

## 2. Spatial index over the full-resolution route

**Decision: a new function in `geometry.py`, a *grid index* built once per request over `coords` (the full-resolution route), used to bound `project_onto_polyline_m`'s segment scan to only nearby segments.**

Rationale for a uniform grid over alternatives (k-d tree, R-tree/STRtree from a GIS lib): the route is a *polyline* (ordered, connected segments), not scattered points — a uniform grid keyed by rounded lat/lon cell is trivial to build in pure stdlib (no new dependency, matches `geometry.py`'s existing "pure-stdlib" convention per CLAUDE.md), O(segments) to build, and each segment only needs to be registered in the handful of grid cells its bounding box touches. A k-d tree indexes points, not segments, and would need adaptation; not worth the complexity here given the query pattern (find segments near one candidate point, repeated for up to hundreds of candidates).

**Design:**
- New dataclass/function in `geometry.py`:
  ```python
  @dataclass(frozen=True)
  class PolylineIndex:
      polyline: list[LatLon]
      cell_size_m: float
      _cells: dict[tuple[int, int], list[int]]  # (cell_x, cell_y) -> segment indices
      _ref_lat: float
  ```
  - `build_polyline_index(polyline: list[LatLon], cell_size_m: float = 200.0) -> PolylineIndex`: computes one reference latitude for the whole route (e.g. mean of first/last point, or just `polyline[0][0]` — consistent with `_to_local_xy`'s existing per-call `ref_lat` pattern, but a single fixed ref_lat for the whole index is fine at route scale and avoids reprojecting per segment), projects every polyline vertex to local x/y via the existing `_to_local_xy` helper (reused, not duplicated), and for each segment `i` computes its bounding box in cell coordinates (`floor(min_x/cell_size_m)` .. `floor(max_x/cell_size_m)`, same for y) and appends `i` to every cell in that box's range — segments near cell boundaries get registered in multiple cells, which is correct (avoids missing a segment whose nearest point to a query is technically in an adjacent cell).
  - `project_onto_polyline_indexed_m(p: LatLon, index: PolylineIndex) -> tuple[float, float]`: projects `p` to the same local x/y frame, finds its cell, and does a **ring search**: check the candidate's own cell first; if no segments found there (empty route region — shouldn't happen for cell_size >= route point spacing, but handle gracefully), expand to the 3x3 neighborhood, then 5x5, etc., until at least one segment is found *and* one full additional ring beyond that has been checked (standard grid-NN safety margin: the nearest segment by cell-Chebyshev-distance could still be farther in true distance than a segment in a not-yet-checked ring, so after finding first hit(s), expand one more ring and take the true minimum over the whole checked set) — then runs the existing `_point_to_segment_projection` only over that reduced candidate segment index set, taking the minimum exactly as `project_onto_polyline_m`'s loop does, and reconstructing `distance_from_start_m` via a **precomputed cumulative-distance-to-segment-start array** stored on `PolylineIndex` (`_cumulative_m: list[float]`, length = len(polyline), built once in `build_polyline_index` via the same `haversine_m` calls the naive version does inline) so the indexed path doesn't need to re-walk from the start to compute `distance_from_start_m`.
  - Correctness contract preserved exactly: this must return **bit-identical** results to `project_onto_polyline_m(p, coords)` for every input, since CLAUDE.md's geometry.py section states the authoritative check always runs against the full-resolution route at the exact per-type radius — the ring-expansion-until-safe-margin logic is what guarantees this (not an approximate/"good enough" nearest-neighbor). Cheapest way to guarantee it: keep `project_onto_polyline_m` **unchanged and still present** (used directly wherever the route is short enough that a naive scan is already cheap, and reused as the correctness oracle in tests), and add the indexed path as a new, additive function alongside it, not a replacement — `main.py` chooses which to call based on route size (see below), and the new test suite asserts the two agree point-for-point on real fixture routes and synthetic routes.
- `main.py` changes:
  - Build the index **once per request**, right after `coords` is obtained (before the `simplify_rdp` call, since simplification and the index are independent, both derived from `coords`): `route_index = build_polyline_index(coords)`.
  - Replace both call sites of `project_onto_polyline_m((node.lat, node.lon), coords)` (candidate check, line ~145) and `project_onto_polyline_m((w.latitude, w.longitude), coords)` (existing waypoints, line ~162) with `project_onto_polyline_indexed_m((node.lat, node.lon), route_index)` / same for waypoints.
  - `cell_size_m` choice: default to something on the order of the largest realistic `max_distance_m` clamp bound (check `poi_types.py`'s `clamp_distance_m`/registry bounds for the actual max) so that a candidate's true nearest segment is very likely within the first or second ring — this is a performance tuning knob only, not a correctness one (correctness is guaranteed by the ring-expansion algorithm regardless of cell size, just slower/faster depending on how well-tuned it is). Should read the registry's max `max_distance_m` across `POI_TYPES` in `build_polyline_index`'s caller or hardcode e.g. 500.0 with a comment — worth checking `poi_types.py`'s bounds first (need to read that file's full ~364 lines to pick a concrete number; deferred to implementation but flagged here).
- Interaction with `simplify_rdp`: **none** — the index is built from `coords` (full-resolution), `simplify_rdp(coords, ...)` still separately produces `simplified` for the Overpass query and for `route_coords` in the response; the two are independent downstream consumers of the same `coords` input, exactly as today. No change to `simplify_rdp` itself.

## 3. Partial-result handling

**Concurrency-side:** per Section 1, `_fetch_one` catches `OverpassError` per-task and returns it in the tuple rather than letting `asyncio.gather` raise/propagate — so one failing/timing-out type never cancels or fails the sibling tasks (they're already independently `await`ed inside `asyncio.gather`, which by default doesn't cancel other tasks when one raises **unless** you don't catch inside the coroutine — catching internally as planned sidesteps this entirely and needs no `return_exceptions=True`).

**Schema changes (`schemas.py`):**
- Add to `FindPoisResponse`:
  ```python
  class FailedPoiType(BaseModel):
      poi_type: str
      error: str  # human-readable, safe to show ("Failed to query OpenStreetMap: ...")

  class FindPoisResponse(BaseModel):
      candidates: list[Candidate]
      point_count: int
      existing_waypoints: list[ExistingWaypoint]
      route_coords: list[tuple[float, float]]
      failed_poi_types: list[FailedPoiType] = []
  ```
  Default `[]` keeps this additive/backward-compatible (matches the existing convention of defaulted optional fields elsewhere, e.g. `ExistingWaypoint.poi_type` default). Endpoint now returns 200 with partial `candidates` + populated `failed_poi_types` instead of raising `HTTPException(502, ...)` for a single type's failure — full-request 502 is no longer reachable from a per-type Overpass failure (keep it reachable only for something that would fail *before* per-type dispatch, e.g. none currently, so the existing `except OverpassError: raise HTTPException(502, ...)` block at main.py:131-136 is removed/replaced entirely by the gather-based per-type handling).
  - Need to decide: should the whole request still 502 if *all* requested types fail? Recommend **no** — keep returning 200 with empty `candidates` and every type in `failed_poi_types`, letting the frontend surface it; this is simpler (one response shape, no special-casing "all failed" vs "some failed") and matches "partial results are acceptable" as stated by the user's decision. Flag this as worth a quick confirm-or-default in the plan doc, but proceeding with "always 200, never fail the whole request for Overpass issues" as the default.

**Frontend mirroring (per CLAUDE.md's manual-sync convention):**
- `frontend/src/types/candidate.ts`: add
  ```ts
  export interface FailedPoiType {
    poi_type: string
    error: string
  }
  export interface FindPoisResponse {
    candidates: Candidate[]
    point_count: number
    existing_waypoints: ExistingWaypoint[]
    route_coords: [number, number][]
    failed_poi_types: FailedPoiType[]
  }
  ```
- `frontend/src/App.tsx`: `findResult` already holds the full `FindPoisResponse` (state at line 44) — no new state needed, just read `findResult.failed_poi_types` where results are rendered. Need to pass it down (likely alongside `searchedPoiTypes` prop drilling into wherever results render — `CandidateChecklist` per the props check, or a new small banner component in `App.tsx` itself above `CandidateChecklist`).
- `frontend/src/components/CandidateChecklist.tsx`: this component currently only takes `candidates` + `searchedPoiTypes` — it doesn't see failures. Two options: (a) add a `failedPoiTypes: FailedPoiType[]` prop and render a warning banner above the results (e.g. "Bench search failed: <error>. Other results below are unaffected.") reusing `POI_TYPES.find(...)` to resolve the label, same pattern as the existing empty-state string-building at line 33-35; (b) render the banner in `App.tsx` directly, outside `CandidateChecklist`, since `App.tsx` already has direct access to `findResult`. Recommend (a) — keeps all "how do we describe search results" text logic in one component (`CandidateChecklist` already owns the empty-state message), consistent with its existing role, and mirrors how it already reads `searchedPoiTypes` for messaging. `App.tsx` just needs to pass `findResult.failed_poi_types` through as a new prop.
- `frontend/src/lib/api.ts`: `findPois()`'s return type is already `Promise<FindPoisResponse>` — no signature change, the new field just flows through once `FindPoisResponse` is updated in `candidate.ts`.

## 4. Files to modify, in order

1. `src/waypointer/geometry.py` — add `build_polyline_index`, `PolylineIndex`, `project_onto_polyline_indexed_m` (additive; `project_onto_polyline_m` untouched, kept as-is for correctness-oracle use in tests and for any small-route call sites that don't need indexing).
2. `src/waypointer/schemas.py` — add `FailedPoiType`, extend `FindPoisResponse` with `failed_poi_types: list[FailedPoiType] = []`.
3. `src/waypointer/main.py`:
   - `import asyncio` added to imports.
   - `from waypointer.geometry import ... build_polyline_index, project_onto_polyline_indexed_m` added (keep `project_onto_polyline_m` import too, if still used anywhere, or drop if fully superseded within `find_pois` — check `/api/save`/`/api/wahoo/route-payload` don't call it too... they don't, per the earlier read, only `find_pois` calls it).
   - `find_pois()`: build `route_index` once; restructure the `for entry in requested:` loop into (a) a validation+query-building pass, (b) a concurrent `asyncio.gather` of `_fetch_one`, (c) a results-processing pass that uses `project_onto_polyline_indexed_m` at both call sites and accumulates `failed_poi_types` for entries whose fetch errored; return `FindPoisResponse(..., failed_poi_types=failed_poi_types)`.
4. `src/waypointer/osm.py` — no functional change; optional comment only.
5. `frontend/src/types/candidate.ts` — add `FailedPoiType`, extend `FindPoisResponse`.
6. `frontend/src/components/CandidateChecklist.tsx` — new `failedPoiTypes` prop + banner rendering.
7. `frontend/src/App.tsx` — pass `findResult.failed_poi_types` into `CandidateChecklist`.

(`rate_limit.py` and `poi_types.py` need no code changes — `rate_limit.py` optionally gets a clarifying comment per Section 1.)

## 5. Test plan

**Existing relevant tests (must keep passing unmodified or with minimal, intentional updates):**
- `tests/test_osm.py` — `build_overpass_query`/`query_overpass` unit tests via `responses`; unaffected by `asyncio.to_thread` since `query_overpass` itself is untouched. No changes needed.
- `tests/test_geometry.py` — `project_onto_polyline_m`, `simplify_rdp`, etc.; untouched, still exercises the naive path directly.
- `tests/test_api.py` — exercises `/api/find-pois` end-to-end via `TestClient` + `responses` mocking Overpass POSTs:
  - `test_find_pois_defaults_to_default_visible_types`, `test_find_pois_clamps_out_of_range_distance`, `test_find_pois_small_radius_still_finds_close_node`, `test_find_pois_handles_multiple_poi_types` — these register one or more `responses.add(responses.POST, OVERPASS_URL, ...)` and assert on `responses.calls` order/content; need verification that `responses` intercepts calls made from `asyncio.to_thread`-spawned worker threads in the same process — it should (mock patches the `requests` module process-wide), but this is exactly the kind of assumption that needs a dedicated smoke test rather than just trusting it (see below). `test_find_pois_handles_multiple_poi_types` in particular asserts `len(responses.calls) == 2` and per-call ordering-sensitive things may need re-checking since `responses.calls` records calls in the order the mock intercepted them, which — once concurrent — depends on `ThreadPoolExecutor` scheduling, not guaranteed to match `requested`'s order. Check whether any assertion relies on `responses.calls[0]` specifically corresponding to `requested[0]` (`test_find_pois_clamps_out_of_range_distance` and `test_find_pois_small_radius_still_finds_close_node` both do `responses.calls[0].request.body` — these only have **one** requested type each, so call-order is moot there; `test_find_pois_handles_multiple_poi_types` has two, but doesn't index into `responses.calls[N]` for content assertions, only checks length — safe). No test currently assumes cross-type Overpass call ordering beyond what's noted, so no rewrites expected, but flag this file for a careful pass during implementation.

**New tests needed:**

*Concurrency (`tests/test_api.py`, new tests):*
- `test_find_pois_calls_are_concurrent_not_sequential`: register a `responses` callback (via `responses.add_callback`) that `time.sleep`s briefly per call (e.g. 0.1s) for N ≥ 3 requested POI types, assert total wall-clock time is closer to 1×sleep than N×sleep (e.g. `< 0.1 * N * 0.5` with generous margin) — proves calls run concurrently. Needs `monkeypatch` to inject N fake POI types into `POI_TYPES` similar to the existing `test_find_pois_handles_multiple_poi_types` pattern.
- `test_find_pois_one_type_failure_does_not_block_others`: mock one POI type's Overpass call to return a 500 (`responses.add(..., status=500)`), others to succeed; assert response is still 200, successful types' candidates are present, and `failed_poi_types` contains exactly the failed type with a non-empty `error` string.
- `test_find_pois_all_types_fail_returns_200_with_all_failed`: all mocked Overpass calls return errors; assert 200, `candidates == []`, `failed_poi_types` covers every requested type. (Confirms the "no whole-request 502 from Overpass" decision from Section 3 — flag to the user this test encodes a design decision that could go the other way if they'd rather keep an all-failed 502.)
- `test_find_pois_default_response_omits_failed_types_field_is_empty_list`: existing default-path test (`test_find_pois_defaults_to_default_visible_types`) should implicitly get `failed_poi_types == []`; add an explicit assertion there rather than a wholly new test.

*Spatial index correctness (`tests/test_geometry.py`, new tests):*
- `test_polyline_index_matches_naive_projection_on_fixture_route`: build both a naive and indexed result for every point in a realistic-length synthetic route (e.g. a few hundred points, both straight and with corners) at many random query points (fixed seed for determinism) scattered near and far from the route (including points *outside* any grid cell radius, exactly on vertices, exactly on segment endpoints/shared vertices, and off in an empty area) — assert `project_onto_polyline_m(p, coords) == project_onto_polyline_indexed_m(p, index)` (both distance and distance_from_start, `pytest.approx`) for every case. This is the load-bearing correctness test given CLAUDE.md's explicit correctness contract.
- `test_polyline_index_handles_query_far_outside_cell_size`: a query point much farther than one `cell_size_m` from the whole route — verifies the ring-expansion loop actually expands enough rings rather than assuming the nearest segment is always local (candidates near `min_distance_m`/type search radius that are geographically far from the route wouldn't normally reach this code path since they'd fail the radius check anyway, but the index function itself must still return a *correct*, not just "good enough," answer for defensive correctness — also guards a case like a route with a big gap/teleport in GPX track points).
- `test_polyline_index_single_point_route` / route length 1 or 2 edge cases — mirrors existing `project_onto_polyline_m`'s `len(polyline) == 1` special case; confirm the indexed path handles these without crashing (may special-case delegate to the naive path directly under some small-N threshold, in which case this test also documents that threshold behavior).
- Property-based option (if `hypothesis` isn't already a dependency, skip — check `pyproject.toml`'s dev deps first; it isn't listed, so stick with fixed but comprehensive manual random-seeded cases rather than adding a new test dependency).

*Partial-failure + schema shape:*
- Covered above in the `test_api.py` list; also add a lightweight `schemas.py`-level test (or fold into `test_api.py`) asserting `FindPoisResponse(candidates=[], point_count=0, existing_waypoints=[], route_coords=[]).failed_poi_types == []` (default works without explicit arg) — cheap regression guard for the Pydantic default.

*Frontend (manual/lower priority per repo conventions — no visible existing frontend test runner was found in this exploration; confirm during implementation whether `frontend/` has any Vitest/RTL setup before deciding whether to add automated frontend tests, or whether this is verified via `npm run build`/manual QA only, matching how the rest of the frontend appears to be tested today).*

## Open questions / decisions flagged for the user during implementation
1. Confirm "all requested types fail → still 200, not 502" (Section 3) is the desired behavior, not a special-cased full failure.
2. `cell_size_m` default for `build_polyline_index` — needs the actual max `max_distance_m` bound from `poi_types.py`'s registry to pick a sensible default; will read that file fully during implementation rather than guessing here.
3. Whether `CandidateChecklist` (banner) or a new small component is preferred for surfacing `failed_poi_types` in the UI — recommended `CandidateChecklist` per Section 3, open to alternative placement (e.g. a toast/alert in `App.tsx`) if preferred.

## Critical Files for Implementation
- src/waypointer/main.py
- src/waypointer/geometry.py
- src/waypointer/schemas.py
- frontend/src/types/candidate.ts
- frontend/src/components/CandidateChecklist.tsx
- tests/test_api.py
- tests/test_geometry.py
