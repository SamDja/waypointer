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
import { ApiError, saveRoute } from "@/lib/api"
import type { DeviceSettings } from "@/lib/settings"
import type { Candidate } from "@/types/candidate"

export interface SaveCardProps {
  file: File
  candidates: Candidate[]
  selectedIds: Set<number>
  settings: DeviceSettings
  onSettingsChange: (settings: DeviceSettings) => void
  onStatus: (message: string, isError: boolean) => void
}

export function SaveCard({
  file,
  candidates,
  selectedIds,
  settings,
  onSettingsChange,
  onStatus,
}: SaveCardProps) {
  const [isSaving, setIsSaving] = useState(false)
  const isFit = settings.device === "wahoo_elemnt_roam_v3"

  async function handleSave() {
    const selectedCandidates = candidates.filter((c) => selectedIds.has(c.osm_id))

    setIsSaving(true)
    onStatus("Saving...", false)
    try {
      const { blob, filename } = await saveRoute({
        gpxFile: file,
        selectedCandidates,
        device: settings.device,
        waterSymbol: settings.waterSymbol,
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
          </p>
        )}

        <Button onClick={handleSave} loading={isSaving} className="w-fit">
          {isSaving ? "Saving…" : "Save with selected fountains"}
        </Button>
      </CardContent>
    </Card>
  )
}
