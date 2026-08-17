import { createPropertyExpression, latest, type Feature, type StyleSpecification } from "@maplibre/maplibre-gl-style-spec"

const styleJsonCache = new Map<string, Promise<StyleSpecification>>()

// Style JSONs served from public/map-styles/ are static local files, so an
// unbounded in-memory cache keyed by URL is fine - they only change via a
// full page reload during development.
export function loadStyleJson(styleUrl: string): Promise<StyleSpecification> {
  let pending = styleJsonCache.get(styleUrl)
  if (!pending) {
    pending = fetch(styleUrl).then((res) => {
      if (!res.ok) throw new Error(`Failed to load style JSON: ${styleUrl} (${res.status})`)
      return res.json() as Promise<StyleSpecification>
    })
    styleJsonCache.set(styleUrl, pending)
  }
  return pending
}

export interface LineLayerPaint {
  color: string
  width: number
  opacity: number
  dashed: boolean
}

// Evaluates a real line layer's paint properties from a loaded style JSON,
// using the same expression engine MapLibre GL JS itself uses to render the
// map - this is what "bonds" the legend to the actual style instead of
// hand-copied color literals. Returns null (caller should skip the row) if
// the layer doesn't exist or isn't a line layer.
export function evaluateLineLayerPaint(
  styleJson: StyleSpecification,
  layerId: string,
  zoom: number,
  properties: Record<string, unknown> = {},
): LineLayerPaint | null {
  const layer = styleJson.layers.find((l) => l.id === layerId)
  if (!layer || layer.type !== "line") return null

  const paint = layer.paint ?? {}
  const evaluationContext = { zoom }
  // Only `type`/`properties` matter to the expressions we evaluate (color/
  // width/opacity `case`/`match` branches only ever read `get` properties),
  // so a minimal LineString stand-in satisfies the Feature contract without
  // needing a real rendered feature.
  const feature: Feature = { type: "LineString", properties }

  const colorExpr = createPropertyExpression(paint["line-color"] ?? "#000000", latest.paint_line["line-color"])
  const widthExpr = createPropertyExpression(paint["line-width"] ?? 1, latest.paint_line["line-width"])
  const opacityExpr = createPropertyExpression(paint["line-opacity"] ?? 1, latest.paint_line["line-opacity"])
  if (colorExpr.result !== "success" || widthExpr.result !== "success" || opacityExpr.result !== "success") {
    return null
  }

  const color = colorExpr.value.evaluate(evaluationContext, feature)
  const width = widthExpr.value.evaluate(evaluationContext, feature)
  const opacity = opacityExpr.value.evaluate(evaluationContext, feature)

  return {
    color: color.toString(),
    width: typeof width === "number" ? width : 1,
    opacity: typeof opacity === "number" ? opacity : 1,
    dashed: paint["line-dasharray"] != null,
  }
}
