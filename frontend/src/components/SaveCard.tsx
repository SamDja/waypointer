import { useState } from "react"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RouteNameDialog } from "@/components/RouteNameDialog"
import { ApiError, fetchWahooRoutePayload, saveRoute } from "@/lib/api"
import { POI_TYPES } from "@/lib/poiTypes"
import type { DeviceSettings } from "@/lib/settings"
import { toast, updateToast } from "@/lib/toast"
import { pushRouteToWahoo } from "@/lib/wahooApi"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { getValidWahooAccessToken, type WahooTokens } from "@/lib/wahooSettings"
import type { Candidate, ExistingWaypoint } from "@/types/candidate"
import { Download, Upload } from "lucide-react"

// The visitor's chosen GPX <sym> for this type, if any, else the
// registry's suggested default, else the type's own label - mirrors
// main.py's _resolve_symbol.
function resolveSymbol(poiType: string, symbols: Record<string, string>): string {
  const cfg = POI_TYPES.find((c) => c.key === poiType)
  return symbols[poiType] || cfg?.defaultGpxSymbol || cfg?.label || poiType
}

export interface SaveCardProps {
  file: File
  candidates: Candidate[]
  selectedIds: Set<number>
  existingWaypoints: ExistingWaypoint[]
  keptWaypointIndices: Set<number>
  settings: DeviceSettings
  onSettingsChange: (settings: DeviceSettings) => void
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
}

