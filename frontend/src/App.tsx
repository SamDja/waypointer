import { useEffect, useMemo, useRef, useState } from "react"
import { CandidateChecklist } from "@/components/CandidateChecklist"
import { FeedbackWidget } from "@/components/FeedbackWidget"
import { FindPoisCard } from "@/components/FindPoisCard"
import { ImportCard } from "@/components/ImportCard"
import { RouteMap } from "@/components/RouteMap"
import { SaveCard } from "@/components/SaveCard"
import { StepCard } from "@/components/StepCard"
import { Toaster } from "@/components/Toaster"
import { WahooProfileMenu } from "@/components/WahooProfileMenu"
import { OffRouteDialog, type OffRouteItem } from "@/components/OffRouteDialog"
import { ApiError, findPois, routeLeg } from "@/lib/api"
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
// Overpass call, short enough that the checklist catches up while the
// visitor is still looking at the stretch they just added.
const RE_SEARCH_DEBOUNCE_MS = 1500

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [previewRouteCoords, setPreviewRouteCoords] = useState<[number, number][]>([])
  const [previewElevations, setPreviewElevations] = useState<(number | null)[]>([])
  const [previewExistingWaypoints, setPreviewExistingWaypoints] = useState<ExistingWaypoint[]>([])
  const [findResult, setFindResult] = useState<FindPoisResponse | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [searchedPoiTypes, setSearchedPoiTypes] = useState<PoiSearchConfig[]>([])
  const [keptWaypointIndices, setKeptWaypointIndices] = useState<Set<number>>(new Set())
  const [hoveredPoi, setHoveredPoi] = useState<HoveredPoi>(null)
  // Visitor-chosen overrides of a pre-existing waypoint's suggested POI
  // type (see ImportCard's "Waypoints" tab), keyed by ExistingWaypoint.index
  // - applied on top of whatever existingWaypoints currently is (preview or
  // backend-authoritative) so the choice survives a later /api/find-pois
  // call, which recomputes its own suggestion from scratch.
  const [waypointTypeOverrides, setWaypointTypeOverrides] = useState<Record<number, string>>({})
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>(() => loadSettings())
  const [poiSearchEntries, setPoiSearchEntries] = useState<PoiSearchEntry[]>(() => loadPoiSearchConfig())
  const [isFinding, setIsFinding] = useState(false)
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

  async function handleFileChange(newFile: File) {
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
    setPreviewRouteCoords(parseRouteCoordsFromGpx(text))
    setPreviewElevations(parseRouteElevationsFromGpx(text))
    const waypoints = parseExistingWaypointsFromGpx(text)
    setPreviewExistingWaypoints(waypoints)
    // Default to keeping every pre-existing waypoint, matching the
    // post-search default in handleFind below.
    setKeptWaypointIndices(new Set(waypoints.map((w) => w.index)))
    setWaypointTypeOverrides({})
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
    // the route only shrinks - so it deliberately fires no Overpass call.
    if (unchangedPrefixLength !== null) scheduleReSearch(unchangedPrefixLength)
  }

  /**
   * Re-runs the POI search over just the stretch an edit added, once edits
   * settle. The response still carries whole-route distances (search_range
   * narrows only the Overpass query), so merging is the same
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
   * visitor hasn't searched yet shouldn't silently start querying Overpass.
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

  function handleHoverWaypoint(index: number | null) {
    setHoveredPoi(index === null ? null : { kind: "waypoint", id: index })
  }

  function handleFind() {
    return runFind(file, undefined)
  }

  async function runFind(targetFile: File | null, searchRange: SearchRange | undefined) {
    if (!targetFile) return

    const poiConfig = poiSearchEntries
      .filter((entry) => entry.enabled)
      .map((entry) => ({ poi_type: entry.poiType, max_distance_m: entry.maxDistanceM }))
    if (poiConfig.length === 0) return

    const previousCandidateIds = new Set(findResult?.candidates.map((c) => c.osm_id) ?? [])
    // Waypoints parsed from the uploaded file are already toggleable before
    // the first search ever runs (ImportCard's "Waypoints" tab), so their
    // indices count as "previously seen" even when findResult is still null.
    const previousWaypointIndices = new Set([
      ...(findResult?.existing_waypoints.map((w) => w.index) ?? []),
      ...previewExistingWaypoints.map((w) => w.index),
    ])

    setIsFinding(true)
    const toastId = toast("Searching OpenStreetMap for nearby POIs...", "loading")
    try {
      const response = await findPois(targetFile, poiConfig, searchRange)
      // A ranged search only looked at part of the route, so its candidate
      // list covers only that stretch - union it with what earlier searches
      // found instead of replacing them. Everything else in the response
      // (route_coords, existing_waypoints, and every distance) was computed
      // against the full route, so those are authoritative either way.
      const result = searchRange
        ? {
            ...response,
            candidates: [
              ...(findResult?.candidates ?? []).filter(
                (existing) => !response.candidates.some((c) => c.osm_id === existing.osm_id),
              ),
              ...response.candidates,
            ].sort((a, b) => a.distance_m - b.distance_m),
          }
        : response
      setFindResult(result)
      // Preserve the visitor's selection for candidates seen in a prior
      // search; default new ones to selected, matching first-search behavior.
      setSelectedIds(
        new Set(
          result.candidates
            .map((c) => c.osm_id)
            .filter((id) => (previousCandidateIds.has(id) ? selectedIds.has(id) : true)),
        ),
      )
      setSearchedPoiTypes(poiConfig)
      // Preserve the visitor's keep/discard choice for waypoints seen in a
      // prior search; default new ones to kept, matching first-search behavior.
      setKeptWaypointIndices(
        new Set(
          result.existing_waypoints
            .map((w) => w.index)
            .filter((idx) => (previousWaypointIndices.has(idx) ? keptWaypointIndices.has(idx) : true)),
        ),
      )
      updateToast(
        toastId,
        searchRange
          ? `Added ${response.candidates.length} candidate(s) along the new stretch.`
          : `Found ${result.candidates.length} candidate(s).`,
        "success",
      )
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Network error while contacting the server."
      updateToast(toastId, message, "error")
    } finally {
      setIsFinding(false)
    }
  }

  // No authoritative point count/distance exists client-side until
  // /api/find-pois responds - previewRouteCoords (client-parsed GPX) is a
  // rough stand-in until findResult.point_count is available.
  const pointCount = findResult?.point_count ?? (previewRouteCoords.length || null)
  // Unlike pointCount, distance/elevation have no backend-authoritative
  // source at all (FindPoisResponse never carries them) - always computed
  // client-side from the same preview data.
  const distanceM = totalDistanceM(previewRouteCoords)
  const { gainM: elevationGainM, lossM: elevationLossM } = elevationGainLossM(previewElevations)
  // Same preview-then-authoritative pattern as routeCoords: client-parsed
  // until /api/find-pois responds, then the backend's own parse wins - with
  // any visitor override from ImportCard's "Waypoints" tab applied on top,
  // since a fresh find-pois response would otherwise silently discard it.
  const existingWaypoints = useMemo(
    () =>
      (findResult?.existing_waypoints ?? previewExistingWaypoints).map((w) => ({
        ...w,
        poi_type: waypointTypeOverrides[w.index] ?? w.poi_type,
      })),
    [findResult, previewExistingWaypoints, waypointTypeOverrides]
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
          <h1 className="text-lg font-semibold">Waypointer</h1>
        </div>
        <WahooProfileMenu wahooTokens={wahooTokens} onWahooTokensChange={setWahooTokens} />
      </header>

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="h-[50vh] shrink-0 md:h-auto md:flex-1">
          <RouteMap
            routeCoords={findResult?.route_coords ?? previewRouteCoords}
            candidates={findResult?.candidates ?? EMPTY_CANDIDATES}
            selectedIds={selectedIds}
            onToggle={handleToggle}
            existingWaypoints={existingWaypoints}
            keptWaypointIndices={keptWaypointIndices}
            onToggleExistingWaypoint={handleToggleExistingWaypoint}
            onChangeWaypointType={handleAssignWaypointType}
            hoveredPoi={hoveredPoi}
            mapStyleKey={mapStyleKey}
            onMapStyleChange={handleMapStyleChange}
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
                    disabled={!file || !poiSearchEntries.some((entry) => entry.enabled)}
                    isFinding={isFinding}
                  />
                  <CandidateChecklist
                    candidates={findResult?.candidates ?? EMPTY_CANDIDATES}
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
                candidates={findResult?.candidates ?? EMPTY_CANDIDATES}
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
