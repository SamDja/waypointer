// Colours shared by the map's markers and the planner UI around it. Kept out
// of mapIcons.tsx, which exports components: a module mixing components with
// computed constants breaks Vite's fast refresh for it.
import colors from "tailwindcss/colors"
import { tailwindHex } from "@/lib/color"

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
