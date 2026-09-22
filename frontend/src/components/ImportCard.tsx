import { useRef, useState, type DragEvent } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { PoiListItem } from "@/components/PoiListItem"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { RemoveRouteButton } from "@/components/RemoveRouteButton"
import { RouteStats } from "@/components/RouteStats"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WahooRoutesDialog } from "@/components/WahooRoutesDialog"
import { toast, updateToast } from "@/lib/toast"
import { track } from "@/lib/analytics"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { type WahooTokens } from "@/lib/wahooSettings"
import { cn } from "@/lib/utils"
import { ArrowRightIcon, FileUp, FileText, PencilLine, Route } from "lucide-react"
import type { ExistingWaypoint } from "@/types/candidate"

export interface ImportCardProps {
  file: File | null
  onFileChange: (file: File, source: "drop" | "browse" | "wahoo") => void
  onRemove: () => void
  onNext: () => void
  pointCount: number | null
  existingWaypoints: ExistingWaypoint[]
  onChangeWaypointType: (index: number, poiType: string) => void
  keptWaypointIndices: Set<number>
  onToggleExistingWaypoint: (index: number) => void
  onToggleAllExistingWaypoints: (checked: boolean) => void
  distanceM: number
  elevationGainM: number
  elevationLossM: number
  avgSpeedKmh: number
  onAvgSpeedChange: (speedKmh: number) => void
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
  onHoverWaypoint?: (index: number | null) => void
  // Planning a new route is the alternative to loading one, and the same
  // planner edits a route that's already loaded. While it's active, App
  // shows PlannerPanel instead of this card.
  onStartPlanning: () => void
}

