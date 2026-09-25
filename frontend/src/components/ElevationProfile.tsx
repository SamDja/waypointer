import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { ChevronDown, TrendingDown, TrendingUp } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cumulativeDistancesM } from "@/lib/geometry"
import type { GradeScale } from "@/lib/mapStyles"
import { setHoveredDistanceM, useHoveredDistanceM } from "@/lib/hoverDistance"
import type { SurfaceCategory, SurfaceRun } from "@/lib/routePlanner"
import colors from "tailwindcss/colors"

export interface ElevationProfileProps {
  coords: [number, number][]
  elevations: (number | null)[]
  // Where each planner point sits along the route, for the ticks under the plot.
  pointDistancesM: number[]
  // The route's surface in ride order, on the same distance axis (see
  // routePlanner.plannerSurface), and how much of it is on cycleways.
  surfaceRuns: SurfaceRun[]
  cyclewayM: number
  gainM: number
  lossM: number
  // Where the gradient bands start, which depends on the activity - see
  // mapStyles.ts's GradeScale.
  gradeScale: GradeScale
  defaultOpen: boolean
}

// Plot geometry, in px. The surface band and x-axis band are part of the
// fixed height, so nothing overflows the card.
const PLOT_HEIGHT = 96
const SURFACE_BAND_HEIGHT = 8
const MARGIN = { top: 16, right: 12, bottom: 38, left: 44 }
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

// The route's elevation against distance, shown under the map while planning.
// Coloured by gradient, with the surface in a band underneath. Hovering (or
// arrowing through) it moves a marker along the route on the map, and
// hovering the route on the map moves the crosshair here - both through
// lib/hoverDistance.
export function ElevationProfile({
  coords,
  elevations,
  pointDistancesM,
  surfaceRuns,
  cyclewayM,
  gainM,
  lossM,
  gradeScale,
  defaultOpen,
}: ElevationProfileProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl bg-card shadow-lg ring-1 ring-foreground/10">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm">
        <span className="font-medium">Elevation</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <TrendingUp className="size-4" />
          {Math.round(gainM).toLocaleString()} m
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <TrendingDown className="size-4" />
          {Math.round(lossM).toLocaleString()} m
        </span>
        <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <ProfilePlot
          coords={coords}
          elevations={elevations}
          pointDistancesM={pointDistancesM}
          surfaceRuns={surfaceRuns}
          gradeScale={gradeScale}
        />
        <Legends surfaceRuns={surfaceRuns} cyclewayM={cyclewayM} gradeScale={gradeScale} />
      </CollapsibleContent>
    </Collapsible>
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
  gradeScale,
}: Pick<ElevationProfileProps, "coords" | "elevations" | "pointDistancesM" | "surfaceRuns" | "gradeScale">) {
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
        No elevation data yet - it arrives as each stretch is routed.
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

  const peak = samples.reduce((best, s) => (s.elevation !== null && s.elevation > (best.elevation ?? -Infinity) ? s : best))
  const hovered = hoveredM !== null && hoveredM >= 0 && hoveredM <= totalM ? readout(samples, chunks, hoveredM) : null
  const hoveredSurface = hovered ? surfaceAt(surfaceRuns, hovered.distanceM) : null

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

  const height = MARGIN.top + PLOT_HEIGHT + MARGIN.bottom
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
          aria-label={`Elevation profile: ${Math.round(minE)} to ${Math.round(maxE)} m over ${(totalM / 1000).toFixed(1)} km, coloured by gradient, with the surface underneath. Use the arrow keys to read it point by point.`}
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
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {tick.toLocaleString()} m
              </text>
            </g>
          ))}

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
              y={surfaceY + SURFACE_BAND_HEIGHT + 14}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {km} km
            </text>
          ))}

          {/* The one direct label: the highest point */}
          {peak.elevation !== null && !hovered && (
            <g>
              <circle cx={x(peak.distanceM)} cy={y(peak.elevation)} r={4} fill="var(--foreground)" stroke="var(--card)" strokeWidth={2} />
              <text
                x={Math.min(Math.max(x(peak.distanceM), MARGIN.left + 24), MARGIN.left + plotWidth - 24)}
                y={y(peak.elevation) - 8}
                textAnchor="middle"
                className="fill-foreground text-[11px] font-medium tabular-nums"
              >
                {Math.round(peak.elevation).toLocaleString()} m
              </text>
            </g>
          )}

          {/* Crosshair */}
          {hovered && (
            <g pointerEvents="none">
              <line
                x1={x(hovered.distanceM)}
                x2={x(hovered.distanceM)}
                y1={MARGIN.top}
                y2={surfaceY + SURFACE_BAND_HEIGHT}
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
          className="pointer-events-none absolute top-0 rounded-md bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-md ring-1 ring-foreground/10"
          style={{ left: Math.min(Math.max(x(hovered.distanceM) - 70, 0), Math.max(width - 190, 0)) }}
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
}: {
  surfaceRuns: SurfaceRun[]
  cyclewayM: number
  gradeScale: GradeScale
}) {
  const totalM = surfaceRuns.reduce((sum, run) => sum + run.distanceM, 0)
  const shares = SURFACES.map((surface) => ({
    ...surface,
    pct: totalM > 0 ? (100 * surfaceRuns.filter((r) => r.category === surface.category).reduce((sum, r) => sum + r.distanceM, 0)) / totalM : 0,
  })).filter((surface) => surface.pct >= 0.5)
  const cyclewayPct = totalM > 0 ? (100 * cyclewayM) / totalM : 0

  return (
    <div className="flex flex-col gap-1.5 px-4 pb-3 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Surface</span>
        {shares.map((surface) => (
          <span key={surface.category} className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-[2px]" style={{ backgroundColor: surface.color }} />
            {surface.label} {Math.round(surface.pct)}%
          </span>
        ))}
        {cyclewayPct >= 0.5 && <span>· on cycleways {Math.round(cyclewayPct)}%</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Gradient</span>
        <GradientScale scale={gradeScale} />
        <span className="flex items-center gap-1">
          <span className="h-2 w-3 rounded-[2px]" style={{ backgroundColor: FLAT_COLOR }} />
          Flat (within ±{gradeScale.flatPct}%)
        </span>
      </div>
    </div>
  )
}

// Steep descent -> steep climb, each band a swatch, labelled at the band edges.
function GradientScale({ scale }: { scale: GradeScale }) {
  const swatches = [...DESCENT_COLORS].reverse().concat(CLIMB_COLORS)
  // One label at each boundary between two swatches: the descent band
  // starts mirrored, then 0, then the climb band starts.
  const inner = scale.bandStartsPct.slice(1)
  const edges = [...[...inner].reverse().map((pct) => `-${pct}`), "0", ...inner.map(String)]
  return (
    <span className="flex flex-col">
      <span className="flex">
        {swatches.map((color, i) => (
          <span key={i} className="h-2 w-6" style={{ backgroundColor: color }} />
        ))}
      </span>
      <span className="relative h-3 tabular-nums" style={{ width: swatches.length * 24 }}>
        {edges.map((edge, i) => (
          <span key={edge} className="absolute -translate-x-1/2 text-[9px]" style={{ left: (i + 1) * 24 }}>
            {edge}
          </span>
        ))}
        <span className="absolute text-[9px]" style={{ left: swatches.length * 24 + 4 }}>
          %
        </span>
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
