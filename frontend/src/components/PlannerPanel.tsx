import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { PlannerPointList, type PlannerPoint } from "@/components/PlannerPointList"
import { RemoveRouteButton } from "@/components/RemoveRouteButton"
import { RouteStats } from "@/components/RouteStats"
import { Check, Redo2, Undo2, type LucideIcon } from "lucide-react"

// The platform's modifier key, for shortcut hints.
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"

export interface PlannerPanelProps {
  // "new" when planning started from an empty map, "edit" when it opened on
  // a route that was already loaded - only the wording differs.
  mode: "new" | "edit"
  hasRoute: boolean
  onDone: () => void
  onRemove: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  points: PlannerPoint[]
  onReorderPoint: (from: number, to: number) => void
  onDeletePoint: (index: number) => void
  hoveredPoint: number | null
  onHoverPoint: (index: number | null) => void
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  points,
  onReorderPoint,
  onDeletePoint,
  hoveredPoint,
  onHoverPoint,
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
        <CardAction className="flex items-center gap-1">
          <TooltipProvider>
            <IconAction icon={Undo2} label="Undo" shortcut={`${MOD_KEY}Z`} disabled={!canUndo} onClick={onUndo} />
            <IconAction
              icon={Redo2}
              label="Redo"
              shortcut={`${MOD_KEY}Shift+Z`}
              disabled={!canRedo}
              onClick={onRedo}
            />
          </TooltipProvider>
          <Button className="ml-1" onClick={onDone}>
            <Check className="size-4" />
            Done
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Click the map to add a point to the end of the route, or drag the route line to add one in the middle.
          Drag any point to move it. Drag the start or end marker to move that end — or drop it back onto the
          route to trim there. Click a point to delete it.
        </p>

        <PlannerPointList
          points={points}
          onReorder={onReorderPoint}
          onDelete={onDeletePoint}
          hoveredIndex={hoveredPoint}
          onHover={onHoverPoint}
        />

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

function IconAction({
  icon: Icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: LucideIcon
  label: string
  shortcut: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Wrapped so the tooltip still shows while the button is disabled. */}
        <span>
          <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onClick} aria-label={label}>
            <Icon className="size-4" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {label} ({shortcut})
      </TooltipContent>
    </Tooltip>
  )
}