export function SaveCard({
  file,
  candidates,
  selectedIds,
  existingWaypoints,
  keptWaypointIndices,
  settings,
  onSettingsChange,
  wahooTokens,
  onWahooTokensChange,
}: SaveCardProps) {
  const [isSaving, setIsSaving] = useState(false)
  const [isConnectingWahoo, setIsConnectingWahoo] = useState(false)
  const [isSendingToWahoo, setIsSendingToWahoo] = useState(false)
  const [showSaveNameDialog, setShowSaveNameDialog] = useState(false)
  const [showWahooNameDialog, setShowWahooNameDialog] = useState(false)
  const [pendingSaveAction, setPendingSaveAction] = useState<"download" | "wahoo" | null>(null)
  const [activeTab, setActiveTab] = useState<string>(() => (wahooTokens ? "wahoo" : "download"))
  const isFit = settings.device === "wahoo_elemnt_roam_v3"
  const defaultRouteName = file.name.replace(/\.gpx$/i, "")

  const selectedCandidates = candidates.filter((c) => selectedIds.has(c.osm_id))

  // Only POI types actually present in the output - a candidate must be
  // selected, an existing waypoint must be kept - not the full registry.
  const presentPoiTypes = Array.from(
    new Set([
      ...selectedCandidates.map((c) => c.poi_type),
      ...existingWaypoints.filter((w) => keptWaypointIndices.has(w.index)).map((w) => w.poi_type),
    ])
  )

  function requestSave(action: "download" | "wahoo") {
    if (selectedCandidates.length === 0) {
      setPendingSaveAction(action)
    } else if (action === "download") {
      setShowSaveNameDialog(true)
    } else {
      setShowWahooNameDialog(true)
    }
  }

  function keptExistingWaypointTypes(): Record<number, string> {
    return Object.fromEntries(
      existingWaypoints.filter((w) => keptWaypointIndices.has(w.index)).map((w) => [w.index, w.poi_type])
    )
  }

  async function handleSave(routeName: string) {
    const discardedWaypointIndices = existingWaypoints
      .filter((w) => !keptWaypointIndices.has(w.index))
      .map((w) => w.index)
    const symbols = Object.fromEntries(
      presentPoiTypes.map((poiType) => [poiType, resolveSymbol(poiType, settings.symbols)])
    )

    setIsSaving(true)
    const toastId = toast("Saving...", "loading")
    try {
      const { blob, filename } = await saveRoute({
        gpxFile: file,
        selectedCandidates,
        device: settings.device,
        symbols,
        discardedWaypointIndices,
        existingWaypointTypes: keptExistingWaypointTypes(),
        routeName,
      })

      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      updateToast(toastId, `Saved ${filename}.`, "success")
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Network error while contacting the server."
      updateToast(toastId, message, "error")
    } finally {
      setIsSaving(false)
    }
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

  async function handleSendToWahoo(routeName: string) {
    const discardedWaypointIndices = existingWaypoints
      .filter((w) => !keptWaypointIndices.has(w.index))
      .map((w) => w.index)

    setIsSendingToWahoo(true)
    const toastId = toast("Sending to Wahoo...", "loading")
    try {
      const payload = await fetchWahooRoutePayload(
        file,
        selectedCandidates,
        discardedWaypointIndices,
        keptExistingWaypointTypes(),
        routeName,
      )
      const accessToken = await getValidWahooAccessToken()
      await pushRouteToWahoo(payload, accessToken)
      updateToast(toastId, "Sent to Wahoo - it will sync to your app and head unit shortly.", "success")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send to Wahoo."
      updateToast(toastId, message, "error")
    } finally {
      setIsSendingToWahoo(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Save</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="download">Download file</TabsTrigger>
            <TabsTrigger value="wahoo">Wahoo</TabsTrigger>
          </TabsList>

          <TabsContent value="download" className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Label htmlFor="device-select" className="w-40 shrink-0">
                File format
              </Label>
              <Select
                value={settings.device}
                onValueChange={(device) => onSettingsChange({ ...settings, device })}
              >
                <SelectTrigger id="device-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="generic">Generic (GPX)</SelectItem>
                  <SelectItem value="wahoo_elemnt_roam_v3">Wahoo ELEMNT ROAM v3 (.fit)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {!isFit && presentPoiTypes.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">
                  Symbol (&lt;sym&gt;) for each POI type in this file
                </span>
                {presentPoiTypes.map((poiType) => {
                  const cfg = POI_TYPES.find((c) => c.key === poiType)
                  const id = `symbol-${poiType}`
                  return (
                    <div key={poiType} className="flex items-center gap-3">
                      <Label htmlFor={id} className="w-40 shrink-0">
                        {cfg ? <cfg.icon className="size-4" color={cfg.color}></ cfg.icon> : null}
                        <span>{cfg?.label ?? poiType}</span>
                      </Label>
                      <Input
                        id={id}
                        value={resolveSymbol(poiType, settings.symbols)}
                        onChange={(e) =>
                          onSettingsChange({
                            ...settings,
                            symbols: { ...settings.symbols, [poiType]: e.target.value },
                          })
                        }
                      />
                    </div>
                  )
                })}
              </div>
            )}

            {isFit && (
              <p className="text-sm text-muted-foreground">
                Exports a ridable FIT course file with the selected POIs (including any kept pre-existing
                waypoints) encoded so their icons render correctly while navigating.
              </p>
            )}

            <Button onClick={() => requestSave("download")} loading={isSaving} className="w-fit">
              {isSaving ? "Saving…" : "Download route"}
              <Download className="size-4"></Download>
            </Button>

            <RouteNameDialog
              open={showSaveNameDialog}
              onOpenChange={setShowSaveNameDialog}
              defaultName={defaultRouteName}
              confirmLabel="Download"
              onConfirm={handleSave}
            />
          </TabsContent>

          <TabsContent value="wahoo" className="flex flex-col gap-2">
            {wahooTokens ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Connected to Wahoo{wahooTokens.athleteLabel ? ` as ${wahooTokens.athleteLabel}` : ""}. Sending
                  syncs the route to your Wahoo app and head unit automatically.
                </p>
                <Button
                  onClick={() => requestSave("wahoo")}
                  loading={isSendingToWahoo}
                  className="w-fit"
                >
                  {isSendingToWahoo ? "Sending…" : "Send to Wahoo"}
                  <Upload className="size-4"></Upload>
                </Button>
              </>
            ) : (
              <Button onClick={handleConnectWahoo} loading={isConnectingWahoo} variant="secondary" className="w-fit">
                {isConnectingWahoo ? "Connecting…" : "Connect Wahoo"}
              </Button>
            )}

            <RouteNameDialog
              open={showWahooNameDialog}
              onOpenChange={setShowWahooNameDialog}
              defaultName={defaultRouteName}
              confirmLabel="Send to Wahoo"
              onConfirm={handleSendToWahoo}
            />
          </TabsContent>
        </Tabs>
      </CardContent>

      <AlertDialog open={pendingSaveAction !== null} onOpenChange={(next) => !next && setPendingSaveAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No POIs added yet</AlertDialogTitle>
            <AlertDialogDescription>
              You haven't found or added any points of interest to this route. Use Find POIs above - after
              selecting the POI types you want to discover - then choose which ones to add, or save the route
              as-is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (pendingSaveAction === "download") setShowSaveNameDialog(true)
                else if (pendingSaveAction === "wahoo") setShowWahooNameDialog(true)
              }}
            >
              Save anyway
            </AlertDialogCancel>
            <AlertDialogAction>Let's find some POIs</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
