import { useState } from "react"
import { CandidateChecklist } from "@/components/CandidateChecklist"
import { FindPoisCard } from "@/components/FindPoisCard"
import { ImportCard } from "@/components/ImportCard"
import { RouteMap } from "@/components/RouteMap"
import { SaveCard } from "@/components/SaveCard"
import { StepCard } from "@/components/StepCard"
import { Toaster } from "@/components/Toaster"
import { WahooProfileMenu } from "@/components/WahooProfileMenu"
import { ApiError, findPois } from "@/lib/api"
import { elevationGainLossM, totalDistanceM } from "@/lib/geometry"
import { parseExistingWaypointsFromGpx, parseRouteCoordsFromGpx, parseRouteElevationsFromGpx } from "@/lib/gpx"
import {
  loadAvgSpeedKmh,
  loadPoiSearchConfig,
  loadSettings,
  saveAvgSpeedKmh,
  savePoiSearchConfig,
  saveSettings,
  type DeviceSettings,
  type PoiSearchEntry,
} from "@/lib/settings"
import { toast, updateToast } from "@/lib/toast"
import { loadWahooTokens, type WahooTokens } from "@/lib/wahooSettings"
import type { ExistingWaypoint, FindPoisResponse, PoiSearchConfig } from "@/types/candidate"

type Step = "import" | "find"

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [previewRouteCoords, setPreviewRouteCoords] = useState<[number, number][]>([])
  const [previewElevations, setPreviewElevations] = useState<(number | null)[]>([])
  const [previewExistingWaypoints, setPreviewExistingWaypoints] = useState<ExistingWaypoint[]>([])
  const [findResult, setFindResult] = useState<FindPoisResponse | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [searchedPoiTypes, setSearchedPoiTypes] = useState<PoiSearchConfig[]>([])
  const [keptWaypointIndices, setKeptWaypointIndices] = useState<Set<number>>(new Set())
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

  async function handleFileChange(newFile: File) {
    setFile(newFile)
    setFindResult(null)
    setSelectedIds(new Set())
    setSearchedPoiTypes([])

    const text = await newFile.text()
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
  }

  function handleAvgSpeedChange(speedKmh: number) {
    setAvgSpeedKmh(speedKmh)
    saveAvgSpeedKmh(speedKmh)
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

  async function handleFind() {
    if (!file) return

    const poiConfig = poiSearchEntries
      .filter((entry) => entry.enabled)
      .map((entry) => ({ poi_type: entry.poiType, max_distance_m: entry.maxDistanceM }))
    if (poiConfig.length === 0) return

    setIsFinding(true)
    const toastId = toast("Searching OpenStreetMap for nearby POIs...", "loading")
    try {
      const result = await findPois(file, poiConfig)
      setFindResult(result)
      setSelectedIds(new Set(result.candidates.map((c) => c.osm_id)))
      setSearchedPoiTypes(poiConfig)
      // Default to keeping every pre-existing waypoint, matching today's
      // behavior before this toggle existed.
      setKeptWaypointIndices(new Set(result.existing_waypoints.map((w) => w.index)))
      updateToast(toastId, `Found ${result.candidates.length} candidate(s).`, "success")
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
  const existingWaypoints = (findResult?.existing_waypoints ?? previewExistingWaypoints).map((w) => ({
    ...w,
    poi_type: waypointTypeOverrides[w.index] ?? w.poi_type,
  }))

  return (
    <div className="flex h-screen flex-col">
      <Toaster />
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
            candidates={findResult?.candidates ?? []}
            selectedIds={selectedIds}
            onToggle={handleToggle}
            existingWaypoints={existingWaypoints}
            keptWaypointIndices={keptWaypointIndices}
            onToggleExistingWaypoint={handleToggleExistingWaypoint}
            onChangeWaypointType={handleAssignWaypointType}
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
                    disabled={!file || !poiSearchEntries.some((entry) => entry.enabled)}
                    isFinding={isFinding}
                  />
                  <CandidateChecklist
                    candidates={findResult?.candidates ?? []}
                    selectedIds={selectedIds}
                    onToggle={handleToggle}
                    searchedPoiTypes={searchedPoiTypes}
                  />
                </div>
              </StepCard>
            )}

            {file && (
              <SaveCard
                file={file}
                candidates={findResult?.candidates ?? []}
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
