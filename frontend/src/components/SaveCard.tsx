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
import { ApiError, saveRoute } from "@/lib/api"
import { track } from "@/lib/analytics"
import { DEVICES } from "@/lib/devices"
import { POI_TYPES } from "@/lib/poiTypes"
import type { DeviceSettings } from "@/lib/settings"
import { toast, updateToast } from "@/lib/toast"
import { pushRouteToWahoo } from "@/lib/wahooApi"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { findConnection, withConnection, type Connection } from "@/lib/connections"
import type { Account } from "@/types/account"
import type { Candidate, ExistingWaypoint } from "@/types/candidate"
import { Download, ExternalLink, Upload } from "lucide-react"

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
  // Whether this activity offers the Wahoo push (mapStyles.ts's
  // wahooSync). False hides the tabs entirely rather than leaving a
  // one-trigger TabsList, which reads as a broken control. It does not
  // affect the account menu's fitness apps or importing a route from Wahoo.
  wahooSync: boolean
  // Connecting Wahoo needs a verified account (connections live with it).
  account: Account | null
  onSignIn: () => void
  // The account's connected apps. Strava's API can't receive a route (no
  // route write endpoint at all), so a connected Strava only gets
  // directions for adding the file by hand.
  connections: Connection[]
  onConnectionsChange: (connections: Connection[]) => void
}

export function SaveCard({
  file,
  candidates,
  selectedIds,
  existingWaypoints,
  keptWaypointIndices,
  settings,
  onSettingsChange,
  wahooSync,
  account,
  onSignIn,
  connections,
  onConnectionsChange,
}: SaveCardProps) {
  const wahoo = findConnection(connections, "wahoo")
  const stravaConnected = findConnection(connections, "strava") !== null
  const [isSaving, setIsSaving] = useState(false)
  const [isConnectingWahoo, setIsConnectingWahoo] = useState(false)
  const [isSendingToWahoo, setIsSendingToWahoo] = useState(false)
  const [showSaveNameDialog, setShowSaveNameDialog] = useState(false)
  const [showWahooNameDialog, setShowWahooNameDialog] = useState(false)
  const [pendingSaveAction, setPendingSaveAction] = useState<"download" | "wahoo" | null>(null)
  const [activeTab, setActiveTab] = useState<string>(() =>
    wahooSync && wahoo ? "wahoo" : "download"
  )
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
      track("route_saved", {
        format: settings.device,
        selected_candidate_count: selectedCandidates.length,
        present_poi_types: presentPoiTypes.join(","),
        discarded_waypoint_count: discardedWaypointIndices.length,
      })
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Couldn't create the route file - please try again."
      updateToast(toastId, message, "error")
      track("route_save_failed", {
        // An ApiError with no status never got a response (see lib/api.ts).
        reason: err instanceof ApiError && err.status !== undefined ? "api_error" : "network_error",
        format: settings.device,
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleConnectWahoo() {
    setIsConnectingWahoo(true)
    const toastId = toast("Connecting to Wahoo...", "loading")
    track("wahoo_connect_initiated", { source: "save_card" })
    try {
      const connection = await connectWahoo()
      onConnectionsChange(withConnection(connections, connection))
      const scopeWarning = missingWahooScopeWarning(connection.scope)
      updateToast(toastId, scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null ? "error" : "success")
      track("wahoo_connect_succeeded", { source: "save_card" })
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Wahoo.", "error")
      track("wahoo_connect_failed", { source: "save_card" })
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
      await pushRouteToWahoo({
        file,
        selectedCandidates,
        discardedWaypointIndices,
        existingWaypointTypes: keptExistingWaypointTypes(),
        routeName,
      })
      updateToast(toastId, "Sent to Wahoo - it will sync to your app and head unit shortly.", "success")
      track("route_sent_to_wahoo", {
        selected_candidate_count: selectedCandidates.length,
        present_poi_types: presentPoiTypes.join(","),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send to Wahoo."
      updateToast(toastId, message, "error")
      track("route_send_to_wahoo_failed", {})
    } finally {
      setIsSendingToWahoo(false)
    }
  }

  // Rendered either as the "Download file" tab or, when this activity
  // has no Wahoo push, as the whole card body.
  const downloadSection = (
    <div className="flex flex-col gap-4">
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
            {DEVICES.map((device) => (
              <SelectItem key={device.key} value={device.key}>
                {device.label}
              </SelectItem>
            ))}
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

      {stravaConnected && (
        <p className="text-xs text-muted-foreground">
          To add it to Strava, download it as {isFit ? "a GPX file (choose Generic above)" : "GPX"} and import it
          from{" "}
          <a
            href="https://www.strava.com/athlete/routes"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
          >
            your routes on Strava
            <ExternalLink className="size-3" />
          </a>{" "}
          - Strava doesn't let other apps send routes to it directly.
        </p>
      )}

      <RouteNameDialog
        open={showSaveNameDialog}
        onOpenChange={setShowSaveNameDialog}
        defaultName={defaultRouteName}
        confirmLabel="Download"
        onConfirm={handleSave}
      />
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>4. Save the route and get out there!</CardTitle>
      </CardHeader>
      <CardContent>
        {wahooSync ? (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="download">Download file</TabsTrigger>
              <TabsTrigger value="wahoo">Wahoo</TabsTrigger>
            </TabsList>

            <TabsContent value="download">{downloadSection}</TabsContent>

            <TabsContent value="wahoo" className="flex flex-col gap-2">
              {wahoo ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Connected to Wahoo{wahoo.label ? ` as ${wahoo.label}` : ""}. Sending
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
              ) : !account ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Sign in to connect Wahoo - the connection is kept with your account, so it works on every device.
                  </p>
                  <Button onClick={onSignIn} variant="secondary" className="w-fit">
                    Sign in
                  </Button>
                </>
              ) : !account.email_verified ? (
                <p className="text-sm text-muted-foreground">
                  Confirm your email address to connect Wahoo - we sent a link to {account.email}.
                </p>
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
        ) : (
          downloadSection
        )}
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
