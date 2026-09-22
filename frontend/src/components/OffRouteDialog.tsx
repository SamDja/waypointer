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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatDistanceM } from "@/lib/geometry"
import { POI_TYPES } from "@/lib/poiTypes"
import { MapPin } from "lucide-react"

// One row per stranded item. Deliberately a flat shape rather than
// Candidate | ExistingWaypoint: the dialog treats a selected water fountain
// and a pre-existing waypoint identically, since being stranded by a route
// edit is equally wrong for both.
export interface OffRouteItem {
  key: string
  kind: "candidate" | "waypoint"
  name: string | null
  poiType: string
  distanceFromRouteM: number
}

export interface OffRouteDialogProps {
  open: boolean
  items: OffRouteItem[]
  thresholdM: number
  onThresholdChange: (thresholdM: number) => void
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirms auto-unchecking the points a route edit left behind.
 *
 * Only ever opened when the edit actually strands something - an edit that
 * affects nothing applies silently. The threshold input lives here rather
 * than in a settings panel so its effect is visible while it's being
 * adjusted: the list re-filters live as the number changes.
 */
export function OffRouteDialog({
  open,
  items,
  thresholdM,
  onThresholdChange,
  onConfirm,
  onCancel,
}: OffRouteDialogProps) {
  const count = items.length

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count} point{count === 1 ? "" : "s"} no longer near your route
          </AlertDialogTitle>
          <AlertDialogDescription>
            Your edit moved {count === 1 ? "this point" : "these points"} more than{" "}
            {formatDistanceM(thresholdM)} from the route. They&apos;ll be unchecked, not deleted - you can
            check any of them again afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 border-y py-3">
          <Label htmlFor="off-route-threshold" className="text-xs text-muted-foreground">
            Uncheck anything further than
          </Label>
          <Input
            id="off-route-threshold"
            type="number"
            min={1}
            step={50}
            value={thresholdM}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next) && next > 0) onThresholdChange(next)
            }}
            className="h-7 w-20"
          />
          <span className="text-xs text-muted-foreground">m</span>
        </div>

        <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {items.map((item) => {
            const poiType = POI_TYPES.find((p) => p.key === item.poiType)
            const Icon = poiType?.icon ?? MapPin
            const color = poiType?.color
            return (
              <li key={item.key} className="flex items-center gap-2 rounded-md p-1 text-sm">
                <Icon className="size-4 shrink-0" style={color ? { color } : undefined} />
                <span className="min-w-0 flex-1 truncate">
                  {item.name || (poiType?.label ?? "(unnamed)")}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDistanceM(item.distanceFromRouteM)} off route
                </span>
              </li>
            )
          })}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel className="cursor-pointer">Keep the route as it was</AlertDialogCancel>
          <AlertDialogAction className="cursor-pointer" onClick={onConfirm}>
            Apply edit and uncheck {count}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
