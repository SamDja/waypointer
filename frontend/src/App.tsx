import { useEffect, useMemo, useRef, useState } from "react"
import { CandidateChecklist } from "@/components/CandidateChecklist"
import { FeedbackWidget } from "@/components/FeedbackWidget"
import { FindPoisCard } from "@/components/FindPoisCard"
import { ImportCard } from "@/components/ImportCard"
import { RouteMap, type PendingPoiLookup } from "@/components/RouteMap"
import { SaveCard } from "@/components/SaveCard"
import { StepCard } from "@/components/StepCard"
import { Toaster } from "@/components/Toaster"
import { WahooProfileMenu } from "@/components/WahooProfileMenu"
import { OffRouteDialog, type OffRouteItem } from "@/components/OffRouteDialog"
import { ApiError, findPois, lookupPoi, routeLeg } from "@/lib/api"
import { track } from "@/lib/analytics"
import { elevationGainLossM, projectOntoPolylineM, totalDistanceM } from "@/lib/geometry"
import {
  buildGpxFile,
  parseExistingWaypointsFromGpx,
  parseGpxDocument,
  parseRouteCoordsFromGpx,
  parseRouteElevationsFromGpx,
} from "@/lib/gpx"
import { routingProfileForStyle } from "@/lib/mapStyles"
import {
  appendAnchor,
  emptyPlannerState,
  endpointNeighbourKind,
  insertAnchorAt,
  legKey,
  moveAnchor,
  offRouteItems,
  pendingLegs,
  plannerAnchors,
  plannerGeometry,
  plannerStateFromImport,
  prependAnchor,
  trackPositions,
  trackedAfterExtend,
  trackedAfterTrim,
  trimEnd,
  trimStart,
  withLeg,
  type PlannerState,
  type TrackedPositions,
} from "@/lib/routePlanner"
import {
  loadAvgSpeedKmh,
  loadMapStyleKey,
  loadOffRouteThresholdM,
  loadPoiSearchConfig,
  loadSettings,
  saveAvgSpeedKmh,
  saveMapStyleKey,
  saveOffRouteThresholdM,
  savePoiSearchConfig,
  saveSettings,
  type DeviceSettings,
  type PoiSearchEntry,
} from "@/lib/settings"
import { toast, updateToast } from "@/lib/toast"
import { loadWahooTokens, type WahooTokens } from "@/lib/wahooSettings"
import type {
  Candidate,
  CandidateDetails,
  ExistingWaypoint,
  FailedPoiType,
  FindPoisResponse,
  HoveredPoi,
  PoiSearchConfig,
  SearchRange,
} from "@/types/candidate"

type Step = "import" | "find"

// Stable empty-array references so RouteMap's FitBounds effect (which
// depends on candidates/existingWaypoints by reference) doesn't refire on
// every unrelated App re-render (e.g. hovering a PoiListItem) just because
// `findResult?.candidates ?? []` would otherwise produce a fresh array
// literal each render.
const EMPTY_CANDIDATES: Candidate[] = []
const EMPTY_FAILED_POI_TYPES: FailedPoiType[] = []

// Long enough that placing several anchors in a row collapses into one
// re-search, short enough that the checklist catches up while the visitor is
// still looking at the stretch they just added.
const RE_SEARCH_DEBOUNCE_MS = 1500

