import { type ReactNode, useEffect, useState } from "react"
import { Info, MapPin, Play, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CircleMarkerIcon, ROUTE_END_COLOR, ROUTE_START_COLOR } from "@/lib/mapIcons"
import { evaluateLineLayerPaint, loadStyleJson } from "@/lib/mapStyleLegend"
import { MAP_STYLES } from "@/lib/mapStyles"
import { POI_TYPES } from "@/lib/poiTypes"
import type { Candidate, ExistingWaypoint } from "@/types/candidate"
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec"
import colors from "tailwindcss/colors"

// Same hardcoded sRGB hex as RouteMap.tsx's ROUTE_LINE_COLOR - Tailwind v4's
// oklch() colors.violet[600] isn't usable in MapLibre paint properties, but
// here it's just a plain CSS swatch, so this could reference the Tailwind
// token directly; kept as the literal to stay visually identical to the
// actual route line without importing across files for one constant.
const ROUTE_LINE_COLOR = "#7c3aed"

// Zoom at which road-color rows evaluate a layer's line-width - chosen so
// every category in ROAD_CYCLING_LEGEND has a non-degenerate width (e.g.
// road_track's width interpolation only starts at zoom 15.5).
const LEGEND_REFERENCE_ZOOM = 16
const MIN_SWATCH_WIDTH_PX = 2
const MAX_SWATCH_WIDTH_PX = 10

function clampSwatchWidth(px: number): number {
  return Math.min(MAX_SWATCH_WIDTH_PX, Math.max(MIN_SWATCH_WIDTH_PX, Math.round(px)))
}

function useMapStyleJson(styleUrl: string | undefined): StyleSpecification | null {
  const [styleJson, setStyleJson] = useState<StyleSpecification | null>(null)

  useEffect(() => {
    setStyleJson(null)
    if (!styleUrl) return
    let cancelled = false
    loadStyleJson(styleUrl)
      .then((json) => {
        if (!cancelled) setStyleJson(json)
      })
      .catch(() => {
        if (!cancelled) setStyleJson(null)
      })
    return () => {
      cancelled = true
    }
  }, [styleUrl])

  return styleJson
}

export interface MapLegendProps {
  candidates: Candidate[]
  existingWaypoints: ExistingWaypoint[]
  mapStyleKey: string
}

function LineSwatch({
  color,
  width = 3,
  casingColor,
  casingWidth,
  dashed = false,
}: {
  color: string
  width?: number
  casingColor?: string
  casingWidth?: number
  dashed?: boolean
}) {
  const outerHeight = casingColor ? Math.max(casingWidth ?? width, width + 1) : width
  return (
    <div className="relative flex w-6 shrink-0 items-center justify-center" style={{ height: outerHeight }}>
      {casingColor && (
        <div
          className="absolute inset-x-0 rounded-xs"
          style={{ height: casingWidth ?? width, backgroundColor: casingColor }}
        />
      )}
      <div
        className="absolute inset-x-0 rounded-xs"
        style={{
          height: width,
          backgroundColor: dashed ? "transparent" : color,
          backgroundImage: dashed ? `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 7px)` : undefined,
        }}
      />
    </div>
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
  const styleConfig = MAP_STYLES.find((s) => s.key === mapStyleKey)
  const styleJson = useMapStyleJson(styleConfig?.styleUrl)

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

          {styleConfig?.roadLegend && styleJson && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Road colors</h3>
              {styleConfig.roadLegend.map((category) => {
                const fill = evaluateLineLayerPaint(
                  styleJson,
                  category.fillLayerId,
                  LEGEND_REFERENCE_ZOOM,
                  category.properties,
                )
                if (!fill) return null
                const casing = category.casingLayerId
                  ? evaluateLineLayerPaint(styleJson, category.casingLayerId, LEGEND_REFERENCE_ZOOM, category.properties)
                  : null
                return (
                  <LegendRow
                    key={category.label}
                    swatch={
                      <LineSwatch
                        color={fill.color}
                        width={clampSwatchWidth(fill.width)}
                        casingColor={casing ? casing.color : undefined}
                        casingWidth={casing ? clampSwatchWidth(casing.width) : undefined}
                        dashed={fill.dashed}
                      />
                    }
                    label={category.label}
                  />
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
