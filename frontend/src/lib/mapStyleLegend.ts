import {
  createPropertyExpression,
  latest,
  type Feature,
  type StylePropertySpecification,
  type StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec"

/**
 * The style spec's own `latest` export is inferred structurally, so its
 * entries come out with `type: string` rather than the literal types
 * `createPropertyExpression` wants. The values are the specifications that
 * function is built to take - only their inferred types are too loose - so
 * this names the cast once instead of at each call.
 */
export function linePaintSpec(property: keyof typeof latest.paint_line): StylePropertySpecification {
  return latest.paint_line[property] as unknown as StylePropertySpecification
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

  // The second argument is the property's own key, which the style spec
  // uses only to name it in any parse error it reports.
  const colorExpr = createPropertyExpression(
    paint["line-color"] ?? "#000000",
    "line-color",
    linePaintSpec("line-color"),
  )
  const widthExpr = createPropertyExpression(paint["line-width"] ?? 1, "line-width", linePaintSpec("line-width"))
  const opacityExpr = createPropertyExpression(
    paint["line-opacity"] ?? 1,
    "line-opacity",
    linePaintSpec("line-opacity"),
  )
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
