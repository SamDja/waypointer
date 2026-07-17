import { useRef, useState, type DragEvent } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WahooRoutesDialog } from "@/components/WahooRoutesDialog"
import { formatDistanceM, formatDurationHours } from "@/lib/geometry"
import { toast, updateToast } from "@/lib/toast"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { type WahooTokens } from "@/lib/wahooSettings"
import { cn } from "@/lib/utils"
import { ArrowRightIcon, FileUp, FileText, Trash2Icon } from "lucide-react"
import type { ExistingWaypoint } from "@/types/candidate"

export interface ImportCardProps {
  file: File | null
  onFileChange: (file: File) => void
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
}: ImportCardProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [isConnectingWahoo, setIsConnectingWahoo] = useState(false)
  const [showWahooImport, setShowWahooImport] = useState(false)
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)
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
    if (dropped) onFileChange(dropped)
  }

  async function handleConnectWahoo() {
    setIsConnectingWahoo(true)
    const toastId = toast("Connecting to Wahoo...", "loading")
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      updateToast(toastId, scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null ? "error" : "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Wahoo.", "error")
    } finally {
      setIsConnectingWahoo(false)
    }
  }

  if (file) {
    const durationHours = distanceM > 0 ? distanceM / 1000 / avgSpeedKmh : 0

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
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border p-4 text-sm">
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Distance</span>
                <span className="font-medium">{(distanceM / 1000).toFixed(1)}km</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Est. duration</span>
                <span className="font-medium">{formatDurationHours(durationHours)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Elevation gain</span>
                <span className="font-medium">{Math.round(elevationGainM)}m</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Elevation loss</span>
                <span className="font-medium">{Math.round(elevationLossM)}m</span>
              </div>

              <div className="col-span-2 flex items-center gap-2 border-t pt-2">
                <Label htmlFor="avg-speed" className="text-xs text-muted-foreground">
                  Estimate at
                </Label>
                <Input
                  id="avg-speed"
                  type="number"
                  min={1}
                  step={1}
                  value={avgSpeedKmh}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    if (Number.isFinite(next) && next > 0) onAvgSpeedChange(next)
                  }}
                  className="h-7 w-16"
                />
                <span className="text-xs text-muted-foreground">km/h</span>
              </div>
            </div>
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
                  {existingWaypoints.sort((a,b) => a.distance_from_start_m - b.distance_from_start_m).map((waypoint) => {
                    const id = `waypoint-kept-${waypoint.index}`
                    return (
                      <li key={waypoint.index} className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2">
                          <Checkbox
                            id={id}
                            className="mt-1"
                            checked={keptWaypointIndices.has(waypoint.index)}
                            onCheckedChange={() => onToggleExistingWaypoint(waypoint.index)}
                          />
                          <Label htmlFor={id} className="flex min-w-0 flex-col items-start gap-0 font-normal">
                            <span className="truncate text-sm">{waypoint.name || "(unnamed)"}</span>
                            <span className="flex w-full gap-2 text-xs">
                              <span>
                                {formatDistanceM(waypoint.distance_from_start_m)}{" "}
                                <span className="text-muted-foreground">from start</span>
                              </span>
                              <span>
                                {formatDistanceM(waypoint.distance_from_route_m)}{" "}
                                <span className="text-muted-foreground">from track</span>
                              </span>
                            </span>
                          </Label>
                        </div>
                        <PoiTypeCombobox
                          value={waypoint.poi_type}
                          onChange={(poiType) => onChangeWaypointType(waypoint.index, poiType)}
                          className="shrink-0"
                        />
                      </li>
                    )
                  })}
                </ul>
              </div>
            </TabsContent>
          )}
        </Tabs>

        <div className="flex items-center gap-2">
          <Button variant="destructive" className="w-fit flex-grow-1" onClick={() => setShowRemoveConfirm(true)}>
            <Trash2Icon className="size-4" />
            Remove route
          </Button>
          <Button className="w-fit flex-grow-1" onClick={handleNext}>
            Next
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>

        <AlertDialog open={showRemoveConfirm} onOpenChange={setShowRemoveConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this route?</AlertDialogTitle>
              <AlertDialogDescription>
                Your POI selections and search results will be cleared too.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
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
            if (selected) onFileChange(selected)
          }}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
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

      <WahooRoutesDialog
        open={showWahooImport}
        onOpenChange={setShowWahooImport}
        mode="import"
        onImport={onFileChange}
      />
    </div>
  )
}
