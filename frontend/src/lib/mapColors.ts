// Colours shared by the map's markers and the planner UI around it. Kept out
// of mapIcons.tsx, which exports components: a module mixing components with
// computed constants breaks Vite's fast refresh for it.
import colors from "tailwindcss/colors"
import { tailwindHex } from "@/lib/color"
import type { MapTheme } from "@/lib/theme"

export const ROUTE_START_COLOR = colors.lime[700]
export const ROUTE_END_COLOR = colors.red[700]
// The route planner's numbered points (and its pending-leg line) - shared
// with PlannerPointList so the list's badges match the map. As hex (from the
// Tailwind step), because it's also a MapLibre paint colour - see
// lib/color.ts's tailwindHex.
export const PLANNER_POINT_COLOR = tailwindHex(colors.violet[600])
// A route that finishes where it starts (a loop or out-and-back) marks that
// spot with one marker in both colours, split diagonally.
export const START_FINISH_BACKGROUND = `linear-gradient(135deg, ${ROUTE_START_COLOR} 50%, ${ROUTE_END_COLOR} 50%)`
// Lines drawn on the map itself (the route, the planner's pending legs),
// per map theme. The markers stay violet-600 in both - a solid disc reads on
// either ground - but a 3px line needs the lighter step to stand out from a
// dark basemap.
export const ROUTE_LINE_COLORS: Record<MapTheme, string> = {
  light: tailwindHex(colors.violet[600]),
  dark: tailwindHex(colors.violet[400]),
}
// Labels for symbols we add to the map at runtime (MapPoiOverlay), matching
// the hiking style's own landmark labels.
export const MAP_LABEL_COLORS: Record<MapTheme, { text: string; halo: string }> = {
  light: { text: tailwindHex(colors.stone[700]), halo: "#ffffff" },
  dark: { text: tailwindHex(colors.stone[300]), halo: tailwindHex(colors.stone[900]) },
}
