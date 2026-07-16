import { useState } from "react"
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
import { ApiError, fetchWahooRoutePayload, saveRoute } from "@/lib/api"
import type { DeviceSettings } from "@/lib/settings"
import { pushRouteToWahoo } from "@/lib/wahooApi"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { getValidWahooAccessToken, type WahooTokens } from "@/lib/wahooSettings"
import type { Candidate, ExistingWaypoint } from "@/types/candidate"

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
  onStatus: (message: string, isError: boolean) => void
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
  onStatus,
}: SaveCardProps) {
  const [isSaving, setIsSaving] = useState(false)
  const [isConnectingWahoo, setIsConnectingWahoo] = useState(false)
  const [isSendingToWahoo, setIsSendingToWahoo] = useState(false)
  const isFit = settings.device === "wahoo_elemnt_roam_v3"

  async function handleSave() {
    const selectedCandidates = candidates.filter((c) => selectedIds.has(c.osm_id))
    const discardedWaypointIndices = existingWaypoints
      .filter((w) => !keptWaypointIndices.has(w.index))
      .map((w) => w.index)

    setIsSaving(true)
    onStatus("Saving...", false)
    try {
      const { blob, filename } = await saveRoute({
        gpxFile: file,
        selectedCandidates,
        device: settings.device,
        waterSymbol: settings.waterSymbol,
        discardedWaypointIndices,
      })

      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      onStatus(`Saved ${filename}.`, false)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Network error while contacting the server."
      onStatus(message, true)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleConnectWahoo() {
    setIsConnectingWahoo(true)
    onStatus("Connecting to Wahoo...", false)
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      onStatus(scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null)
    } catch (err) {
      onStatus(err instanceof Error ? err.message : "Failed to connect to Wahoo.", true)
    } finally {
      setIsConnectingWahoo(false)
    }
  }

  async function handleSendToWahoo() {
    const selectedCandidates = candidates.filter((c) => selectedIds.has(c.osm_id))

    setIsSendingToWahoo(true)
    onStatus("Sending to Wahoo...", false)
    try {
      const payload = await fetchWahooRoutePayload(file, selectedCandidates)
      const accessToken = await getValidWahooAccessToken()
      await pushRouteToWahoo(payload, accessToken)
      onStatus("Sent to Wahoo - it will sync to your app and head unit shortly.", false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send to Wahoo."
      onStatus(message, true)
    } finally {
      setIsSendingToWahoo(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>4. Save</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Label htmlFor="device-select" className="w-40 shrink-0">
            Device
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

        {!isFit && (
          <div className="flex items-center gap-3">
            <Label htmlFor="water-symbol" className="w-40 shrink-0">
              Water symbol (&lt;sym&gt;)
            </Label>
            <Input
              id="water-symbol"
              value={settings.waterSymbol}
              onChange={(e) => onSettingsChange({ ...settings, waterSymbol: e.target.value })}
            />
          </div>
        )}

        {isFit && (
          <p className="text-sm text-muted-foreground">
            Exports a ridable FIT course file with the water fountains encoded so the icon
            renders correctly while navigating.
            {existingWaypoints.length > 0 &&
              " FIT courses never include the original file's pre-existing waypoints, so the keep/discard choice above only affects GPX exports."}
          </p>
        )}

        <Button onClick={handleSave} loading={isSaving} className="w-fit">
          {isSaving ? "Saving…" : "Save with selected fountains"}
        </Button>

        <div className="flex flex-col gap-2 border-t pt-4">
          {wahooTokens ? (
            <>
              <p className="text-sm text-muted-foreground">
                Connected to Wahoo{wahooTokens.athleteLabel ? ` as ${wahooTokens.athleteLabel}` : ""}. Sending
                syncs the route to your Wahoo app and head unit automatically.
              </p>
              <Button onClick={handleSendToWahoo} loading={isSendingToWahoo} variant="secondary" className="w-fit">
                {isSendingToWahoo ? "Sending…" : "Send to Wahoo"}
              </Button>
            </>
          ) : (
            <Button onClick={handleConnectWahoo} loading={isConnectingWahoo} variant="secondary" className="w-fit">
              {isConnectingWahoo ? "Connecting…" : "Connect Wahoo"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