// Staggers each per-type /api/find-pois/route request's start by this much,
// smallest search radius first, so results stream in progressively per type
// while still overlapping in flight rather than waiting for one to fully
// finish before starting the next. (Originally added to give the public
// Overpass mirror breathing room; kept after the move to PostGIS for the
// progressive per-type streaming.)
const SEARCH_STAGGER_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [previewRouteCoords, setPreviewRouteCoords] = useState<[number, number][]>([])
  const [previewElevations, setPreviewElevations] = useState<(number | null)[]>([])
  const [previewExistingWaypoints, setPreviewExistingWaypoints] = useState<ExistingWaypoint[]>([])
  const [findResult, setFindResult] = useState<FindPoisResponse | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  // POIs added by clicking a basemap icon rather than via /api/find-pois/route -
  // kept as a sibling to findResult (not merged into it) so a click works
  // even before a search has run, or before a route is loaded at all. See
  // allCandidates below, which is what everything downstream actually reads.
  const [clickAddedCandidates, setClickAddedCandidates] = useState<Candidate[]>([])
  // Tags/last-edited for click-added candidates, keyed by osm_id - not part
  // of Candidate itself (which round-trips through /api/save), consumed
  // only by RouteMap's marker popup so a reopened click-added marker still
  // shows its tags/edit link. Merged with findResult.candidate_details (see
  // candidateDetails below) into one map RouteMap actually reads from.
  const [clickAddedDetails, setClickAddedDetails] = useState<Record<number, CandidateDetails>>({})
  const [pendingLookup, setPendingLookup] = useState<PendingPoiLookup | null>(null)
  const [searchedPoiTypes, setSearchedPoiTypes] = useState<PoiSearchConfig[]>([])
  const [keptWaypointIndices, setKeptWaypointIndices] = useState<Set<number>>(new Set())
  const [hoveredPoi, setHoveredPoi] = useState<HoveredPoi>(null)
  // Visitor-chosen overrides of a pre-existing waypoint's suggested POI
  // type (see ImportCard's "Waypoints" tab), keyed by ExistingWaypoint.index
  // - applied on top of whatever existingWaypoints currently is (preview or
  // backend-authoritative) so the choice survives a later /api/find-pois/route
  // call, which recomputes its own suggestion from scratch.
  const [waypointTypeOverrides, setWaypointTypeOverrides] = useState<Record<number, string>>({})
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>(() => loadSettings())
  const [poiSearchEntries, setPoiSearchEntries] = useState<PoiSearchEntry[]>(() => loadPoiSearchConfig())
  const [isFinding, setIsFinding] = useState(false)
  // Live per-type progress for the search kicked off in handleFind - null
  // when no search is running. Drives FindPoisCard's button/row progress UI;
  // findResult itself (not this) is what the map/candidate list render from.
  const [searchProgress, setSearchProgress] = useState<{
    total: number
    doneTypes: Set<string>
    erroredTypes: Set<string>
  } | null>(null)
  const [openStep, setOpenStep] = useState<Step | null>("import")
  const [wahooTokens, setWahooTokens] = useState<WahooTokens | null>(() => loadWahooTokens())
  const [avgSpeedKmh, setAvgSpeedKmh] = useState<number>(() => loadAvgSpeedKmh())
  const [mapStyleKey, setMapStyleKey] = useState<string>(() => loadMapStyleKey())

  // -- Route planner ------------------------------------------------------
  // Non-null exactly while the planner is active. The planner is the source
  // of truth for the route's geometry while it is, and every edit
  // re-synthesizes `file` from it - which is what lets the entire downstream
  // pipeline (find-pois, save, the Wahoo push) stay untouched.
  const [plannerState, setPlannerState] = useState<PlannerState | null>(null)
  // The imported file's parsed document, kept so an edited import is
  // re-serialized from the original rather than rebuilt - preserving its
  // pre-existing <wpt> entries and their waypointer: extension markers.
  const [sourceDoc, setSourceDoc] = useState<Document | null>(null)
  const [trackedPositions, setTrackedPositions] = useState<TrackedPositions>({})
  const [offRouteThresholdM, setOffRouteThresholdM] = useState<number>(() => loadOffRouteThresholdM())
  // An edit held back pending confirmation because it stranded something.
  // Cancelling drops it and leaves the route exactly as it was.
  const [pendingEdit, setPendingEdit] = useState<{
    state: PlannerState
    tracked: TrackedPositions
    // Length of the leading coordinates the edit left untouched, or null
    // when the edit added no new ground (a trim) - see scheduleReSearch.
    unchangedPrefixLength: number | null
  } | null>(null)
  const reSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The debounced re-search fires after `file` has been replaced by an edit,
  // so it reads the current one from here rather than from a stale closure.
  const latestFileRef = useRef<File | null>(null)
  // Leg keys with a request in flight, so a re-render mid-fetch doesn't fire
  // a duplicate request for the same leg.
  const inFlightLegs = useRef<Set<string>>(new Set())
  // Captured at the moment planning starts, so re-synthesizing the route on
  // every edit doesn't rename the file or lose the imported document.
  const plannedFilenameRef = useRef<string>("route.gpx")
  const sourceDocRef = useRef<Document | null>(null)
  // The planner's current geometry, read by the debounced re-search so it
  // resolves its index range against the route as it stands when the timer
  // fires rather than as it stood when the edit was made.
  const plannerCoordsRef = useRef<[number, number][]>([])

  const routingProfile = routingProfileForStyle(mapStyleKey)

  useEffect(() => {
    latestFileRef.current = file
  }, [file])

  useEffect(() => {
    sourceDocRef.current = sourceDoc
  }, [sourceDoc])

  useEffect(() => {
    return () => {
      if (reSearchTimer.current) clearTimeout(reSearchTimer.current)
    }
  }, [])

  // A search run while planning introduces candidates the tracker has never
  // seen. Without this, an edit could only ever strand things that existed
  // when planning began - so a fountain found mid-session would survive a
  // trim that put it kilometres off the route.
  useEffect(() => {
    if (!plannerState || !findResult) return
    setTrackedPositions(
      trackPositions(
        [
          ...findResult.existing_waypoints.map((w) => ({ key: `w:${w.index}`, lat: w.lat, lon: w.lon })),
          ...findResult.candidates.map((c) => ({ key: `c:${c.osm_id}`, lat: c.lat, lon: c.lon })),
        ],
        plannerCoordsRef.current,
      ),
    )
    // Re-seeding is driven by the search result alone; plannerState is read
    // through a ref so an edit doesn't discard the incremental values this
    // exists to establish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findResult])

  // Fetches routed geometry for any leg that doesn't have it yet. Runs
  // whenever the planner state changes, which is what makes a dragged anchor
  // cost exactly the two legs it touches - every other leg is already in the
  // cache and never reaches here.
  // Deliberately has no cleanup that discards in-flight responses. This
  // effect re-runs on every edit, so cancelling would throw away a leg that
  // had already been paid for and re-request it from a shared public
  // service on the next render. A routed leg is valid whenever it arrives -
  // it's keyed on its own endpoints, so a late response either fills a leg
  // that's still wanted or lands in a state that no longer references it,
  // and the functional update below no-ops once planning has ended.
  useEffect(() => {
    if (!plannerState) return

    for (const segment of pendingLegs(plannerState)) {
      const key = legKey(segment.from, segment.to, plannerState.profile)
      if (inFlightLegs.current.has(key)) continue
      inFlightLegs.current.add(key)

      routeLeg(segment.from, segment.to, plannerState.profile)
        .then((response) => {
          setPlannerState((prev) => {
            if (!prev) return prev
            return withLeg(prev, segment.from, segment.to, {
              coords: response.coords,
              elevations: response.elevations,
              distanceM: response.distance_m,
            })
          })
        })
        .catch((err) => {
          toast(
            err instanceof ApiError ? err.message : "Couldn't plan that stretch of route.",
            "error",
          )
        })
        .finally(() => inFlightLegs.current.delete(key))
    }
  }, [plannerState])

  // The single place a planner state is written through to everything
  // downstream: the map preview, the route stats, and above all `file`,
  // which is what /api/find-pois and /api/save actually consume.
  // Synthesizing here is what keeps those endpoints unaware the planner
  // exists at all. Runs on every planner change, including routed geometry
  // arriving from the effect above.
  useEffect(() => {
    if (!plannerState) return
    const { coords, elevations } = plannerGeometry(plannerState)
    plannerCoordsRef.current = coords
    setPreviewRouteCoords(coords)
    setPreviewElevations(elevations)
    if (coords.length < 2) return
    const name = plannedFilenameRef.current
    setFile(
      buildGpxFile(
        { coords, elevations, name: name.replace(/\.gpx$/i, ""), sourceDoc: sourceDocRef.current },
        name,
      ),
    )
    // Only the planner state drives this; the filename and source document
    // are captured in refs precisely so re-synthesizing doesn't re-run when
    // `file` itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannerState])

  async function handleFileChange(newFile: File, source: "drop" | "browse" | "wahoo") {
    setFile(newFile)
    setFindResult(null)
    setSelectedIds(new Set())
    setSearchedPoiTypes([])
    // A newly imported file replaces whatever was being planned.
    setPlannerState(null)
    setTrackedPositions({})
    setPendingEdit(null)

    const text = await newFile.text()
    setSourceDoc(parseGpxDocument(text))
    const routeCoords = parseRouteCoordsFromGpx(text)
    setPreviewRouteCoords(routeCoords)
    setPreviewElevations(parseRouteElevationsFromGpx(text))
    const waypoints = parseExistingWaypointsFromGpx(text)
    setPreviewExistingWaypoints(waypoints)
    // Default to keeping every pre-existing waypoint, matching the
    // post-search default in handleFind below.
    setKeptWaypointIndices(new Set(waypoints.map((w) => w.index)))
    setWaypointTypeOverrides({})

    if (routeCoords.length === 0) {
      track("gpx_parse_failed", { reason: "empty_or_invalid" })
    } else {
      track("route_imported", {
        source,
        point_count: routeCoords.length,
        existing_waypoint_count: waypoints.length,
      })
    }
  }

  function handleRemoveRoute() {
    setFile(null)
    setPreviewRouteCoords([])
    setPreviewElevations([])
    setPreviewExistingWaypoints([])
    setFindResult(null)
    setSelectedIds(new Set())
    setSearchedPoiTypes([])
    setKeptWaypointIndices(new Set())
    setWaypointTypeOverrides({})
    setOpenStep("import")
    setPlannerState(null)
    setSourceDoc(null)
    setTrackedPositions({})
    setPendingEdit(null)
  }

  // -- Route planner ------------------------------------------------------

  /** The checked things pinned to the route - the only ones an edit can strand. */
  function checkedTrackedKeys(): string[] {
    return [
      ...existingWaypoints.filter((w) => keptWaypointIndices.has(w.index)).map((w) => `w:${w.index}`),
      ...(findResult?.candidates ?? []).filter((c) => selectedIds.has(c.osm_id)).map((c) => `c:${c.osm_id}`),
    ]
  }

  function offRouteFor(tracked: TrackedPositions, thresholdM: number): OffRouteItem[] {
    const checked = new Set(checkedTrackedKeys())
    const stranded = offRouteItems(
      Object.entries(tracked)
        .filter(([key]) => checked.has(key))
        .map(([key, position]) => ({ ...position, key })),
      thresholdM
    )
    return stranded.map((item) => {
      if (item.key.startsWith("w:")) {
        const index = Number(item.key.slice(2))
        const waypoint = existingWaypoints.find((w) => w.index === index)
        return {
          key: item.key,
          kind: "waypoint" as const,
          name: waypoint?.name ?? null,
          poiType: waypoint?.poi_type ?? "generic",
          distanceFromRouteM: item.distanceFromRouteM,
        }
      }
      const osmId = Number(item.key.slice(2))
      const candidate = findResult?.candidates.find((c) => c.osm_id === osmId)
      return {
        key: item.key,
        kind: "candidate" as const,
        name: candidate?.name ?? null,
        poiType: candidate?.poi_type ?? "generic",
        distanceFromRouteM: item.distanceFromRouteM,
      }
    })
  }

  function commitPlannerEdit(
    state: PlannerState,
    tracked: TrackedPositions,
    unchangedPrefixLength: number | null
  ) {
    setPlannerState(state)
    setTrackedPositions(tracked)
    // The file and map preview follow from the plannerState effect above.
    // Extending covers ground the POI search never saw. Trimming can't -
    // the route only shrinks - so it deliberately fires no re-search.
    if (unchangedPrefixLength !== null) scheduleReSearch(unchangedPrefixLength)
  }

  /**
   * Re-runs the POI search over just the stretch an edit added, once edits
   * settle. The responses still carry whole-route distances (search_range
   * narrows only the PostGIS query), so merging is the same
   * selection-preserving logic runFind already uses.
   *
   * The range is resolved when the timer *fires*, not when it's scheduled:
   * an appended leg starts life as a straight-line placeholder and is
   * replaced by ~100 routed points moments later, so indices captured at
   * schedule time would point at the wrong stretch by then. What is stable
   * across that swap is the untouched prefix - appending never renumbers the
   * coordinates before it.
   *
   * Only fires once a search has actually been run: extending a route the
   * visitor hasn't searched yet shouldn't silently start a POI search.
   */
  function scheduleReSearch(unchangedPrefixLength: number) {
    if (!findResult) return
    if (reSearchTimer.current) clearTimeout(reSearchTimer.current)
    reSearchTimer.current = setTimeout(() => {
      const coords = plannerCoordsRef.current
      if (coords.length < 2) return
      void runFind(latestFileRef.current, {
        start_index: Math.min(Math.max(unchangedPrefixLength - 1, 0), coords.length - 1),
        end_index: coords.length - 1,
      })
    }, RE_SEARCH_DEBOUNCE_MS)
  }

  function uncheckKeys(keys: string[]) {
    const waypointIndices = keys.filter((k) => k.startsWith("w:")).map((k) => Number(k.slice(2)))
    const osmIds = keys.filter((k) => k.startsWith("c:")).map((k) => Number(k.slice(2)))
    if (waypointIndices.length > 0) {
      setKeptWaypointIndices((prev) => {
        const next = new Set(prev)
        for (const index of waypointIndices) next.delete(index)
        return next
      })
    }
    if (osmIds.length > 0) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of osmIds) next.delete(id)
        return next
      })
    }
  }

  /**
   * Applies an edit, pausing for confirmation if it stranded anything.
   * An edit that affects nothing goes through silently.
   */
  function applyPlannerEdit(
    state: PlannerState,
    tracked: TrackedPositions,
    unchangedPrefixLength: number | null
  ) {
    if (offRouteFor(tracked, offRouteThresholdM).length > 0) {
      setPendingEdit({ state, tracked, unchangedPrefixLength })
      return
    }
    commitPlannerEdit(state, tracked, unchangedPrefixLength)
  }

  function handleConfirmPendingEdit() {
    if (!pendingEdit) return
    uncheckKeys(offRouteFor(pendingEdit.tracked, offRouteThresholdM).map((i) => i.key))
    commitPlannerEdit(pendingEdit.state, pendingEdit.tracked, pendingEdit.unchangedPrefixLength)
    setPendingEdit(null)
  }

  function handleOffRouteThresholdChange(thresholdM: number) {
    setOffRouteThresholdM(thresholdM)
    saveOffRouteThresholdM(thresholdM)
  }

  function seedTracked(route: [number, number][]): TrackedPositions {
    return trackPositions(
      [
        ...existingWaypoints.map((w) => ({ key: `w:${w.index}`, lat: w.lat, lon: w.lon })),
        ...(findResult?.candidates ?? []).map((c) => ({ key: `c:${c.osm_id}`, lat: c.lat, lon: c.lon })),
      ],
      route
    )
  }

  function handleStartPlanning() {
    const coords = findResult?.route_coords ?? previewRouteCoords
    plannedFilenameRef.current =
      file?.name ?? `Planned route ${new Date().toISOString().slice(0, 10)}.gpx`
    const state =
      coords.length > 0
        ? plannerStateFromImport(coords, previewElevations, routingProfile)
        : emptyPlannerState(routingProfile)
    setPlannerState(state)
    setTrackedPositions(seedTracked(coords))
    // Step 1 holds the planning instructions and the "Done editing" button,
    // so it has to stay open for the duration.
    setOpenStep("import")
  }

  function handleExitPlanning() {
    setPlannerState(null)
    setPendingEdit(null)
  }

  function handleAppendAnchor(point: [number, number]) {
    if (!plannerState) return
    const before = plannerGeometry(plannerState).coords
    const result = appendAnchor(plannerState, point)
    if (!result.ok) {
      toast(result.error, "error")
      return
    }
    const after = plannerGeometry(result.state).coords
    const added = after.slice(Math.max(before.length - 1, 0))
    // Appending never renumbers the coordinates before the join, so
    // `before.length` stays a valid boundary even after the straight-line
    // placeholder is replaced by routed geometry.
    applyPlannerEdit(
      result.state,
      trackedAfterExtend(trackedPositions, after, added, false),
      added.length > 1 ? before.length : null
    )
  }

  function handleMoveAnchor(anchorIndex: number, point: [number, number]) {
    if (!plannerState) return
    const result = moveAnchor(plannerState, anchorIndex, point)
    if (!result.ok) {
      toast(result.error, "error")
      // Force the marker back to its real position - the drag already moved
      // it visually, and a rejected move leaves state unchanged.
      setPlannerState({ ...plannerState })
      return
    }
    // A moved anchor can shift the route in either direction, so this is the
    // one edit that genuinely needs a full reprojection - and a re-search
    // over the whole route, since a prefix boundary can't be established.
    const after = plannerGeometry(result.state).coords
    applyPlannerEdit(result.state, seedTracked(after), 0)
  }

  /**
   * Dragging the route's start or end marker.
   *
   * What that means depends on what the endpoint is attached to, not on
   * whether the route was drawn or imported:
   *
   * - next to a routed leg, it simply moves (re-pointing that one leg);
   * - next to imported geometry it can't, because on a pristine import that
   *   single segment spans the whole route - so it extends to the new point
   *   instead, keeping the import intact, or trims when dropped back onto
   *   the route.
   */
  function handleMoveEndpoint(which: "start" | "end", point: [number, number], droppedOnRoute: boolean) {
    if (!plannerState) return
    const coords = plannerGeometry(plannerState).coords
    const anchors = plannerAnchors(plannerState)

    if (endpointNeighbourKind(plannerState, which) === "routed") {
      handleMoveAnchor(which === "start" ? 0 : anchors.length - 1, point)
      return
    }

    if (droppedOnRoute) {
      const { distanceFromStartM } = projectOntoPolylineM(point, coords)
      if (which === "start") handleTrimStart(distanceFromStartM)
      else handleTrimEnd(distanceFromStartM)
      return
    }

    const result = which === "start" ? prependAnchor(plannerState, point) : appendAnchor(plannerState, point)
    if (!result.ok) {
      toast(result.error, "error")
      setPlannerState({ ...plannerState })
      return
    }
    const after = plannerGeometry(result.state).coords
    // Prepending shifts every distance-from-start, so that direction needs a
    // full reprojection; appending keeps the whole existing route as a stable
    // prefix.
    if (which === "start") {
      applyPlannerEdit(result.state, seedTracked(after), 0)
    } else {
      const added = after.slice(Math.max(coords.length - 1, 0))
      applyPlannerEdit(
        result.state,
        trackedAfterExtend(trackedPositions, after, added, false),
        coords.length,
      )
    }
  }

  /**
   * Dragging the route line itself inserts a point.
   *
   * Splitting at the *grab* distance and only then moving the new point to
   * where it was dropped is what bounds the re-routing to the two stretches
   * either side of it - on an imported route, the split alone is lossless
   * and everything beyond those two stretches keeps its original geometry.
   */
  function handleInsertAnchor(grabDistanceM: number, dropPoint: [number, number]) {
    if (!plannerState) return
    const inserted = insertAnchorAt(plannerState, grabDistanceM)
    if (!inserted.ok) {
      toast(inserted.error, "error")
      return
    }
    const moved = moveAnchor(inserted.state, inserted.anchorIndex, dropPoint)
    if (!moved.ok) {
      toast(moved.error, "error")
      return
    }
    const after = plannerGeometry(moved.state).coords
    applyPlannerEdit(moved.state, seedTracked(after), 0)
  }

  function handleTrimStart(distanceFromStartM: number) {
    if (!plannerState) return
    const result = trimStart(plannerState, distanceFromStartM)
    if (!result.ok) {
      toast(result.error, "error")
      return
    }
    const after = plannerGeometry(result.state).coords
    applyPlannerEdit(
      result.state,
      trackedAfterTrim(trackedPositions, after, result.survivingSegmentRange, result.startMoved),
      null
    )
  }

  function handleTrimEnd(distanceFromStartM: number) {
    if (!plannerState) return
    const result = trimEnd(plannerState, distanceFromStartM)
    if (!result.ok) {
      toast(result.error, "error")
      return
    }
    const after = plannerGeometry(result.state).coords
    applyPlannerEdit(
      result.state,
      trackedAfterTrim(trackedPositions, after, result.survivingSegmentRange, result.startMoved),
      null
    )
  }

  function handleAvgSpeedChange(speedKmh: number) {
    setAvgSpeedKmh(speedKmh)
    saveAvgSpeedKmh(speedKmh)
  }

  function handleMapStyleChange(key: string) {
    setMapStyleKey(key)
    saveMapStyleKey(key)
  }

  function handleDeviceSettingsChange(settings: DeviceSettings) {
    setDeviceSettings(settings)
    saveSettings(settings)
  }

  function handlePoiSearchChange(entries: PoiSearchEntry[]) {
    setPoiSearchEntries(entries)
    savePoiSearchConfig(entries)
  }

  function handleToggle(osmId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(osmId)) {
        next.delete(osmId)
      } else {
        next.add(osmId)
      }
      return next
    })
  }

  function handleAssignWaypointType(index: number, poiType: string) {
    setWaypointTypeOverrides((prev) => ({ ...prev, [index]: poiType }))
  }

  function handleToggleExistingWaypoint(index: number) {
    setKeptWaypointIndices((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  function handleToggleAllExistingWaypoints(checked: boolean) {
    setKeptWaypointIndices(checked ? new Set(existingWaypoints.map((w) => w.index)) : new Set())
  }

  // Only touches the given ids (the currently filtered/visible candidates
  // in CandidateChecklist) rather than every candidate, so selecting all
  // within a type filter doesn't clobber selections made under a
  // different filter.
  function handleToggleAllCandidates(checked: boolean, osmIds: number[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of osmIds) {
        if (checked) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }
      return next
    })
  }

  function handleHoverCandidate(osmId: number | null) {
    setHoveredPoi(osmId === null ? null : { kind: "candidate", id: osmId })
  }

  async function handleBasemapPoiClick(lat: number, lon: number, poiType: string) {
    setPendingLookup({ lat, lon, poiType, status: "loading" })
    try {
      const result = await lookupPoi(lat, lon, poiType)
      setPendingLookup({ lat, lon, poiType, status: "done", result })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPendingLookup({ lat, lon, poiType, status: "not_found" })
      } else {
        setPendingLookup({ lat, lon, poiType, status: "error" })
        toast(err instanceof ApiError ? err.message : "Couldn't look up that point of interest.", "error")
      }
    }
  }

  function handleConfirmPendingLookup() {
    if (pendingLookup?.status !== "done" || !pendingLookup.result) return
    const result = pendingLookup.result
    const routeCoords = findResult?.route_coords ?? previewRouteCoords
    const [distanceM, distanceFromStartM] = routeCoords.length
      ? (() => {
          const projected = projectOntoPolylineM([result.lat, result.lon], routeCoords)
          return [projected.distanceFromRouteM, projected.distanceFromStartM]
        })()
      : [0, 0]

    const candidate: Candidate = {
      osm_id: result.osm_id,
      poi_type: result.poi_type,
      name: result.name,
      lat: result.lat,
      lon: result.lon,
      distance_m: distanceM,
      distance_from_start_m: distanceFromStartM,
    }
    setClickAddedCandidates((prev) =>
      prev.some((c) => c.osm_id === result.osm_id) ? prev : [...prev, candidate],
    )
    setClickAddedDetails((prev) => ({
      ...prev,
      [result.osm_id]: { tags: result.tags, last_edited: result.last_edited },
    }))
    setSelectedIds((prev) => new Set(prev).add(result.osm_id))
    setPendingLookup(null)
  }

  function handleHoverWaypoint(index: number | null) {
    setHoveredPoi(index === null ? null : { kind: "waypoint", id: index })
  }

  function handleFind() {
    return runFind(file, undefined)
  }

  async function runFind(targetFile: File | null, searchRange: SearchRange | undefined) {
    if (!targetFile) return

    // A ranged re-search extends the results already on screen, so it
    // reuses the config those results came from rather than whatever step
    // 2's inputs currently say - otherwise the new stretch could be searched
    // at a different radius than the rest of the route.
    const poiConfig = searchRange
      ? searchedPoiTypes
      : poiSearchEntries.map((entry) => ({
          poi_type: entry.poiType,
          max_distance_m: entry.maxDistanceM,
        }))
    if (poiConfig.length === 0) return

    const previousCandidateIds = new Set(findResult?.candidates.map((c) => c.osm_id) ?? [])
    // Waypoints parsed from the uploaded file are already toggleable before
    // the first search ever runs (ImportCard's "Waypoints" tab), so their
    // indices count as "previously seen" even when findResult is still null.
    const previousWaypointIndices = new Set([
      ...(findResult?.existing_waypoints.map((w) => w.index) ?? []),
      ...previewExistingWaypoints.map((w) => w.index),
    ])

    // A type is already satisfied - no need to re-query it - if the last
    // completed search asked for the exact same radius and didn't fail for
    // it. searchedPoiTypes is overwritten wholesale at the end of every
    // search (below), so a removed type or a changed radius naturally falls
    // out of this check with no extra bookkeeping. Never true for a ranged
    // re-search: the route itself changed, so every type needs the new
    // stretch searched.
    const previousRadiusByType = new Map(searchedPoiTypes.map((s) => [s.poi_type, s.max_distance_m]))
    const previouslyFailedTypes = new Set((findResult?.failed_poi_types ?? []).map((f) => f.poi_type))
    function isAlreadySatisfied(entry: PoiSearchConfig): boolean {
      if (searchRange) return false
      return previousRadiusByType.get(entry.poi_type) === entry.max_distance_m && !previouslyFailedTypes.has(entry.poi_type)
    }
    const toSkip = poiConfig.filter(isAlreadySatisfied)
    const toFetch = poiConfig.filter((entry) => !isAlreadySatisfied(entry))

    if (toFetch.length === 0) {
      // Nothing changed since the last search (same types, same radii, none
      // previously failed) - every row already shows its checkmark, so
      // there's nothing to do.
      toast("Already up to date - no POI type changed since the last search.", "success")
      return
    }

    setIsFinding(true)
    setSearchProgress({
      total: poiConfig.length,
      doneTypes: new Set(toSkip.map((e) => e.poi_type)),
      erroredTypes: new Set(),
    })
    const toastId = toast("Searching OpenStreetMap for nearby POIs...", "loading")

    // One /api/find-pois/route call per requested type instead of one call
    // carrying every type, so the map/candidate list can fill in type-by-
    // type as each resolves instead of only once the slowest type finishes.
    // Starts are staggered (smallest search radius first - see
    // SEARCH_STAGGER_MS) rather than all fired at once. `aggregate` is a plain, non-state mutable
    // object (not React state) that each chunk appends to synchronously
    // right after its own await resolves - setFindResult(aggregate) is
    // called from there, so the map/list update live with no extra
    // plumbing on their end. Skipped types' candidates are already valid
    // (unchanged radius, no prior failure) and are carried over as-is
    // rather than re-fetched.
    //
    // A ranged re-search only looks at the stretch an edit added, so its
    // responses cover only that stretch - every existing candidate is
    // carried over and the new ones are merged in, instead of replacing
    // them. Everything else in each response (route_coords,
    // existing_waypoints, and every distance) was computed against the full
    // edited route, so those are authoritative either way.
    const carriedCandidates = searchRange
      ? (findResult?.candidates ?? [])
      : toSkip.length > 0
        ? (findResult?.candidates.filter((c) => toSkip.some((e) => e.poi_type === c.poi_type)) ?? [])
        : []
    const aggregate: FindPoisResponse = {
      candidates: carriedCandidates,
      point_count: findResult?.point_count ?? 0,
      existing_waypoints: findResult?.existing_waypoints ?? [],
      route_coords: findResult?.route_coords ?? [],
      failed_poi_types: [],
      candidate_details: Object.fromEntries(
        carriedCandidates
          .map((c) => [c.osm_id, findResult?.candidate_details[c.osm_id]] as const)
          .filter((entry): entry is [number, CandidateDetails] => entry[1] !== undefined)
      ),
    }
    let hasSucceeded = toSkip.length > 0
    let newCandidateCount = 0
    if (toSkip.length > 0) setFindResult({ ...aggregate })

    const staggeredConfig = [...toFetch].sort((a, b) => a.max_distance_m - b.max_distance_m)

    await Promise.allSettled(
      staggeredConfig.map(async (entry, index) => {
        if (index > 0) await sleep(index * SEARCH_STAGGER_MS)
        try {
          const result = await findPois(targetFile, [entry], searchRange)
          hasSucceeded = true
          // Same (osm_id, poi_type) as a carried-over candidate means a
          // ranged re-search found it again - the fresh one wins, since its
          // distances were measured against the edited route.
          const isRefreshed = (c: Candidate) =>
            c.poi_type === entry.poi_type && result.candidates.some((r) => r.osm_id === c.osm_id)
          newCandidateCount += result.candidates.filter((c) => !previousCandidateIds.has(c.osm_id)).length
          aggregate.candidates = [...aggregate.candidates.filter((c) => !isRefreshed(c)), ...result.candidates]
          if (searchRange) aggregate.candidates.sort((x, y) => x.distance_m - y.distance_m)
          aggregate.candidate_details = { ...aggregate.candidate_details, ...result.candidate_details }
          aggregate.failed_poi_types = [...aggregate.failed_poi_types, ...result.failed_poi_types]
          // point_count/existing_waypoints/route_coords are route-derived,
          // not type-derived - identical across every per-type response for
          // this same uploaded file, so whichever chunk lands is authoritative.
          aggregate.point_count = result.point_count
          aggregate.existing_waypoints = result.existing_waypoints
          aggregate.route_coords = result.route_coords
          setFindResult({ ...aggregate })

          // Preserve the visitor's selection/keep choice for candidates and
          // waypoints seen in a prior search; default newly-arrived ones to
          // selected/kept, matching first-search behavior - applied per
          // chunk now instead of once at the end.
          setSelectedIds((prevSelected) => {
            const next = new Set(prevSelected)
            for (const c of result.candidates) {
              if (!previousCandidateIds.has(c.osm_id) || prevSelected.has(c.osm_id)) next.add(c.osm_id)
            }
            return next
          })
          setKeptWaypointIndices((prevKept) => {
            const next = new Set(prevKept)
            for (const w of result.existing_waypoints) {
              if (!previousWaypointIndices.has(w.index) || prevKept.has(w.index)) next.add(w.index)
            }
            return next
          })
          setSearchProgress((prev) => prev && { ...prev, doneTypes: new Set(prev.doneTypes).add(entry.poi_type) })
        } catch (err) {
          const message = err instanceof ApiError ? err.message : "Network error while contacting the server."
          aggregate.failed_poi_types = [...aggregate.failed_poi_types, { poi_type: entry.poi_type, error: message }]
          // Only flush into findResult once we have an authoritative
          // point_count/route_coords from a successful chunk to build a
          // valid FindPoisResponse with - otherwise this surfaces once the
          // first success lands, or via the all-failed toast below if none do.
          if (hasSucceeded) setFindResult({ ...aggregate })
          setSearchProgress(
            (prev) => prev && { ...prev, erroredTypes: new Set(prev.erroredTypes).add(entry.poi_type) },
          )
        }
      }),
    )

    setSearchedPoiTypes(poiConfig)
    const allFailed = aggregate.candidates.length === 0 && !hasSucceeded
    if (allFailed) {
      updateToast(toastId, "Failed to search OpenStreetMap for any POI type.", "error")
      track("find_pois_failed", { reason: "api_error" })
    } else {
      updateToast(
        toastId,
        searchRange
          ? `Added ${newCandidateCount} candidate(s) along the new stretch.`
          : `Found ${aggregate.candidates.length} candidate(s).`,
        "success",
      )
      track("find_pois_run", {
        ranged: Boolean(searchRange),
        poi_types: poiConfig.map((e) => e.poi_type).join(","),
        max_distances_m: poiConfig.map((e) => e.max_distance_m).join(","),
        candidate_count: aggregate.candidates.length,
        failed_poi_type_count: aggregate.failed_poi_types.length,
        point_count: aggregate.point_count,
      })
    }
    setIsFinding(false)
    setSearchProgress(null)
  }

  // No authoritative point count/distance exists client-side until
  // /api/find-pois/route responds - previewRouteCoords (client-parsed GPX) is a
  // rough stand-in until findResult.point_count is available.
  const pointCount = findResult?.point_count ?? (previewRouteCoords.length || null)
  // Unlike pointCount, distance/elevation have no backend-authoritative
  // source at all (FindPoisResponse never carries them) - always computed
  // client-side from the same preview data.
  const distanceM = totalDistanceM(previewRouteCoords)
  const { gainM: elevationGainM, lossM: elevationLossM } = elevationGainLossM(previewElevations)
  // Same preview-then-authoritative pattern as routeCoords: client-parsed
  // until /api/find-pois/route responds, then the backend's own parse wins - with
  // any visitor override from ImportCard's "Waypoints" tab applied on top,
  // since a fresh find-pois/route response would otherwise silently discard it.
  const existingWaypoints = useMemo(
    () =>
      (findResult?.existing_waypoints ?? previewExistingWaypoints).map((w) => ({
        ...w,
        poi_type: waypointTypeOverrides[w.index] ?? w.poi_type,
      })),
    [findResult, previewExistingWaypoints, waypointTypeOverrides]
  )
  // Search-found candidates plus anything added by clicking a basemap POI
  // icon, deduped by osm_id (a search result wins if the same node also
  // turns up there) - this, not findResult?.candidates directly, is what
  // the map/checklist/save flow reads, so a click-added POI flows through
  // the existing selection/export pipeline unchanged.
  const allCandidates = useMemo(() => {
    if (clickAddedCandidates.length === 0) return findResult?.candidates ?? EMPTY_CANDIDATES
    const foundIds = new Set((findResult?.candidates ?? []).map((c) => c.osm_id))
    return [
      ...(findResult?.candidates ?? EMPTY_CANDIDATES),
      ...clickAddedCandidates.filter((c) => !foundIds.has(c.osm_id)),
    ]
  }, [findResult, clickAddedCandidates])
  // osm_ids added via a basemap click - used only to exclude those markers
  // from RouteMap's FitBounds input (see RouteMapProps.clickAddedCandidateIds),
  // not to decide what tag/edit info a popup shows (candidateDetails below).
  const clickAddedCandidateIds = useMemo(
    () => new Set(clickAddedCandidates.map((c) => c.osm_id)),
    [clickAddedCandidates]
  )
  // Tags/last-edited for every candidate RouteMap can show a popup for -
  // findResult.candidate_details covers search-found candidates, merged with
  // clickAddedDetails for ones added by clicking a basemap icon.
  const candidateDetails = useMemo(
    () => ({ ...(findResult?.candidate_details ?? {}), ...clickAddedDetails }),
    [findResult, clickAddedDetails]
  )

  return (
    <div className="flex h-screen flex-col">
      <Toaster />
      <FeedbackWidget />
      <OffRouteDialog
        open={pendingEdit !== null}
        items={pendingEdit ? offRouteFor(pendingEdit.tracked, offRouteThresholdM) : []}
        thresholdM={offRouteThresholdM}
        onThresholdChange={handleOffRouteThresholdChange}
        onConfirm={handleConfirmPendingEdit}
        onCancel={() => setPendingEdit(null)}
      />
      <header className="flex shrink-0 items-center justify-between gap-1.5 border-b px-4 py-2">
        <div className="flex items-center gap-1.5">
          <img src="favicon.svg" className="w-6" />
          <h1 className="text-lg font-semibold">Sulla Via</h1>
        </div>
        <WahooProfileMenu wahooTokens={wahooTokens} onWahooTokensChange={setWahooTokens} />
      </header>

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="h-[50vh] shrink-0 md:h-auto md:flex-1">
          <RouteMap
            routeCoords={findResult?.route_coords ?? previewRouteCoords}
            candidates={allCandidates}
            selectedIds={selectedIds}
            onToggle={handleToggle}
            existingWaypoints={existingWaypoints}
            keptWaypointIndices={keptWaypointIndices}
            onToggleExistingWaypoint={handleToggleExistingWaypoint}
            onChangeWaypointType={handleAssignWaypointType}
            hoveredPoi={hoveredPoi}
            mapStyleKey={mapStyleKey}
            onMapStyleChange={handleMapStyleChange}
            candidateDetails={candidateDetails}
            clickAddedCandidateIds={clickAddedCandidateIds}
            onBasemapPoiClick={handleBasemapPoiClick}
            pendingLookup={pendingLookup}
            onConfirmPendingLookup={handleConfirmPendingLookup}
            onDismissPendingLookup={() => setPendingLookup(null)}
            planning={
              plannerState
                ? {
                    anchors: plannerAnchors(plannerState),
                    pendingLegs: pendingLegs(plannerState).map((leg) => [leg.from, leg.to]),
                    onAppendAnchor: handleAppendAnchor,
                    onMoveAnchor: handleMoveAnchor,
                    onMoveEndpoint: handleMoveEndpoint,
                    onInsertAnchor: handleInsertAnchor,
                  }
                : undefined
            }
          />
        </div>

        <aside className="flex w-full min-h-0 flex-1 flex-col border-t md:w-1/3 md:min-w-[480px] md:flex-none md:border-t-0 md:border-l">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
            <StepCard
              title={"1. Import route" + (file ? " ✅": "")}
              open={openStep === "import"}
              onOpenChange={(open) => setOpenStep(open ? "import" : null)}
            >
              <ImportCard
                file={file}
                onFileChange={handleFileChange}
                onRemove={handleRemoveRoute}
                onNext={() => setOpenStep("find")}
                pointCount={pointCount}
                existingWaypoints={existingWaypoints}
                onChangeWaypointType={handleAssignWaypointType}
                keptWaypointIndices={keptWaypointIndices}
                onToggleExistingWaypoint={handleToggleExistingWaypoint}
                onToggleAllExistingWaypoints={handleToggleAllExistingWaypoints}
                onHoverWaypoint={handleHoverWaypoint}
                distanceM={distanceM}
                elevationGainM={elevationGainM}
                elevationLossM={elevationLossM}
                avgSpeedKmh={avgSpeedKmh}
                onAvgSpeedChange={handleAvgSpeedChange}
                wahooTokens={wahooTokens}
                onWahooTokensChange={setWahooTokens}
                isPlanning={plannerState !== null}
                onStartPlanning={handleStartPlanning}
                onStopPlanning={handleExitPlanning}
              />
            </StepCard>

            {file && (
              <StepCard
                title={"2. Find POIs" + (findResult ? " ✅": "")}
                open={openStep === "find"}
                onOpenChange={(open) => setOpenStep(open ? "find" : null)}
              >
                <div className="flex flex-col gap-4">
                  <FindPoisCard
                    entries={poiSearchEntries}
                    onChange={handlePoiSearchChange}
                    onFind={handleFind}
                    disabled={!file || poiSearchEntries.length === 0}
                    isFinding={isFinding}
                    progress={searchProgress}
                  />
                  <CandidateChecklist
                    candidates={allCandidates}
                    selectedIds={selectedIds}
                    onToggle={handleToggle}
                    onToggleAll={handleToggleAllCandidates}
                    searchedPoiTypes={searchedPoiTypes}
                    failedPoiTypes={findResult?.failed_poi_types ?? EMPTY_FAILED_POI_TYPES}
                    onHoverCandidate={handleHoverCandidate}
                  />
                </div>
              </StepCard>
            )}

            {file && (
              <SaveCard
                file={file}
                candidates={allCandidates}
                selectedIds={selectedIds}
                existingWaypoints={existingWaypoints}
                keptWaypointIndices={keptWaypointIndices}
                settings={deviceSettings}
                onSettingsChange={handleDeviceSettingsChange}
                wahooTokens={wahooTokens}
                onWahooTokensChange={setWahooTokens}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