export function ImportCard({
  file,
  onFileChange,
  onRemove,
  onNext,
  pointCount,
  existingWaypoints,
  onChangeWaypointType,
  keptWaypointIndices,
  onToggleExistingWaypoint,
  onToggleAllExistingWaypoints,
  distanceM,
  elevationGainM,
  elevationLossM,
  avgSpeedKmh,
  onAvgSpeedChange,
  wahooTokens,
  onWahooTokensChange,
  onHoverWaypoint,
  onStartPlanning,
}: ImportCardProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [isConnectingWahoo, setIsConnectingWahoo] = useState(false)
  const [showWahooImport, setShowWahooImport] = useState(false)
  const [activeTab, setActiveTab] = useState("info")

  // The first "Next" click routes through the Waypoints tab (if the file
  // has any pre-existing waypoints) instead of advancing to step 2, so the
  // visitor sees it at least once - a second click from there advances as
  // usual.
  function handleNext() {
    if (existingWaypoints.length > 0 && activeTab === "info") {
      setActiveTab("waypoints")
    } else {
      onNext()
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragActive(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFileChange(dropped, "drop")
  }

  async function handleConnectWahoo() {
    setIsConnectingWahoo(true)
    const toastId = toast("Connecting to Wahoo...", "loading")
    track("wahoo_connect_initiated", { source: "import_card" })
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      updateToast(toastId, scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null ? "error" : "success")
      track("wahoo_connect_succeeded", { source: "import_card" })
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Wahoo.", "error")
      track("wahoo_connect_failed", { source: "import_card" })
    } finally {
      setIsConnectingWahoo(false)
    }
  }

  if (file) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-md border p-4">
          <FileText className="size-8 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{file.name}</span>
            {existingWaypoints.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {existingWaypoints.length} waypoint{existingWaypoints.length === 1 ? "" : "s"} already in this
                file
              </span>
            )}
            {pointCount !== null && (
              <span className="text-xs text-muted-foreground">{pointCount} route points</span>
            )}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="info">Info</TabsTrigger>
            {existingWaypoints.length > 0 && <TabsTrigger value="waypoints">Waypoints</TabsTrigger>}
          </TabsList>

          <TabsContent value="info">
            <RouteStats
              distanceM={distanceM}
              elevationGainM={elevationGainM}
              elevationLossM={elevationLossM}
              avgSpeedKmh={avgSpeedKmh}
              onAvgSpeedChange={onAvgSpeedChange}
            />
          </TabsContent>

          {existingWaypoints.length > 0 && (
            <TabsContent value="waypoints">
              <div className="rounded-md border p-4 text-sm">
                <p className="mb-3 text-xs text-muted-foreground">
                  This file already has {existingWaypoints.length} waypoint
                  {existingWaypoints.length === 1 ? "" : "s"}. We guessed a type for each - adjust any that
                  aren't right, and uncheck any you'd rather not keep.
                </p>
                <div className="mb-2 flex items-center gap-3 border-b pb-2">
                  <Checkbox
                    id="select-all-waypoints"
                    checked={
                      keptWaypointIndices.size === 0
                        ? false
                        : keptWaypointIndices.size === existingWaypoints.length
                          ? true
                          : "indeterminate"
                    }
                    onCheckedChange={(checked) => onToggleAllExistingWaypoints(checked === true)}
                  />
                  <Label htmlFor="select-all-waypoints" className="text-xs font-normal text-muted-foreground">
                    Select all
                  </Label>
                </div>
                <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto">
                  {existingWaypoints.sort((a, b) => a.distance_from_start_m - b.distance_from_start_m).map((waypoint) => (
                    <PoiListItem
                      key={waypoint.index}
                      id={`waypoint-kept-${waypoint.index}`}
                      title={waypoint.name || "(unnamed)"}
                      checked={keptWaypointIndices.has(waypoint.index)}
                      onCheckedChange={() => onToggleExistingWaypoint(waypoint.index)}
                      distanceFromStartM={waypoint.distance_from_start_m}
                      distanceFromRouteM={waypoint.distance_from_route_m}
                      trailing={
                        <PoiTypeCombobox
                          value={waypoint.poi_type}
                          onChange={(poiType) => onChangeWaypointType(waypoint.index, poiType)}
                          className="shrink-0"
                        />
                      }
                      onMouseEnter={() => onHoverWaypoint?.(waypoint.index)}
                      onMouseLeave={() => onHoverWaypoint?.(null)}
                    />
                  ))}
                </ul>
              </div>
            </TabsContent>
          )}
        </Tabs>

        <div className="flex items-center gap-2">
          <RemoveRouteButton onRemove={onRemove} />
          <Button variant="secondary" className="w-fit" onClick={onStartPlanning}>
            <PencilLine className="size-4" />
            Edit route
          </Button>
          <Button className="w-fit grow" onClick={handleNext}>
            Next
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
      </div>
    )
  }

  // Loading a route and planning a new one are two separate starting points,
  // so the empty state offers them as two equal choices.
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Load a route</h3>
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragActive(true)
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={handleDrop}
          className={cn(
            "flex flex-col items-center gap-3 rounded-md border-2 border-dashed p-6 text-center transition-colors",
            isDragActive ? "border-primary bg-accent" : "border-input"
          )}
        >
          <FileUp size={48} strokeWidth={1}></FileUp>
          <p className="text-sm text-muted-foreground">Drag and drop a GPX file here</p>
          <Button type="button" onClick={() => inputRef.current?.click()}>
            Choose File
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".gpx"
            className="hidden"
            onChange={(e) => {
              const selected = e.target.files?.[0]
              if (selected) onFileChange(selected, "browse")
            }}
          />
        </div>

        {wahooTokens ? (
          <Button variant="secondary" className="w-full" onClick={() => setShowWahooImport(true)}>
            Import from Wahoo
          </Button>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            loading={isConnectingWahoo}
            onClick={handleConnectWahoo}
          >
            {isConnectingWahoo ? "Connecting…" : "Connect Wahoo to import a route"}
          </Button>
        )}
      </section>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Plan a new route</h3>
        <div className="flex flex-col items-center gap-3 rounded-md border p-6 text-center">
          <Route size={48} strokeWidth={1} />
          <p className="text-sm text-muted-foreground">
            Draw a route on the map, snapped to roads suited to cycling.
          </p>
          <Button type="button" onClick={onStartPlanning}>
            <PencilLine className="size-4" />
            Start planning
          </Button>
        </div>
      </section>

      <WahooRoutesDialog
        open={showWahooImport}
        onOpenChange={setShowWahooImport}
        mode="import"
        onImport={(file) => onFileChange(file, "wahoo")}
      />
    </div>
  )
}
