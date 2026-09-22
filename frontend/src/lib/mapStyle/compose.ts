import type { LayerSpecification, StyleSpecification } from "@maplibre/maplibre-gl-style-spec"

import liberty from "./liberty.json"

/**
 * Builds each activity's map style from one vendored base plus small,
 * readable patches, instead of keeping a hand-edited ~12k-line fork of the
 * base per activity.
 *
 * `liberty.json` is OpenFreeMap's "liberty" style, vendored verbatim and
 * never hand-edited - refresh it by re-downloading
 * https://tiles.openfreemap.org/styles/liberty and re-running the style
 * tests, which will show exactly what upstream changed. It still points at
 * OpenFreeMap's hosted tiles/sprite/glyphs; only the layer definitions are
 * ours.
 *
 * Two patch stages sit on top of it:
 *
 *   liberty  ->  house style  ->  activity style
 *
 * The house style (houseStyle.ts) is Sulla Via's own cartography - a muted
 * palette that lets the route line and POI markers carry the eye, and
 * higher-contrast labels. It has nothing to do with which activity is
 * selected, so every activity gets it.
 *
 * An activity patch (roadCycling.ts, hiking.ts) then expresses only that
 * activity's judgement: which ways are unsuitable and should recede, and
 * which deserve highlighting. That judgement genuinely differs - unpaved is
 * a problem on a road bike and unremarkable on foot - and is all that
 * separates one activity's map from another's.
 */

// A style is patched, not mutated: each helper returns a new style, so a
// composed style can't be affected by another activity's patch running
// later (all activities share the one imported `liberty` object).
export type StylePatch = (style: StyleSpecification) => StyleSpecification

export const BASE_STYLE = liberty as unknown as StyleSpecification

export function composeStyle(...patches: StylePatch[]): StyleSpecification {
  return patches.reduce<StyleSpecification>(
    (style, patch) => patch(style),
    // Deep clone once up front so the patches below can build new layer
    // objects freely without ever reaching the imported base.
    structuredClone(BASE_STYLE),
  )
}

function mapLayer(
  style: StyleSpecification,
  layerId: string,
  fn: (layer: LayerSpecification) => LayerSpecification,
): StyleSpecification {
  let found = false
  const layers = style.layers.map((layer) => {
    if (layer.id !== layerId) return layer
    found = true
    return fn(layer)
  })
  // A patch naming a layer the base doesn't have is a typo, and a silent
  // no-op would show up much later as "why is that road still yellow".
  if (!found) throw new Error(`Style patch targets unknown layer: ${layerId}`)
  return { ...style, layers }
}

type PaintSpec = Record<string, unknown>

/** Merges paint properties into one layer, leaving its other paint alone. */
export function setPaint(layerId: string, paint: PaintSpec): StylePatch {
  return (style) =>
    mapLayer(style, layerId, (layer) => ({
      ...layer,
      paint: { ...(layer.paint as PaintSpec | undefined), ...paint },
    }) as LayerSpecification)
}

/** Merges layout properties into one layer. */
export function setLayout(layerId: string, layout: PaintSpec): StylePatch {
  return (style) =>
    mapLayer(style, layerId, (layer) => ({
      ...layer,
      layout: { ...(layer.layout as PaintSpec | undefined), ...layout },
    }) as LayerSpecification)
}

/**
 * Sets top-level layer properties (filter, minzoom, maxzoom). An explicit
 * `undefined` removes the property, which is how a layer sheds a maxzoom the
 * base set.
 */
export function setLayerProps(layerId: string, props: Record<string, unknown>): StylePatch {
  return (style) =>
    mapLayer(style, layerId, (layer) => {
      const next = { ...layer, ...props } as Record<string, unknown>
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined) delete next[key]
      }
      return next as unknown as LayerSpecification
    })
}

/** Rewrites one layer's paint from its current value. */
export function mapPaint(layerId: string, fn: (paint: PaintSpec) => PaintSpec): StylePatch {
  return (style) =>
    mapLayer(style, layerId, (layer) => ({
      ...layer,
      paint: fn({ ...((layer.paint as PaintSpec | undefined) ?? {}) }),
    }) as LayerSpecification)
}

