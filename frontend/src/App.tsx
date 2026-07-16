import { useState } from "react"
import { MapPinSearch } from "lucide-react"
import { CandidateChecklist } from "@/components/CandidateChecklist"
import { FindPoisCard } from "@/components/FindPoisCard"
import { ImportCard } from "@/components/ImportCard"
import { RouteMap } from "@/components/RouteMap"
import { SaveCard } from "@/components/SaveCard"
import { StepCard } from "@/components/StepCard"
import { Toaster } from "@/components/Toaster"
import { WahooProfileMenu } from "@/components/WahooProfileMenu"
import { ApiError, findPois } from "@/lib/api"
import { parseRouteCoordsFromGpx } from "@/lib/gpx"
import {
  loadPoiSearchConfig,
  loadSettings,
  savePoiSearchConfig,
  saveSettings,
  type DeviceSettings,
  type PoiSearchEntry,
} from "@/lib/settings"
import { toast, updateToast } from "@/lib/toast"
import { loadWahooTokens, type WahooTokens } from "@/lib/wahooSettings"
import type { FindPoisResponse, PoiSearchConfig } from "@/types/candidate"

type Step = "import" | "find" | "review"

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [previewRouteCoords, setPreviewRouteCoords] = useState<[number, number][]>([])
  const [findResult, setFindResult] = useState<FindPoisResponse | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [searchedPoiTypes, setSearchedPoiTypes] = useState<PoiSearchConfig[]>([])
  const [keptWaypointIndices, setKeptWaypointIndices] = useState<Set<number>>(new Set())
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>(() => loadSettings())
  const [poiSearchEntries, setPoiSearchEntries] = useState<PoiSearchEntry[]>(() => loadPoiSearchConfig())
  const [isFinding, setIsFinding] = useState(false)
  const [openStep, setOpenStep] = useState<Step | null>("import")
  const [wahooTokens, setWahooTokens] = useState<WahooTokens | null>(() => loadWahooTokens())

  async function handleFileChange(newFile: File) {
    setFile(newFile)
    setFindResult(null)
    setSelectedIds(new Set())
    setSearchedPoiTypes([])
    setKeptWaypointIndices(new Set())
    setOpenStep("find")

    const text = await newFile.text()
    setPreviewRouteCoords(parseRouteCoordsFromGpx(text))
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
      setOpenStep("review")
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Network error while contacting the server."
      updateToast(toastId, message, "error")
    } finally {
      setIsFinding(false)
    }
  }

  const routeSummary = findResult
    ? `${findResult.point_count} route points, ${findResult.existing_waypoints.length} existing waypoint(s) in file.`
    : null

  return (
    <div className="flex h-screen flex-col">
      <Toaster />
      <header className="flex shrink-0 items-center justify-between gap-1.5 border-b px-4 py-2">
        <div className="flex items-center gap-1.5">
          <MapPinSearch className="size-5 text-indigo-600" />
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
          />
        </div>

        <aside className="flex w-full min-h-0 flex-1 flex-col border-t md:w-[380px] md:flex-none md:border-t-0 md:border-l">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
            <StepCard
              title="1. Import route"
              open={openStep === "import"}
              onOpenChange={(open) => setOpenStep(open ? "import" : null)}
            >
              <ImportCard
                file={file}
                onFileChange={handleFileChange}
                wahooTokens={wahooTokens}
                onWahooTokensChange={setWahooTokens}
              />
            </StepCard>

            <StepCard
              title="2. Find POIs"
              open={openStep === "find"}
              onOpenChange={(open) => setOpenStep(open ? "find" : null)}
            >
              <FindPoisCard
                entries={poiSearchEntries}
                onChange={handlePoiSearchChange}
                onFind={handleFind}
                disabled={!file || !poiSearchEntries.some((entry) => entry.enabled)}
                isFinding={isFinding}
                routeSummary={routeSummary}
              />
            </StepCard>

            {findResult && (
              <StepCard
                title="3. Review POIs found"
                open={openStep === "review"}
                onOpenChange={(open) => setOpenStep(open ? "review" : null)}
              >
                <CandidateChecklist
                  candidates={findResult.candidates}
                  selectedIds={selectedIds}
                  onToggle={handleToggle}
                  searchedPoiTypes={searchedPoiTypes}
                  existingWaypoints={findResult.existing_waypoints}
                  keptWaypointIndices={keptWaypointIndices}
                  onToggleExistingWaypoint={handleToggleExistingWaypoint}
                />
              </StepCard>
            )}

            {findResult && file && (
              <SaveCard
                file={file}
                candidates={findResult.candidates}
                selectedIds={selectedIds}
                existingWaypoints={findResult.existing_waypoints}
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
