import { useState } from "react"
import { MapPinned } from "lucide-react"
import { CandidateChecklist } from "@/components/CandidateChecklist"
import { FindFountainsCard } from "@/components/FindFountainsCard"
import { ImportCard } from "@/components/ImportCard"
import { RouteMap } from "@/components/RouteMap"
import { SaveCard } from "@/components/SaveCard"
import { StatusMessage } from "@/components/StatusMessage"
import { StepCard } from "@/components/StepCard"
import { ApiError, findFountains } from "@/lib/api"
import { parseRouteCoordsFromGpx } from "@/lib/gpx"
import { loadSettings, saveSettings, type DeviceSettings } from "@/lib/settings"
import type { FindFountainsResponse } from "@/types/candidate"

type Step = "import" | "find" | "review"

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [previewRouteCoords, setPreviewRouteCoords] = useState<[number, number][]>([])
  const [findResult, setFindResult] = useState<FindFountainsResponse | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>(() => loadSettings())
  const [status, setStatus] = useState({ message: "", isError: false })
  const [isFinding, setIsFinding] = useState(false)
  const [openStep, setOpenStep] = useState<Step | null>("import")

  async function handleFileChange(newFile: File) {
    setFile(newFile)
    setFindResult(null)
    setSelectedIds(new Set())
    setStatus({ message: "", isError: false })
    setOpenStep("find")

    const text = await newFile.text()
    setPreviewRouteCoords(parseRouteCoordsFromGpx(text))
  }

  function handleDeviceSettingsChange(settings: DeviceSettings) {
    setDeviceSettings(settings)
    saveSettings(settings)
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

  async function handleFind() {
    if (!file) return

    setIsFinding(true)
    setStatus({ message: "Searching OpenStreetMap for nearby water fountains...", isError: false })
    try {
      const result = await findFountains(file)
      setFindResult(result)
      setSelectedIds(new Set(result.candidates.map((c) => c.osm_id)))
      setStatus({ message: "", isError: false })
      setOpenStep("review")
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Network error while contacting the server."
      setStatus({ message, isError: true })
    } finally {
      setIsFinding(false)
    }
  }

  const routeSummary = findResult
    ? `${findResult.point_count} route points, ${findResult.existing_waypoint_count} existing waypoint(s) in file.`
    : null

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-1.5 border-b px-4 py-2">
        <MapPinned className="size-5 text-indigo-600" />
        <h1 className="text-lg font-semibold">Waypointer</h1>
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
              title="1. Import GPX file"
              open={openStep === "import"}
              onOpenChange={(open) => setOpenStep(open ? "import" : null)}
            >
              <ImportCard file={file} onFileChange={handleFileChange} />
            </StepCard>

            <StepCard
              title="2. Find Water Fountains"
              open={openStep === "find"}
              onOpenChange={(open) => setOpenStep(open ? "find" : null)}
            >
              <FindFountainsCard
                onFind={handleFind}
                disabled={!file}
                isFinding={isFinding}
                routeSummary={routeSummary}
              />
            </StepCard>

            {findResult && (
              <StepCard
                title="3. Review fountains found within 50m"
                open={openStep === "review"}
                onOpenChange={(open) => setOpenStep(open ? "review" : null)}
              >
                <CandidateChecklist
                  candidates={findResult.candidates}
                  selectedIds={selectedIds}
                  onToggle={handleToggle}
                />
              </StepCard>
            )}
          </div>

          {(status.message || (findResult && file)) && (
            <div className="flex shrink-0 flex-col gap-4 border-t p-4">
              <StatusMessage message={status.message} isError={status.isError} />

              {findResult && file && (
                <SaveCard
                  file={file}
                  candidates={findResult.candidates}
                  selectedIds={selectedIds}
                  settings={deviceSettings}
                  onSettingsChange={handleDeviceSettingsChange}
                  onStatus={(message, isError) => setStatus({ message, isError })}
                />
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
