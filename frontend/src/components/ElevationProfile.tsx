import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import {
  ChevronDown,
  Clock,
  Gauge,
  Info,
  Mountain,
  Pencil,
  RulerDimensionLine,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { climbCategoryLabel, type Climb, type Difficulty } from "@/lib/climbs"
import {
  NAISMITH_ASCENT_M_PER_HOUR,
  cumulativeDistancesM,
  estimateDurationHours,
  formatDurationHours,
  type DurationModel,
} from "@/lib/geometry"
import type { GradeScale } from "@/lib/mapStyles"
import { setHoveredDistanceM, useHoveredDistanceM } from "@/lib/hoverDistance"
import type { SurfaceCategory, SurfaceRun } from "@/lib/routePlanner"
import colors from "tailwindcss/colors"
import { floatingSurfaceClass } from "@/components/ui/surface"

/** A selected POI, drawn as a dot on the profile where it sits along the route. */
export interface ProfilePoiMark {
  id: string
  distanceM: number
  label: string
  color: string
}

export interface ElevationProfileProps {
  coords: [number, number][]
  elevations: (number | null)[]
  // Where each planner point sits along the route, for the ticks under the
  // plot; empty outside the planner.
  pointDistancesM: number[]
  // The route's surface in ride order, on the same distance axis (see
  // routePlanner.plannerSurface), and how much of it is on cycleways. Empty
  // when nothing is known about it (an imported file), which hides the band.
  surfaceRuns: SurfaceRun[]
  cyclewayM: number
  distanceM: number
  gainM: number
  lossM: number
  // The climbs along the route and how hard the whole route is (lib/climbs.ts).
  climbs: Climb[]
  difficulty: Difficulty
  poiMarks: ProfilePoiMark[]
  // Where the gradient bands start, which depends on the activity - see
  // mapStyles.ts's GradeScale.
  gradeScale: GradeScale
  // The duration estimate: the visitor's pace and how the activity adds
  // climbing to it (see geometry.ts).
  avgSpeedKmh: number
  durationModel: DurationModel
  onAvgSpeedChange: (speedKmh: number) => void
  // While planning, elevation arrives leg by leg; a loaded file either has
  // it or doesn't. Only changes the empty-state wording.
  planning: boolean
  defaultOpen: boolean
}

// Plot geometry, in px. The surface band and x-axis band are part of the
// fixed height, so nothing overflows the card. The top margin holds the
// climbs' labels and brackets. No point on the plot is marked until the
// visitor hovers it (here or on the map's route).
const PLOT_HEIGHT = 96
const SURFACE_BAND_HEIGHT = 8
const MARGIN = { top: 30, right: 12, bottom: 38, left: 44 }
const CLIMB_LABEL_Y = 10
const CLIMB_BRACKET_Y = 16
// The hover tooltip's gap to the point it describes.
const TOOLTIP_GAP_PX = 12
// A climb's label may run past its own bracket, as long as it ends before the
// next climb's label starts; this is a generous width per character of the
// labels' text-3xs (10px) so the estimate never undercounts.
const CLIMB_LABEL_CHAR_PX = 6.5
const CLIMB_LABEL_GAP_PX = 6
// The pointer names a POI when it's within this many px of its dot.
const POI_HOVER_PX = 6
// Enough resolution for the widest strip without drawing tens of thousands
// of vertices for a long imported track.
const MAX_SAMPLES = 800
// The profile is coloured in equal-length chunks, each by its own average
// gradient (like Wahoo's per-chunk colouring): at least this long, so a
// gradient reads as the slope of the road rather than of one DEM step...
const MIN_CHUNK_M = 100
// ...and at least this wide on screen, so a long route isn't a blur of
// one-pixel slivers. Each chunk is coloured independently; the tooltip reports
// the gradient of the chunk under the pointer, so it always matches the colour.
const MIN_CHUNK_PX = 4

// Gradient band colours, gentlest first: Wahoo's climb colour order (green,
// yellow, orange, red, brown) in Tailwind steps spread in lightness so
// adjacent bands stay distinguishable, colour-blind readers included
// (validated with the dataviz skill's palette checker). Descents mirror the
// same bands as one blue, darker the steeper (a validated ordinal ramp), so a
// gentle and a steep descent read apart at a glance. Where each band *starts*
// is the activity's GradeScale - the colours are the same for every activity.
const CLIMB_COLORS = [colors.green[600], colors.yellow[500], colors.orange[600], colors.red[800], colors.amber[950]]
const DESCENT_COLORS = [colors.blue[400], colors.blue[500], colors.blue[600], colors.blue[800], colors.blue[950]]

// Within the scale's flatPct a stretch has basically no grade, so it's drawn
// in a neutral grey rather than flickering between the gentlest climb and
// descent bands. Mid grey, not black: it should recede, not compete with the
// bands.
const FLAT_COLOR = colors.neutral[400]

// Surface: Tailwind palette steps that look like the surfaces themselves -
// asphalt grey, the warm light grey of sett, gravel/dirt brown - so the band
// reads without the legend; unknown is a pale neutral that recedes.
const SURFACES: { category: SurfaceCategory; label: string; color: string }[] = [
  { category: "paved", label: "Paved", color: colors.zinc[600] },
  { category: "cobbles", label: "Cobbles", color: colors.stone[500] },
  { category: "unpaved", label: "Unpaved", color: colors.amber[700] },
  { category: "unknown", label: "Unknown", color: colors.zinc[200] },
]
const SURFACE_BY_CATEGORY = Object.fromEntries(SURFACES.map((s) => [s.category, s])) as Record<
  SurfaceCategory,
  (typeof SURFACES)[number]
>

function gradientColor(gradePct: number, scale: GradeScale): string {
  const palette = gradePct >= 0 ? CLIMB_COLORS : DESCENT_COLORS
  const steepness = Math.abs(gradePct)
  let color = palette[0]
  scale.bandStartsPct.forEach((from, i) => {
    if (steepness >= from) color = palette[i]
  })
  return color
}

// The route's figures and its elevation against distance, floating over the
// bottom of the map whenever there's a route. The header is the route's
// summary (distance, estimated duration, climbing, difficulty), readable even
// collapsed. The plot is coloured by gradient, with the climbs bracketed above
// it, selected POIs as dots on it and the surface in a band underneath.
// Hovering (or arrowing through) it moves a marker along the route on the
// map, and hovering the route on the map moves the crosshair here - both
// through lib/hoverDistance.
export function ElevationProfile({
  coords,
  elevations,
  pointDistancesM,
  surfaceRuns,
  cyclewayM,
  distanceM,
  gainM,
  lossM,
  climbs,
  difficulty,
  poiMarks,
  gradeScale,
  avgSpeedKmh,
  durationModel,
  onAvgSpeedChange,
  planning,
  defaultOpen,
}: ElevationProfileProps) {
  const [open, setOpen] = useState(defaultOpen)
  const durationHours = estimateDurationHours(distanceM, gainM, avgSpeedKmh, durationModel)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={floatingSurfaceClass}>
      {/* The whole row toggles, but it can't be the trigger <button> itself:
          the speed and difficulty buttons sit inside it, and a button can't
          hold another. The chevron is the real, focusable toggle. */}
      <div
        className="group flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm"
        data-state={open ? "open" : "closed"}
        onClick={() => setOpen(!open)}
      >
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <HeaderStat icon={RulerDimensionLine} label="Distance" value={`${(distanceM / 1000).toFixed(1)} km`} />
          <HeaderStat icon={Clock} label="Estimated duration" value={formatDurationHours(durationHours)} />
          <SpeedControl avgSpeedKmh={avgSpeedKmh} durationModel={durationModel} onAvgSpeedChange={onAvgSpeedChange} />
          <HeaderStat icon={TrendingUp} label="Elevation gain" value={`${Math.round(gainM).toLocaleString()} m`} />
          <HeaderStat icon={TrendingDown} label="Elevation loss" value={`${Math.round(lossM).toLocaleString()} m`} />
          <span className="flex items-center gap-0.5">
            <HeaderStat icon={Mountain} label="Difficulty" value={difficulty.label} />
            <DifficultyInfo difficulty={difficulty} />
          </span>
        </span>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0"
            aria-label={open ? "Hide elevation profile" : "Show elevation profile"}
            // The row's own click already toggles.
            onClick={(e) => e.stopPropagation()}
          >
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <ProfilePlot
          coords={coords}
          elevations={elevations}
          pointDistancesM={pointDistancesM}
          surfaceRuns={surfaceRuns}
          climbs={climbs}
          poiMarks={poiMarks}
          gradeScale={gradeScale}
          planning={planning}
        />
        <Legends surfaceRuns={surfaceRuns} cyclewayM={cyclewayM} gradeScale={gradeScale} climbs={climbs} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function HeaderStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1" title={label}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <span className="sr-only">{label}:</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  )
}

/**
 * Why the route got its rating: a route is as hard as its hardest criterion,
 * so this names the deciding one and lists every criterion's own level.
 */
function DifficultyInfo({ difficulty }: { difficulty: Difficulty }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Why ${difficulty.label.toLowerCase()}?`}
            // Opening the explanation shouldn't also fold the profile.
            onClick={(e) => e.stopPropagation()}
          >
            <Info className="size-3.5 text-muted-foreground" />
          </Button>
        </TooltipTrigger>
        {/* Portalled, but React still bubbles its clicks to the header row. */}
        <TooltipContent className="flex-col items-start gap-1" onClick={(e) => e.stopPropagation()}>
          <p>
            {difficulty.reason ? (
              <>
                <span className="font-semibold">{difficulty.label}</span>: {difficulty.reason}. A route is as hard
                as its hardest criterion:
              </>
            ) : (
              <>
                <span className="font-semibold">Easy</span>: nothing reaches Moderate. A route is as hard as its
                hardest criterion:
              </>
            )}
          </p>
          <ul className="w-full">
            {difficulty.criteria.map((c) => (
              <li key={c.name} className="flex justify-between gap-4 tabular-nums">
                <span>
                  {c.name}: {c.value}
                </span>
                <span className={c.level === difficulty.level && c.level > 0 ? "font-semibold" : undefined}>
                  {c.label}
                </span>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The pace the duration is estimated at, shown beside it in the header and
 * changed from a popover - in the header, so it's visible next to the figure
 * it drives even with the profile folded.
 */
function SpeedControl({
  avgSpeedKmh,
  durationModel,
  onAvgSpeedChange,
}: Pick<ElevationProfileProps, "avgSpeedKmh" | "durationModel" | "onAvgSpeedChange">) {
  const speedInputId = useId()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-mx-2 text-sm"
          aria-label={`Average speed ${avgSpeedKmh} km/h - change`}
          title="Average speed - change"
          // Changing the speed shouldn't also fold the profile.
          onClick={(e) => e.stopPropagation()}
        >
          <Gauge className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium tabular-nums">{avgSpeedKmh} km/h</span>
          <Pencil className="size-3 text-muted-foreground" aria-hidden data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      {/* Portalled, but React still bubbles its clicks to the header row. */}
      <PopoverContent className="w-64" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-2">
          <Label htmlFor={speedInputId}>Average speed</Label>
          <div className="flex items-center gap-2">
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
              className="h-7 w-20"
            />
            <span className="text-xs text-muted-foreground">km/h</span>
          </div>
          <p className="text-xs text-muted-foreground">
            The estimated duration is the distance at this speed
            {/* Says so, since otherwise the estimate looks wrong for the pace shown. */}
            {durationModel === "naismith" ? `, plus an hour per ${NAISMITH_ASCENT_M_PER_HOUR} m climbed.` : "."}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface Sample {
  distanceM: number
  elevation: number | null
}

function ProfilePlot({
  coords,
  elevations,
  pointDistancesM,
  surfaceRuns,
  climbs,
  poiMarks,
  gradeScale,
  planning,
}: Pick<
  ElevationProfileProps,
  "coords" | "elevations" | "pointDistancesM" | "surfaceRuns" | "climbs" | "poiMarks" | "gradeScale" | "planning"
>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const hoveredM = useHoveredDistanceM()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const cumulative = useMemo(() => cumulativeDistancesM(coords), [coords])
  const totalM = cumulative.length > 0 ? cumulative[cumulative.length - 1] : 0

  const samples = useMemo((): Sample[] => {
    const stride = Math.max(1, Math.ceil(coords.length / MAX_SAMPLES))
    const out: Sample[] = []
    for (let i = 0; i < coords.length; i += stride) out.push({ distanceM: cumulative[i], elevation: elevations[i] ?? null })
    const last = coords.length - 1
    if (last > 0 && last % stride !== 0) out.push({ distanceM: cumulative[last], elevation: elevations[last] ?? null })
    return out
  }, [coords, elevations, cumulative])

  const known = samples.filter((s) => s.elevation !== null).map((s) => s.elevation as number)
  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 0)

  if (known.length < 2 || totalM <= 0) {
    return (
      <div ref={containerRef} className="px-4 pb-3 text-xs text-muted-foreground">
        {planning ? "No elevation data yet - it arrives as each stretch is routed." : "This route has no elevation data."}
      </div>
    )
  }

  const minE = Math.min(...known)
  const maxE = Math.max(...known)
  const yTicks = niceTicks(minE, maxE, 3)
  const yLo = Math.min(yTicks[0], minE)
  const yHi = Math.max(yTicks[yTicks.length - 1], maxE)
  const xTicks = niceTicks(0, totalM / 1000, Math.max(2, Math.floor(plotWidth / 90))).filter((km) => km * 1000 <= totalM)

  const baseline = MARGIN.top + PLOT_HEIGHT
  const x = (distanceM: number) => MARGIN.left + (distanceM / totalM) * plotWidth
  const y = (elevation: number) => MARGIN.top + PLOT_HEIGHT - ((elevation - yLo) / (yHi - yLo || 1)) * PLOT_HEIGHT
  const chunks = gradeChunks(samples, Math.max(MIN_CHUNK_M, (totalM * MIN_CHUNK_PX) / (plotWidth || 1)))
  const gradientRuns = coloredRuns(samples, chunks, x, y, baseline, gradeScale)

  const hovered = hoveredM !== null && hoveredM >= 0 && hoveredM <= totalM ? readout(samples, chunks, hoveredM) : null
  const hoveredSurface = hovered ? surfaceAt(surfaceRuns, hovered.distanceM) : null
  // Where the hovered point is drawn (the baseline where there's no data), for placing the tooltip.
  const hoveredY = hovered?.elevation != null ? y(hovered.elevation) : baseline
  const hoveredClimb = hovered ? climbs.find((c) => hovered.distanceM >= c.startM && hovered.distanceM <= c.endM) : undefined
  const hoveredPoi = hovered
    ? poiMarks.find((poi) => Math.abs(x(poi.distanceM) - x(hovered.distanceM)) <= POI_HOVER_PX)
    : undefined
  // Climbs are named by category where the activity has them, else numbered.
  const climbName = (climb: Climb, i: number) =>
    climb.category !== null ? climbCategoryLabel(climb.category) : climbs.length > 1 ? `Climb ${i + 1}` : "Climb"
  // Above the plot, the full name where it fits before the next climb, else
  // just its category or number ("4", "HC", "5") - a short climb on a long
  // route still gets a label. Left out only when even that doesn't fit; the
  // tooltip always names it in full.
  const climbLabel = (climb: Climb, i: number): string | null => {
    const roomPx = (i + 1 < climbs.length ? x(climbs[i + 1].startM) : width) - x(climb.startM) - CLIMB_LABEL_GAP_PX
    const short = climb.category !== null ? String(climb.category) : climbs.length > 1 ? String(i + 1) : "Climb"
    return [climbName(climb, i), short].find((label) => label.length * CLIMB_LABEL_CHAR_PX <= roomPx) ?? null
  }

  function distanceAtPointer(e: PointerEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = (e.clientX - rect.left - MARGIN.left) / plotWidth
    return Math.min(Math.max(fraction, 0), 1) * totalM
  }

  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const step = totalM / 50
    const current = hoveredM ?? 0
    const next =
      e.key === "ArrowRight" ? current + step
      : e.key === "ArrowLeft" ? current - step
      : e.key === "Home" ? 0
      : e.key === "End" ? totalM
      : null
    if (next === null) return
    e.preventDefault()
    setHoveredDistanceM(Math.min(Math.max(next, 0), totalM))
  }

  // Without surface data the band is left out rather than drawn all "unknown".
  const surfaceHeight = surfaceRuns.length > 0 ? SURFACE_BAND_HEIGHT : 0
  const height = MARGIN.top + PLOT_HEIGHT + MARGIN.bottom - (SURFACE_BAND_HEIGHT - surfaceHeight)
  const surfaceY = baseline + 3
  // Each run's start along the route, so the band's rects can be placed.
  const surfaceStartsM = surfaceRuns.reduce<number[]>(
    (starts, _run, i) => [...starts, i === 0 ? 0 : starts[i - 1] + surfaceRuns[i - 1].distanceM],
    []
  )

  return (
    <div ref={containerRef} className="relative px-1">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="block touch-none select-none focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
          role="img"
          aria-label={`Elevation profile: ${Math.round(minE)} to ${Math.round(maxE)} m over ${(totalM / 1000).toFixed(1)} km, coloured by gradient${climbs.length > 0 ? `, with ${climbs.length} climb${climbs.length === 1 ? "" : "s"} marked` : ""}${surfaceRuns.length > 0 ? ", with the surface underneath" : ""}. Use the arrow keys to read it point by point.`}
          onPointerMove={(e) => setHoveredDistanceM(distanceAtPointer(e))}
          onPointerLeave={() => setHoveredDistanceM(null)}
          onKeyDown={handleKeyDown}
          onBlur={() => setHoveredDistanceM(null)}
        >
          {/* Hairline gridlines + y labels */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
              <text
                x={MARGIN.left - 6}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-3xs tabular-nums"
              >
                {tick.toLocaleString()} m
              </text>
            </g>
          ))}

          {/* Climbs: a faint band behind the plot, bracketed and labelled above it */}
          {climbs.map((climb, i) => {
            const x1 = x(climb.startM)
            const x2 = x(climb.endM)
            const label = climbLabel(climb, i)
            return (
              <g key={`climb-${i}`}>
                <rect x={x1} y={MARGIN.top} width={Math.max(x2 - x1, 1)} height={PLOT_HEIGHT} fill="var(--foreground)" fillOpacity={0.05} />
                <path
                  d={`M${x1},${CLIMB_BRACKET_Y + 4}V${CLIMB_BRACKET_Y}H${x2}V${CLIMB_BRACKET_Y + 4}`}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.5}
                  strokeWidth={1}
                />
                {label && (
                  <text x={x1 + 2} y={CLIMB_LABEL_Y} className="fill-foreground text-3xs font-medium">
                    {label}
                  </text>
                )}
              </g>
            )
          })}

          {/* Gradient-coloured area and line, one piece per run of the same band */}
          {gradientRuns.map((run, i) => (
            <g key={i}>
              {/* crispEdges: anti-aliasing leaves hairline seams where two pieces meet */}
              <path d={run.area} fill={run.color} fillOpacity={0.55} shapeRendering="crispEdges" />
              <path d={run.line} fill="none" stroke={run.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}

          {/* Where each planner point falls along the route */}
          {pointDistancesM.map((d, i) => (
            <line key={i} x1={x(d)} x2={x(d)} y1={baseline - 5} y2={baseline} stroke="var(--foreground)" strokeOpacity={0.5} strokeWidth={1} />
          ))}

          {/* Selected POIs, sitting on the profile where they are along the route */}
          {poiMarks.map((poi) => {
            const elevation = elevationAt(samples, poi.distanceM)
            return (
              <circle
                key={poi.id}
                cx={x(Math.min(Math.max(poi.distanceM, 0), totalM))}
                cy={elevation !== null ? y(elevation) : baseline}
                r={3.5}
                fill={poi.color}
                stroke="var(--card)"
                strokeWidth={1.5}
              />
            )
          })}

          {/* Surface band, on the same distance axis */}
          {surfaceRuns.map((run, i) => {
            const from = surfaceStartsM[i]
            const to = Math.min(from + run.distanceM, totalM)
            return (
              <rect
                key={i}
                x={x(from)}
                y={surfaceY}
                width={Math.max(x(to) - x(from), 0)}
                height={SURFACE_BAND_HEIGHT}
                fill={SURFACE_BY_CATEGORY[run.category].color}
              />
            )
          })}

          {/* x labels, under the surface band */}
          {xTicks.map((km) => (
            <text
              key={km}
              x={x(km * 1000)}
              y={surfaceY + surfaceHeight + 14}
              textAnchor="middle"
              className="fill-muted-foreground text-3xs tabular-nums"
            >
              {km} km
            </text>
          ))}

          {/* Crosshair */}
          {hovered && (
            <g pointerEvents="none">
              <line
                x1={x(hovered.distanceM)}
                x2={x(hovered.distanceM)}
                y1={MARGIN.top}
                y2={surfaceY + surfaceHeight}
                stroke="var(--foreground)"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
              {hovered.elevation !== null && (
                <circle
                  cx={x(hovered.distanceM)}
                  cy={y(hovered.elevation)}
                  r={4}
                  fill={hovered.gradePct !== null ? chunkColor(hovered.gradePct, gradeScale) : "var(--foreground)"}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute rounded-item bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-raised ring-1 ring-foreground/10"
          style={{
            // Wider when it carries a second line, so keep more room on the right.
            left: Math.min(
              Math.max(x(hovered.distanceM) - 70, 0),
              Math.max(width - (hoveredClimb || hoveredPoi ? 300 : 190), 0)
            ),
            // Never over the point it describes: above it when the point is
            // in the lower half of the plot, below it when in the upper half.
            ...(hoveredY > MARGIN.top + PLOT_HEIGHT / 2
              ? { top: hoveredY - TOOLTIP_GAP_PX, transform: "translateY(-100%)" }
              : { top: hoveredY + TOOLTIP_GAP_PX }),
          }}
        >
          <span className="font-semibold tabular-nums">
            {hovered.elevation !== null ? `${Math.round(hovered.elevation).toLocaleString()} m` : "No data"}
          </span>
          <span className="ml-2 text-muted-foreground tabular-nums">
            {(hovered.distanceM / 1000).toFixed(1)} km
            {/* One decimal, so a 1.6% grey stretch doesn't read as "+2%" next to the flat band's edge */}
            {hovered.gradePct !== null && ` · ${hovered.gradePct > 0 ? "+" : ""}${hovered.gradePct.toFixed(1)}%`}
            {hoveredSurface && ` · ${SURFACE_BY_CATEGORY[hoveredSurface].label}`}
          </span>
          {hoveredClimb && (
            <div className="text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">{climbName(hoveredClimb, climbs.indexOf(hoveredClimb))}</span>
              {` · ${(hoveredClimb.lengthM / 1000).toFixed(1)} km at ${hoveredClimb.avgGradePct.toFixed(1)}% · ${Math.round(hoveredClimb.ascentM).toLocaleString()} m · max ${Math.round(hoveredClimb.maxGradePct)}% · Fiets ${hoveredClimb.fiets.toFixed(1)}`}
            </div>
          )}
          {hoveredPoi && (
            <div className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ backgroundColor: hoveredPoi.color }} />
              {hoveredPoi.label}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Surface shares and the gradient scale, as text-token legends with colour swatches beside them. */
function Legends({
  surfaceRuns,
  cyclewayM,
  gradeScale,
  climbs,
}: {
  surfaceRuns: SurfaceRun[]
  cyclewayM: number
  gradeScale: GradeScale
  climbs: Climb[]
}) {
  const totalM = surfaceRuns.reduce((sum, run) => sum + run.distanceM, 0)
  const shares = SURFACES.map((surface) => ({
    ...surface,
    pct: totalM > 0 ? (100 * surfaceRuns.filter((r) => r.category === surface.category).reduce((sum, r) => sum + r.distanceM, 0)) / totalM : 0,
  })).filter((surface) => surface.pct >= 0.5)
  const cyclewayPct = totalM > 0 ? (100 * cyclewayM) / totalM : 0

  return (
    <div className="flex flex-col gap-1.5 px-4 pb-3 text-2xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Climbs</span>
        {climbs.length === 0 ? <span>None</span> : <span className="tabular-nums">{climbSummary(climbs)}</span>}
      </div>
      {totalM > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-foreground">Surface</span>
          {shares.map((surface) => (
            <span key={surface.category} className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-swatch" style={{ backgroundColor: surface.color }} />
              {surface.label} {Math.round(surface.pct)}%
            </span>
          ))}
          {cyclewayPct >= 0.5 && <span>· on cycleways {Math.round(cyclewayPct)}%</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Gradient (%)</span>
        <GradientScale scale={gradeScale} />
      </div>
    </div>
  )
}

/**
 * "Cat 2, Cat 4 ×2 · 1,240 m climbed" - categories hardest first, or
 * "3 climbs · ..." where the activity has none.
 */
function climbSummary(climbs: Climb[]): string {
  const ascent = `${Math.round(climbs.reduce((sum, c) => sum + c.ascentM, 0)).toLocaleString()} m climbed`
  const categorized = climbs.filter((c) => c.category !== null)
  if (categorized.length === 0) return `${climbs.length} climb${climbs.length === 1 ? "" : "s"} · ${ascent}`
  const order = ["HC", "Cat 1", "Cat 2", "Cat 3", "Cat 4"]
  const counts = new Map<string, number>()
  for (const c of categorized) {
    const label = climbCategoryLabel(c.category!)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = order.filter((label) => counts.has(label)).map((label) => (counts.get(label)! > 1 ? `${label} ×${counts.get(label)}` : label))
  return `${parts.join(", ")} · ${ascent}`
}

// Steep descent -> steep climb, each band a swatch, labelled at the band edges.
// The flat band sits in the middle, where the plot draws it: everything
// within +-flatPct is grey, so the gentlest climb and descent bands start at
// the flat band's edges rather than at 0.
function GradientScale({ scale }: { scale: GradeScale }) {
  const swatches = [...[...DESCENT_COLORS].reverse(), FLAT_COLOR, ...CLIMB_COLORS]
  // One label at each boundary between two swatches: the descent band
  // starts mirrored, the flat band's edges, then the climb band starts.
  const inner = scale.bandStartsPct.slice(1)
  const edges = [
    ...[...inner].reverse().map((pct) => `-${pct}`),
    `-${scale.flatPct}`,
    String(scale.flatPct),
    ...inner.map(String),
  ]
  return (
    <span className="flex flex-col">
      <span className="flex">
        {swatches.map((color, i) => (
          <span
            key={i}
            className="h-2 w-6"
            style={{ backgroundColor: color }}
            title={color === FLAT_COLOR ? `Flat (within ±${scale.flatPct}%)` : undefined}
          />
        ))}
      </span>
      <span className="relative h-3 tabular-nums" style={{ width: swatches.length * 24 }}>
        {edges.map((edge, i) => (
          <span key={edge} className="absolute -translate-x-1/2 text-3xs" style={{ left: (i + 1) * 24 }}>
            {edge}
          </span>
        ))}
      </span>
    </span>
  )
}

interface GradeChunk {
  fromM: number
  toM: number
  // Average gradient over the chunk; null where elevation is missing.
  gradePct: number | null
}

/** Equal-length chunks along the route, each with its own average gradient. */
function gradeChunks(samples: Sample[], chunkM: number): GradeChunk[] {
  const endM = samples[samples.length - 1].distanceM
  const chunks: GradeChunk[] = []
  for (let fromM = 0; fromM < endM; fromM += chunkM) {
    const toM = Math.min(fromM + chunkM, endM)
    const a = elevationAt(samples, fromM)
    const b = elevationAt(samples, toM)
    chunks.push({ fromM, toM, gradePct: a !== null && b !== null && toM > fromM ? ((b - a) / (toM - fromM)) * 100 : null })
  }
  return chunks
}

function chunkColor(gradePct: number | null, scale: GradeScale): string {
  if (gradePct === null) return "var(--muted-foreground)"
  return Math.abs(gradePct) < scale.flatPct ? FLAT_COLOR : gradientColor(gradePct, scale)
}

/**
 * Area and line paths, one per run of consecutive chunks in the same band.
 * Each chunk's colour comes from its own gradient only - never from a
 * neighbour's - so a steep stretch can't be swallowed by the colour before it.
 * The outline inside a chunk still follows every sample, so the shape is exact.
 */
function coloredRuns(
  samples: Sample[],
  chunks: GradeChunk[],
  x: (d: number) => number,
  y: (e: number) => number,
  baseline: number,
  scale: GradeScale
): { color: string; line: string; area: string }[] {
  const runs: { color: string; points: [number, number][] }[] = []
  for (const chunk of chunks) {
    const a = elevationAt(samples, chunk.fromM)
    const b = elevationAt(samples, chunk.toM)
    if (a === null || b === null) continue
    const inside = samples
      .filter((s) => s.distanceM > chunk.fromM && s.distanceM < chunk.toM && s.elevation !== null)
      .map((s): [number, number] => [s.distanceM, s.elevation as number])
    const points: [number, number][] = [[chunk.fromM, a], ...inside, [chunk.toM, b]]
    const color = chunkColor(chunk.gradePct, scale)
    const last = runs[runs.length - 1]
    if (last && last.color === color && last.points[last.points.length - 1][0] === chunk.fromM) {
      last.points.push(...points.slice(1))
    } else {
      runs.push({ color, points })
    }
  }
  return runs.map(({ color, points }) => {
    const pts = points.map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`)
    const first = x(points[0][0]).toFixed(1)
    const lastX = x(points[points.length - 1][0]).toFixed(1)
    return { color, line: `M${pts.join("L")}`, area: `M${first},${baseline}L${pts.join("L")}L${lastX},${baseline}Z` }
  })
}

