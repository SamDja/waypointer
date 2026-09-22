import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { PlannerPointList, type PlannerPoint, type PlannerReturnLeg } from "@/components/PlannerPointList"
import { RemoveRouteButton } from "@/components/RemoveRouteButton"
import { RoutingOptionsSection } from "@/components/RoutingOptionsSection"
import { RouteStats } from "@/components/RouteStats"
import { ArrowLeftRight, ArrowRight, Check, Redo2, RefreshCw, Undo2, type LucideIcon } from "lucide-react"
import type { RoutingOptionSpec, RoutingOptions } from "@/lib/mapStyles"
import type { RouteShape } from "@/lib/routePlanner"

// The platform's modifier key, for shortcut hints.
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"

export interface PlannerPanelProps {
  // "new" when planning started from an empty map, "edit" when it opened on
  // a route that was already loaded - only the wording differs.
  mode: "new" | "edit"
  // The plan is too big to keep as a draft across reloads (see lib/plannerDraft).
  draftTooBig: boolean
  hasRoute: boolean
  onDone: () => void
  onRemove: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  points: PlannerPoint[]
  returnLeg: PlannerReturnLeg | null
  routingOptionSpecs: RoutingOptionSpec[]
  routingOptions: RoutingOptions
  onRoutingOptionsChange: (options: RoutingOptions) => void
  shape: RouteShape
  // A loop or out-and-back needs a point to come back from.
  canChangeShape: boolean
  onShapeChange: (shape: RouteShape) => void
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

const ROUTE_SHAPES: { value: RouteShape; label: string; icon: LucideIcon }[] = [
  { value: "one-way", label: "One-way", icon: ArrowRight },
  { value: "loop", label: "Loop", icon: RefreshCw },
  { value: "out-and-back", label: "Out & back", icon: ArrowLeftRight },
]

// Replaces the sidebar's step cards for as long as the planner is active:
// planning and the find/save flow are separate phases, so they don't share
// the sidebar. "Done" hands back to the step cards.
export function PlannerPanel({
  mode,
  draftTooBig,
  hasRoute,
  onDone,
  onRemove,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  points,
  returnLeg,
  routingOptionSpecs,
  routingOptions,
  onRoutingOptionsChange,
  shape,
  canChangeShape,
  onShapeChange,
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

        <RoutingOptionsSection
          specs={routingOptionSpecs}
          values={routingOptions}
          onChange={onRoutingOptionsChange}
        />

        <Tabs value={shape} onValueChange={(value) => onShapeChange(value as RouteShape)}>
          <TabsList className="w-full">
            {ROUTE_SHAPES.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} disabled={value !== "one-way" && !canChangeShape}>
                <Icon className="size-4" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <PlannerPointList
          points={points}
          returnLeg={returnLeg}
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

        {draftTooBig && (
          <p className="text-xs text-muted-foreground">
            This route is too large to keep as a draft, so it won't be offered back if the page reloads.
          </p>
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
