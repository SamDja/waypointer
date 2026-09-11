import { useMemo, useState } from "react"
import { CandidateChecklist } from "@/components/CandidateChecklist"
import { FeedbackWidget } from "@/components/FeedbackWidget"
import { FindPoisCard } from "@/components/FindPoisCard"
import { ImportCard } from "@/components/ImportCard"
import { RouteMap, type PendingPoiLookup } from "@/components/RouteMap"
import { SaveCard } from "@/components/SaveCard"
import { StepCard } from "@/components/StepCard"
import { Toaster } from "@/components/Toaster"
import { WahooProfileMenu } from "@/components/WahooProfileMenu"
import { ApiError, findPois, lookupPoi } from "@/lib/api"
import { track } from "@/lib/analytics"
import { elevationGainLossM, projectOntoPolylineM, totalDistanceM } from "@/lib/geometry"
import { parseExistingWaypointsFromGpx, parseRouteCoordsFromGpx, parseRouteElevationsFromGpx } from "@/lib/gpx"
import {
  loadAvgSpeedKmh,
  loadMapStyleKey,
  loadPoiSearchConfig,
  loadSettings,
  saveAvgSpeedKmh,
  saveMapStyleKey,
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
} from "@/types/candidate"

type Step = "import" | "find"

// Stable empty-array references so RouteMap's FitBounds effect (which
// depends on candidates/existingWaypoints by reference) doesn't refire on
// every unrelated App re-render (e.g. hovering a PoiListItem) just because
// `findResult?.candidates ?? []` would otherwise produce a fresh array
// literal each render.
const EMPTY_CANDIDATES: Candidate[] = []
const EMPTY_FAILED_POI_TYPES: FailedPoiType[] = []

// Firing every per-type /api/find-pois request at once seems to make the
// public Overpass mirror more likely to time out / 502 (it may throttle
// concurrent connections from our server's single shared IP) - staggering
// each request's start by this much, smallest search radius first, gives
// Overpass breathing room while still overlapping in flight rather than
// waiting for one to fully finish before starting the next.
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
  // POIs added by clicking a basemap icon rather than via /api/find-pois -
  // kept as a sibling to findResult (not merged into it) so a click works
  // even before a search has run, or before a route is loaded at all. See
  // allCandidates below, which is what everything downstream actually reads.
  const [clickAddedCandidates, setClickAddedCandidates] = useState<Candidate[]>([])
  // Raw OSM tags for click-added candidates, keyed by osm_id - not part of
  // Candidate itself (which round-trips through /api/save), consumed only
  // by RouteMap's marker popup so a reopened click-added marker still shows
  // its tags/edit link.
  const [clickAddedTags, setClickAddedTags] = useState<Record<number, Record<string, string>>>({})
  const [pendingLookup, setPendingLookup] = useState<PendingPoiLookup | null>(null)
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

  async function handleFileChange(newFile: File, source: "drop" | "browse" | "wahoo") {
    setFile(newFile)
    setFindResult(null)
    setSelectedIds(new Set())
    setSearchedPoiTypes([])

    const text = await newFile.text()
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
    setClickAddedTags((prev) => ({ ...prev, [result.osm_id]: result.tags }))
    setSelectedIds((prev) => new Set(prev).add(result.osm_id))
    setPendingLookup(null)
  }

  function handleHoverWaypoint(index: number | null) {
    setHoveredPoi(index === null ? null : { kind: "waypoint", id: index })
  }

  async function handleFind() {
    if (!file) return

    const poiConfig = poiSearchEntries.map((entry) => ({
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

    // A type is already satisfied - no need to re-hit Overpass for it - if
    // the last completed search asked for the exact same radius and didn't
    // fail for it. searchedPoiTypes is overwritten wholesale at the end of
    // every search (below), so a removed type or a changed radius naturally
    // falls out of this check with no extra bookkeeping.
    const previousRadiusByType = new Map(searchedPoiTypes.map((s) => [s.poi_type, s.max_distance_m]))
    const previouslyFailedTypes = new Set((findResult?.failed_poi_types ?? []).map((f) => f.poi_type))
    function isAlreadySatisfied(entry: PoiSearchConfig): boolean {
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

    // One /api/find-pois call per requested type instead of one call
    // carrying every type, so the map/candidate list can fill in type-by-
    // type as each resolves instead of only once the slowest type finishes.
    // Starts are staggered (smallest search radius first - see
    // SEARCH_STAGGER_MS) rather than all fired at once, since Overpass
    // seems to time out more when hit with several simultaneous connections
    // from our one server IP. `aggregate` is a plain, non-state mutable
    // object (not React state) that each chunk appends to synchronously
    // right after its own await resolves - setFindResult(aggregate) is
    // called from there, so the map/list update live with no extra
    // plumbing on their end. Skipped types' candidates are already valid
    // (unchanged radius, no prior failure) and are carried over as-is
    // rather than re-fetched.
    const aggregate: FindPoisResponse = {
      candidates: toSkip.length > 0 ? (findResult?.candidates.filter((c) => toSkip.some((e) => e.poi_type === c.poi_type)) ?? []) : [],
      point_count: findResult?.point_count ?? 0,
      existing_waypoints: findResult?.existing_waypoints ?? [],
      route_coords: findResult?.route_coords ?? [],
      failed_poi_types: [],
    }
    let hasSucceeded = toSkip.length > 0
    if (toSkip.length > 0) setFindResult({ ...aggregate })

    const staggeredConfig = [...toFetch].sort((a, b) => a.max_distance_m - b.max_distance_m)

    await Promise.allSettled(
      staggeredConfig.map(async (entry, index) => {
        if (index > 0) await sleep(index * SEARCH_STAGGER_MS)
        try {
          const result = await findPois(file, [entry])
          hasSucceeded = true
          aggregate.candidates = [...aggregate.candidates, ...result.candidates]
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
      updateToast(toastId, `Found ${aggregate.candidates.length} candidate(s).`, "success")
      track("find_pois_run", {
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

  return (
    <div className="flex h-screen flex-col">
      <Toaster />
      <FeedbackWidget />
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
            candidateTags={clickAddedTags}
            onBasemapPoiClick={handleBasemapPoiClick}
            pendingLookup={pendingLookup}
            onConfirmPendingLookup={handleConfirmPendingLookup}
            onDismissPendingLookup={() => setPendingLookup(null)}
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
