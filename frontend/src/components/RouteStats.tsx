import { useId } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NAISMITH_ASCENT_M_PER_HOUR, estimateDurationHours, formatDurationHours, type DurationModel } from "@/lib/geometry"
import { Clock, RulerDimensionLine, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react"

export interface RouteStatsProps {
  distanceM: number
  elevationGainM: number
  elevationLossM: number
  avgSpeedKmh: number
  // The activity's: whether climbing adds to the estimate (see geometry.ts).
  durationModel: DurationModel
  onAvgSpeedChange: (speedKmh: number) => void
}

// Shared by ImportCard (a loaded route) and PlannerPanel (a route being
// planned), so both show the same figures computed the same way.
export function RouteStats({
  distanceM,
  elevationGainM,
  elevationLossM,
  avgSpeedKmh,
  durationModel,
  onAvgSpeedChange,
}: RouteStatsProps) {
  const speedInputId = useId()
  const durationHours = estimateDurationHours(distanceM, elevationGainM, avgSpeedKmh, durationModel)

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border p-4 text-sm">
      <Stat icon={RulerDimensionLine} label="Distance" value={`${(distanceM / 1000).toFixed(1)}km`} />
      <Stat icon={Clock} label="Est. duration" value={formatDurationHours(durationHours)} />
      <Stat icon={TrendingUp} label="Elevation gain" value={`${Math.round(elevationGainM)}m`} />
      <Stat icon={TrendingDown} label="Elevation loss" value={`${Math.round(elevationLossM)}m`} />

      <div className="col-span-2 flex items-center gap-2 border-t pt-2">
        <Label htmlFor={speedInputId} className="text-xs text-muted-foreground">
          Estimate at
        </Label>
        <Input
          id={speedInputId}
          type="number"
          min={1}
          // Half-steps because walking paces live in them: 4.5 km/h is the
          // hiking default, and a whole-number step would both reject it as
          // a step mismatch and make the arrow keys jump past it.
          step={0.5}
          value={avgSpeedKmh}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (Number.isFinite(next) && next > 0) onAvgSpeedChange(next)
          }}
          className="h-7 w-16"
        />
        <span className="text-xs text-muted-foreground">
          km/h
          {/* Says so, since otherwise the estimate looks wrong for the pace shown. */}
          {durationModel === "naismith" && `, +1h per ${NAISMITH_ASCENT_M_PER_HOUR}m climbed`}
        </span>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex flex-row items-center gap-2">
      <Icon className="size-6" />
      <div className="flex flex-col">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">{label}</span>
        <span className="font-medium">{value}</span>
      </div>
    </div>
  )
}
