import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RemoveRouteButton } from "@/components/RemoveRouteButton"
import { RouteStats } from "@/components/RouteStats"
import { Check } from "lucide-react"

export interface PlannerPanelProps {
  // "new" when planning started from an empty map, "edit" when it opened on
  // a route that was already loaded - only the wording differs.
  mode: "new" | "edit"
  hasRoute: boolean
  onDone: () => void
  onRemove: () => void
  distanceM: number
  elevationGainM: number
  elevationLossM: number
  avgSpeedKmh: number
  onAvgSpeedChange: (speedKmh: number) => void
}

// Replaces the sidebar's step cards for as long as the planner is active:
// planning and the find/save flow are separate phases, so they don't share
// the sidebar. "Done" hands back to the step cards.
export function PlannerPanel({
  mode,
  hasRoute,
  onDone,
  onRemove,
  distanceM,
  elevationGainM,
  elevationLossM,
  avgSpeedKmh,
  onAvgSpeedChange,
}: PlannerPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === "new" ? "Plan a new route" : "Edit route"}</CardTitle>
        <CardDescription>Routed along roads suited to cycling.</CardDescription>
        <CardAction>
          <Button onClick={onDone}>
            <Check className="size-4" />
            Done
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Click the map to add a point to the end of the route, or drag the route line to add one in the middle.
          Drag any point to move it. Drag the start or end marker to move that end — or drop it back onto the
          route to trim there.
        </p>

        {hasRoute && (
          <RouteStats
            distanceM={distanceM}
            elevationGainM={elevationGainM}
            elevationLossM={elevationLossM}
            avgSpeedKmh={avgSpeedKmh}
            onAvgSpeedChange={onAvgSpeedChange}
          />
        )}

        {hasRoute && <RemoveRouteButton onRemove={onRemove} />}
      </CardContent>
    </Card>
  )
}