// A MapLibre expression. Kept loose on purpose: these are hand-written
// style expressions, and the style spec's own types are far stricter than
// what its evaluator accepts.
export type Expression = unknown[]

/**
 * Makes ways recede where `predicate` holds, by replacing each layer's line
 * colour with the dimmed one only on that branch. The untouched branch keeps
 * whatever colour the layer already had, so an activity patch never has to
 * restate the house palette.
 */
export function dimColorWhen(
  layerIds: readonly string[],
  predicate: Expression,
  dimColor: string | ((layerId: string) => string),
): StylePatch {
  const colorFor = typeof dimColor === "function" ? dimColor : () => dimColor
  return forLayers(layerIds, (layerId) =>
    mapPaint(layerId, (paint) => ({
      ...paint,
      "line-color": ["case", predicate, colorFor(layerId), paint["line-color"] ?? "#000000"],
    })),
  )
}

/**
 * The opacity half of the same idea. The existing opacity is kept as the
 * undimmed branch, including when it's a zoom interpolation - each of its
 * stops is wrapped in turn, since an expression can't be nested inside an
 * interpolation's output the other way round.
 */
export function dimOpacityWhen(
  layerIds: readonly string[],
  predicate: Expression,
  dimOpacity = 0.5,
): StylePatch {
  const dim = (value: unknown): unknown => ["case", predicate, dimOpacity, value]
  return forLayers(layerIds, (layerId) =>
    mapPaint(layerId, (paint) => {
      const current = paint["line-opacity"] ?? 1
      if (Array.isArray(current) && current[0] === "interpolate") {
        const [kind, interpolation, input, ...stops] = current
        const wrapped = stops.map((entry, i) => (i % 2 === 0 ? entry : dim(entry)))
        return { ...paint, "line-opacity": [kind, interpolation, input, ...wrapped] }
      }
      return { ...paint, "line-opacity": dim(current) }
    }),
  )
}

/** Adds a source the base style doesn't have (contours, for hiking). */
export function addSource(sourceId: string, source: unknown): StylePatch {
  return (style) => {
    if (style.sources[sourceId]) throw new Error(`Style patch adds a source that already exists: ${sourceId}`)
    return { ...style, sources: { ...style.sources, [sourceId]: source as never } }
  }
}

/** Inserts layers directly before `anchorId`. */
export function insertLayersBefore(anchorId: string, ...added: LayerSpecification[]): StylePatch {
  return (style) => {
    const at = style.layers.findIndex((layer) => layer.id === anchorId)
    if (at < 0) throw new Error(`Style patch inserts before unknown layer: ${anchorId}`)
    const layers = [...style.layers]
    layers.splice(at, 0, ...added)
    return { ...style, layers }
  }
}

export function removeLayer(layerId: string): StylePatch {
  return (style) => {
    const layers = style.layers.filter((layer) => layer.id !== layerId)
    if (layers.length === style.layers.length) {
      throw new Error(`Style patch removes unknown layer: ${layerId}`)
    }
    return { ...style, layers }
  }
}

/**
 * Inserts layers directly after `anchorId`. Draw order is what decides
 * whether a highlighted cycleway or trail sits on top of the road it runs
 * beside, so every added layer names the layer it goes after rather than
 * being appended.
 */
export function insertLayersAfter(anchorId: string, ...added: LayerSpecification[]): StylePatch {
  return (style) => {
    const at = style.layers.findIndex((layer) => layer.id === anchorId)
    if (at < 0) throw new Error(`Style patch inserts after unknown layer: ${anchorId}`)
    const layers = [...style.layers]
    layers.splice(at + 1, 0, ...added)
    return { ...style, layers }
  }
}

/** Applies one patch-producing function to each of several layers. */
export function forLayers(layerIds: readonly string[], patch: (layerId: string) => StylePatch): StylePatch {
  return (style) => layerIds.reduce((acc, layerId) => patch(layerId)(acc), style)
}