/** Elevation (interpolated) and the gradient of the chunk under a distance along the route. */
function readout(samples: Sample[], chunks: GradeChunk[], distanceM: number) {
  const chunk = chunks.find((c) => distanceM >= c.fromM && distanceM <= c.toM) ?? chunks[chunks.length - 1]
  return { distanceM, elevation: elevationAt(samples, distanceM), gradePct: chunk?.gradePct ?? null }
}

function surfaceAt(runs: SurfaceRun[], distanceM: number): SurfaceCategory | null {
  let walkedM = 0
  for (const run of runs) {
    walkedM += run.distanceM
    if (distanceM <= walkedM) return run.category
  }
  return runs.length > 0 ? runs[runs.length - 1].category : null
}

function elevationAt(samples: Sample[], distanceM: number): number | null {
  const d = Math.min(Math.max(distanceM, 0), samples[samples.length - 1].distanceM)
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid].distanceM <= d) lo = mid
    else hi = mid
  }
  const a = samples[lo]
  const b = samples[hi]
  if (a.elevation === null || b.elevation === null) return a.elevation ?? b.elevation
  const span = b.distanceM - a.distanceM
  return span > 0 ? a.elevation + ((b.elevation - a.elevation) * (d - a.distanceM)) / span : a.elevation
}

/** Round, evenly spaced tick values covering [lo, hi] - about `count` of them. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const range = hi - lo || 1
  const rough = range / Math.max(count, 1)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude
  const start = Math.floor(lo / step) * step
  const ticks: number[] = []
  for (let t = start; t <= hi + step * 1e-9; t += step) ticks.push(Number(t.toFixed(6)))
  return ticks
}
