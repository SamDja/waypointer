import type { ReactNode } from "react"
import { Info, MapPin, Play, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CircleMarkerIcon, ROUTE_END_COLOR, ROUTE_START_COLOR } from "@/lib/mapIcons"
import { MAP_STYLES, ROAD_CYCLING_LEGEND } from "@/lib/mapStyles"
import { POI_TYPES } from "@/lib/poiTypes"
import type { Candidate, ExistingWaypoint } from "@/types/candidate"
import colors from "tailwindcss/colors"

// Same hardcoded sRGB hex as RouteMap.tsx's ROUTE_LINE_COLOR - Tailwind v4's
// oklch() colors.violet[600] isn't usable in MapLibre paint properties, but
// here it's just a plain CSS swatch, so this could reference the Tailwind
// token directly; kept as the literal to stay visually identical to the
// actual route line without importing across files for one constant.
const ROUTE_LINE_COLOR = "#7c3aed"

export interface MapLegendProps {
  candidates: Candidate[]
  existingWaypoints: ExistingWaypoint[]
  mapStyleKey: string
}

function LineSwatch({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <div
      className="w-6 shrink-0"
      style={{
        borderBottomWidth: 3,
        borderBottomColor: color,
        borderBottomStyle: dashed ? "dashed" : "solid",
      }}
    />
  )
}

function LegendRow({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="flex w-7 shrink-0 items-center justify-center">{swatch}</div>
      <span>{label}</span>
    </div>
  )
}

export function MapLegend({ candidates, existingWaypoints, mapStyleKey }: MapLegendProps) {
  const showRoadColors = MAP_STYLES.find((s) => s.key === mapStyleKey)?.hasCustomRoadColors ?? false

  const poiTypeKeys = new Set<string>()
  for (const candidate of candidates) poiTypeKeys.add(candidate.poi_type)
  for (const waypoint of existingWaypoints) poiTypeKeys.add(waypoint.poi_type)
  const visiblePoiTypes = POI_TYPES.filter((p) => poiTypeKeys.has(p.key))

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon-sm" className="bg-background" aria-label="Legend">
              <Info />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Legend</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-64" align="start">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">Symbols</h3>
            <LegendRow swatch={<LineSwatch color={ROUTE_LINE_COLOR} />} label="Route" />
            <LegendRow
              swatch={<CircleMarkerIcon icon={Play} bgColor={ROUTE_START_COLOR} size={20} />}
              label="Start"
            />
            <LegendRow
              swatch={<CircleMarkerIcon icon={Square} bgColor={ROUTE_END_COLOR} size={20} />}
              label="End"
            />
            <LegendRow
              swatch={<CircleMarkerIcon icon={MapPin} bgColor={colors.mist[200]} iconColor={colors.mist[400]} size={20} />}
              label="Not selected / kept"
            />
          </div>

          {visiblePoiTypes.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Points of interest</h3>
              {visiblePoiTypes.map((poiType) => (
                <LegendRow
                  key={poiType.key}
                  swatch={<CircleMarkerIcon icon={poiType.icon} bgColor={poiType.color} size={20} />}
                  label={poiType.label}
                />
              ))}
            </div>
          )}

          {showRoadColors && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Road colors</h3>
              {ROAD_CYCLING_LEGEND.map((entry) => (
                <LegendRow
                  key={entry.label}
                  swatch={<LineSwatch color={entry.color} dashed={entry.dashed} />}
                  label={entry.label}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
