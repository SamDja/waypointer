import { describe, expect, it } from "vitest"

import { TERRAIN_PATTERNS, TREE, TUFT, bareRockPattern, screePattern } from "./terrainPatterns"

/**
 * These produce raw RGBA for `map.addImage`, where a mistake shows up as an
 * invisible fill or a shimmering one rather than an exception - so the
 * things worth asserting are that they paint something, that they paint the
 * same thing every time, and that they tile without a visible seam.
 */

const TILE = screePattern().width
const alphaAt = ({ data }: { data: Uint8Array }, x: number, y: number) => data[(y * TILE + x) * 4 + 3]

describe("terrain patterns", () => {
  it("are RGBA tiles of the declared size", () => {
    for (const { build } of TERRAIN_PATTERNS) {
      const { width, height, data } = build()
      expect(width).toBe(TILE)
      expect(height).toBe(TILE)
      expect(data.length).toBe(width * height * 4)
    }
  })

  it("stay sparse enough for the map drawn over them to win", () => {
    // Density is the thing that goes wrong here. A texture covering much of
    // its tile flattens the contrast between the ground and the paths on
    // top of it, which is exactly how the first version of these read - so
    // the ceiling is deliberately low, not merely "less than half".
    for (const { id, build } of TERRAIN_PATTERNS) {
      const { width, height, data } = build()
      let painted = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++
      expect(painted, id).toBeGreaterThan(0)
      expect(painted / (width * height), id).toBeLessThan(0.1)
    }
  })

  it("are deterministic, so a style reload doesn't reshuffle the ground", () => {
    for (const { build } of TERRAIN_PATTERNS) {
      expect(Array.from(build().data)).toEqual(Array.from(build().data))
    }
  })

  it("hatches bare rock edge to edge, so the lines meet across the seam", () => {
    const hatch = bareRockPattern()
    // Diagonal at a step that divides the tile: whatever is painted on the
    // left edge of a row must continue on the right edge of the row above,
    // which is what makes the repeat invisible.
    for (let y = 0; y < TILE; y++) {
      const leftLit = alphaAt(hatch, 0, y) > 0
      const rightLit = alphaAt(hatch, TILE - 1, (y - 1 + TILE) % TILE) > 0
      expect(leftLit, `row ${y}`).toBe(rightLit)
    }
  })

  it("scatters scree without clumping it into one corner", () => {
    const scree = screePattern()
    // A stipple that bunched up would read as a feature on the ground
    // rather than as texture, so every quadrant gets some.
    const half = TILE / 2
    for (const [qx, qy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      let painted = 0
      for (let x = qx * half; x < qx * half + half; x++) {
        for (let y = qy * half; y < qy * half + half; y++) {
          if (alphaAt(scree, x, y) > 0) painted++
        }
      }
      expect(painted, `quadrant ${qx},${qy}`).toBeGreaterThan(0)
    }
  })

  // The motifs are meant to be recognisable things, not abstract marks - a
  // walker should read "trees" and "rough grass" without a legend. These
  // pin the silhouettes, since it's easy to nudge a coordinate and quietly
  // turn a tree back into a blob.
  const rowWidths = (motif: readonly (readonly [number, number])[]) => {
    const rows = new Map<number, number>()
    for (const [, y] of motif) rows.set(y, (rows.get(y) ?? 0) + 1)
    return [...rows.entries()].sort(([a], [b]) => a - b)
  }

  it("draws a tree with a canopy above a trunk", () => {
    const rows = rowWidths(TREE)
    const widths = rows.map(([, width]) => width)
    // Widening tiers from the apex down...
    expect(widths.slice(0, -1)).toEqual([...widths.slice(0, -1)].sort((a, b) => a - b))
    // ...then a single-pixel trunk under the widest one.
    expect(widths[widths.length - 1]).toBe(1)
    expect(Math.max(...widths)).toBe(widths[widths.length - 2])
  })

  it("draws a tuft with blades fanning up from a root", () => {
    const rows = rowWidths(TUFT)
    // Anchored at the root, so every pixel is at or above the anchor.
    expect(Math.max(...TUFT.map(([, y]) => y))).toBe(0)
    // Widest at the top, narrowing to the root - the opposite of the tree.
    expect(rows[0][1]).toBeGreaterThan(rows[rows.length - 1][1])
    expect(rows[rows.length - 1][1]).toBe(1)
  })
})
