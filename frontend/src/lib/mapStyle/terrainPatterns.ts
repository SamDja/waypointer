import colors from "tailwindcss/colors"

import { tailwindHex } from "../color"

/**
 * Pixel patterns for the hiking style's terrain fills.
 *
 * A topographic map draws loose stone as stipple and solid rock as hatching,
 * which is what makes the two readable apart at a glance in a way that two
 * flat greys never are. MapLibre can do it with `fill-pattern`, but that
 * needs an image in the sprite, and OpenFreeMap's sprite carries no such
 * thing - so the patterns are drawn here, pixel by pixel, and registered
 * with `map.addImage` at runtime (see RouteMap's TerrainPatterns).
 *
 * Pure and deterministic on purpose: no canvas, no randomness at render
 * time. A pattern that differed between registrations would shimmer when
 * the style reloads, and these are unit-testable as plain arrays.
 */

export const SCREE_PATTERN_ID = "terrain-scree"
export const BARE_ROCK_PATTERN_ID = "terrain-bare-rock"
export const FOREST_PATTERN_ID = "terrain-forest"
export const SCRUB_PATTERN_ID = "terrain-scrub"
export const VINEYARD_PATTERN_ID = "terrain-vineyard"

export interface PatternImage {
  width: number
  height: number
  data: Uint8Array
}

// A power of two so it tiles cleanly at every zoom. 32 rather than 16
// because density is what makes texture fight the map drawn over it: at 16
// the marks repeated so often that paths lost almost all contrast against
// the ground. Quadrupling the tile area while keeping roughly the same
// number of marks is what thins them out.
const TILE = 32

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "")
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

function blankTile(): Uint8Array {
  // RGBA, fully transparent: the flat tint beneath shows through wherever
  // the pattern doesn't paint, so the two layers compose.
  return new Uint8Array(TILE * TILE * 4)
}

function setPixel(data: Uint8Array, x: number, y: number, rgb: [number, number, number], alpha: number) {
  // Wrap rather than clip, so a mark crossing the tile edge continues on the
  // far side and the seams don't show when the pattern repeats.
  const px = ((x % TILE) + TILE) % TILE
  const py = ((y % TILE) + TILE) % TILE
  const offset = (py * TILE + px) * 4
  data[offset] = rgb[0]
  data[offset + 1] = rgb[1]
  data[offset + 2] = rgb[2]
  data[offset + 3] = Math.round(alpha * 255)
}

/**
 * Scree: scattered dots of one and two pixels, the classic stipple. The
 * positions are a fixed hand-picked scatter rather than a random one - at
 * this size a generator tends to clump, and a clump reads as a feature on
 * the ground that isn't there.
 */
export function screePattern(): PatternImage {
  const data = blankTile()
  const rgb = hexToRgb(tailwindHex(colors.stone[500]))
  const dots: [number, number, number][] = [
    // x, y, size (1 = single pixel, 2 = a 2x2 clump)
    [4, 6, 2], [17, 3, 1], [27, 9, 2], [10, 15, 1],
    [22, 20, 1], [3, 25, 2], [30, 28, 1], [14, 29, 1],
  ]
  for (const [x, y, size] of dots) {
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        setPixel(data, x + dx, y + dy, rgb, 0.6)
      }
    }
  }
  return { width: TILE, height: TILE, data }
}

/**
 * Bare rock: diagonal hatching. The step divides the tile size exactly, so
 * the lines meet across the seam instead of jogging.
 */
export function bareRockPattern(): PatternImage {
  const data = blankTile()
  const rgb = hexToRgb(tailwindHex(colors.stone[600]))
  const step = 16
  for (let offset = 0; offset < TILE; offset += step) {
    for (let i = 0; i < TILE; i++) {
      setPixel(data, i + offset, i, rgb, 0.45)
    }
  }
  return { width: TILE, height: TILE, data }
}

/**
 * A motif as pixel offsets from its own anchor, stamped wherever it's
 * placed. Writing the shapes this way keeps them legible as pictures in the
 * source - each array below reads roughly like the thing it draws.
 */
type Motif = readonly (readonly [number, number])[]

function stamp(data: Uint8Array, motif: Motif, x: number, y: number, rgb: [number, number, number], alpha: number) {
  for (const [dx, dy] of motif) setPixel(data, x + dx, y + dy, rgb, alpha)
}

/**
 * A conifer, anchored at its apex: a point, two widening tiers, and a
 * trunk. Five pixels across at the base is the smallest that still reads as
 * a tree rather than a smudge, and conifers are what's actually growing at
 * the altitudes this style is for.
 *
 *      #
 *     ###
 *    #####
 *      #
 */
export const TREE: Motif = [
  [0, 0],
  [-1, 1], [0, 1], [1, 1],
  [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2],
  [0, 3],
]

/**
 * A tuft of grass, anchored at its root: three blades fanning up and out,
 * the symbol every topographic map uses for rough open ground.
 *
 *    #   #
 *     # #
 *      #
 *      #
 */
export const TUFT: Motif = [
  [0, 0], [0, -1], [0, -2],
  [-1, -1], [-2, -2],
  [1, -1], [2, -2],
]

/** Forest: scattered conifers, sparse enough that the green still carries. */
export function forestPattern(): PatternImage {
  const data = blankTile()
  const rgb = hexToRgb(tailwindHex(colors.green[700]))
  for (const [x, y] of [
    [6, 6],
    [22, 3],
    [14, 17],
    [28, 21],
    [4, 26],
  ]) {
    stamp(data, TREE, x, y, rgb, 0.4)
  }
  return { width: TILE, height: TILE, data }
}

/**
 * Scrub: grass tufts. Scrub matters on foot because it's slow and scratchy
 * to cross, so it gets a mark that reads as rough ground rather than the
 * plain wash grassland gets.
 */
export function scrubPattern(): PatternImage {
  const data = blankTile()
  const rgb = hexToRgb(tailwindHex(colors.lime[700]))
  for (const [x, y] of [
    [5, 10],
    [18, 6],
    [27, 16],
    [10, 23],
    [22, 29],
  ]) {
    stamp(data, TUFT, x, y, rgb, 0.45)
  }
  return { width: TILE, height: TILE, data }
}

/**
 * Vineyard and orchard: parallel rows. The regularity is the point - it's
 * what distinguishes planted ground from open farmland at a glance, and on
 * the ground it usually means no right of way through.
 */
export function vineyardPattern(): PatternImage {
  const data = blankTile()
  const rgb = hexToRgb(tailwindHex(colors.amber[700]))
  for (let x = 3; x < TILE; x += 10) {
    for (let y = 0; y < TILE; y++) {
      // Broken rather than solid, so it reads as planting rather than as a
      // fence or a path.
      if (y % 4 !== 3) setPixel(data, x, y, rgb, 0.35)
    }
  }
  return { width: TILE, height: TILE, data }
}

export const TERRAIN_PATTERNS: { id: string; build: () => PatternImage }[] = [
  { id: SCREE_PATTERN_ID, build: screePattern },
  { id: BARE_ROCK_PATTERN_ID, build: bareRockPattern },
  { id: FOREST_PATTERN_ID, build: forestPattern },
  { id: SCRUB_PATTERN_ID, build: scrubPattern },
  { id: VINEYARD_PATTERN_ID, build: vineyardPattern },
]
