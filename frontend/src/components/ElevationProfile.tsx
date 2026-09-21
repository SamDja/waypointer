import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { ChevronDown, TrendingDown, TrendingUp } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cumulativeDistancesM } from "@/lib/geometry"
import { setHoveredDistanceM, useHoveredDistanceM } from "@/lib/hoverDistance"
import { PLANNER_POINT_COLOR } from "@/lib/mapIcons"

export interface ElevationProfileProps {
  coords: [number, number][]
  elevations: (number | null)[]
  // Where each planner point sits along the route, for the ticks under the plot.
  pointDistancesM: number[]
  gainM: number
  lossM: number
  defaultOpen: boolean
}

// Plot geometry, in px. The x-axis band is part of the fixed height, so axis
// labels never overflow the card.
const PLOT_HEIGHT = 96
const MARGIN = { top: 16, right: 12, bottom: 22, left: 44 }
// Enough resolution for the widest strip without drawing tens of thousands
// of vertices for a long imported track.
const MAX_SAMPLES = 800
// Gradient is measured over this stretch either side of the crosshair, so it
// reads as the slope of the road rather than of one DEM step.
const GRADE_HALF_WINDOW_M = 50

// The route's elevation against distance, shown under the map while planning.
// Hovering (or arrowing through) it moves a marker along the route on the map,
// and hovering the route on the map moves the crosshair here - both through
// lib/hoverDistance.
export function ElevationProfile({
  coords,
  elevations,
  pointDistancesM,
  gainM,
  lossM,
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
        <ProfilePlot coords={coords} elevations={elevations} pointDistancesM={pointDistancesM} />
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
}: Pick<ElevationProfileProps, "coords" | "elevations" | "pointDistancesM">) {
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

  const x = (distanceM: number) => MARGIN.left + (distanceM / totalM) * plotWidth
  const y = (elevation: number) => MARGIN.top + PLOT_HEIGHT - ((elevation - yLo) / (yHi - yLo || 1)) * PLOT_HEIGHT
  const { line, area } = profilePaths(samples, x, y, MARGIN.top + PLOT_HEIGHT)

  const peak = samples.reduce((best, s) => (s.elevation !== null && s.elevation > (best.elevation ?? -Infinity) ? s : best))
  const hovered = hoveredM !== null && hoveredM >= 0 && hoveredM <= totalM ? readout(samples, hoveredM) : null

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

  return (
    <div ref={containerRef} className="relative px-1 pb-2">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="block touch-none select-none focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
          role="img"
          aria-label={`Elevation profile: ${Math.round(minE)} to ${Math.round(maxE)} m over ${(totalM / 1000).toFixed(1)} km. Use the arrow keys to read it point by point.`}
          onPointerMove={(e) => setHoveredDistanceM(distanceAtPointer(e))}
          onPointerLeave={() => setHoveredDistanceM(null)}
          onKeyDown={handleKeyDown}
          onBlur={() => setHoveredDistanceM(null)}
        >
          {/* Hairline gridlines + y labels */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
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
          {/* x labels */}
          {xTicks.map((km) => (
            <text
              key={km}
              x={x(km * 1000)}
              y={MARGIN.top + PLOT_HEIGHT + 16}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {km} km
            </text>
          ))}

          <path d={area} fill={PLANNER_POINT_COLOR} fillOpacity={0.1} />
          <path d={line} fill="none" stroke={PLANNER_POINT_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* Where each planner point falls along the route */}
          {pointDistancesM.map((d, i) => (
            <line
              key={i}
              x1={x(d)}
              x2={x(d)}
              y1={MARGIN.top + PLOT_HEIGHT - 5}
              y2={MARGIN.top + PLOT_HEIGHT}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
            />
          ))}

          {/* The one direct label: the highest point */}
          {peak.elevation !== null && !hovered && (
            <g>
              <circle cx={x(peak.distanceM)} cy={y(peak.elevation)} r={4} fill={PLANNER_POINT_COLOR} stroke="var(--card)" strokeWidth={2} />
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
                y2={MARGIN.top + PLOT_HEIGHT}
                stroke="var(--foreground)"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
              {hovered.elevation !== null && (
                <circle cx={x(hovered.distanceM)} cy={y(hovered.elevation)} r={4} fill={PLANNER_POINT_COLOR} stroke="var(--card)" strokeWidth={2} />
              )}
            </g>
          )}
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute top-0 rounded-md bg-popover px-2 py-1 text-xs shadow-md ring-1 ring-foreground/10"
          style={{
            left: Math.min(Math.max(x(hovered.distanceM) - 50, 0), Math.max(width - 110, 0)),
          }}
        >
          <span className="font-semibold tabular-nums">
            {hovered.elevation !== null ? `${Math.round(hovered.elevation).toLocaleString()} m` : "No data"}
          </span>
          <span className="ml-2 text-muted-foreground tabular-nums">
            {(hovered.distanceM / 1000).toFixed(1)} km
            {hovered.gradePct !== null && ` · ${hovered.gradePct > 0 ? "+" : ""}${hovered.gradePct.toFixed(0)}%`}
          </span>
        </div>
      )}
    </div>
  )
}

/** Line and area paths, broken wherever elevation is missing (gaps, not zero). */
function profilePaths(
  samples: Sample[],
  x: (d: number) => number,
  y: (e: number) => number,
  baseline: number
): { line: string; area: string } {
  let line = ""
  let area = ""
  let run: Sample[] = []
  const flush = () => {
    if (run.length >= 2) {
      const pts = run.map((s) => `${x(s.distanceM).toFixed(1)},${y(s.elevation as number).toFixed(1)}`)
      line += `M${pts.join("L")}`
      area += `M${x(run[0].distanceM).toFixed(1)},${baseline}L${pts.join("L")}L${x(run[run.length - 1].distanceM).toFixed(1)},${baseline}Z`
    }
    run = []
  }
  for (const s of samples) {
    if (s.elevation === null) flush()
    else run.push(s)
  }
  flush()
  return { line, area }
}

/** Elevation (interpolated) and road gradient at a distance along the route. */
function readout(samples: Sample[], distanceM: number) {
  const elevation = elevationAt(samples, distanceM)
  const behind = elevationAt(samples, distanceM - GRADE_HALF_WINDOW_M)
  const ahead = elevationAt(samples, distanceM + GRADE_HALF_WINDOW_M)
  const span = Math.min(distanceM + GRADE_HALF_WINDOW_M, samples[samples.length - 1].distanceM) - Math.max(distanceM - GRADE_HALF_WINDOW_M, 0)
  const gradePct = behind !== null && ahead !== null && span > 0 ? ((ahead - behind) / span) * 100 : null
  return { distanceM, elevation, gradePct }
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
