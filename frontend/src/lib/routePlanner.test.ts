import { describe, expect, it } from "vitest"
import { projectOntoPolylineM } from "@/lib/geometry"
import {
  MAX_ANCHORS,
  type LatLon,
  type PlannerState,
  type Positioned,
  type RoutedSegment,
  appendAnchor,
  emptyPlannerState,
  endpointNeighbourKind,
  insertAnchorAt,
  moveAnchor,
  pendingLegs,
  offRouteItems,
  plannerAnchors,
  plannerGeometry,
  plannerStateFromImport,
  prependAnchor,
  removeLastAnchor,
  trimEnd,
  trimStart,
  updateDistancesAfterExtend,
  updateDistancesAfterTrim,
  withLeg,
} from "@/lib/routePlanner"

const PROFILE = "fastbike-lowtraffic"

/** A west-to-east line of `n` points at ~79m spacing, starting at (45, 7). */
function line(n: number, startLon = 7.0): LatLon[] {
  return Array.from({ length: n }, (_, i) => [45.0, startLon + i * 0.001] as LatLon)
}

function positioned(points: LatLon[], route: LatLon[]): Positioned[] {
  return points.map(([lat, lon]) => {
    const p = projectOntoPolylineM([lat, lon], route)
    return {
      lat,
      lon,
      distanceFromRouteM: p.distanceFromRouteM,
      distanceFromStartM: p.distanceFromStartM,
      nearestSegmentIndex: p.nearestSegmentIndex,
    }
  })
}

/** What a full, non-incremental recompute would produce - the oracle. */
function fullRecompute(items: Positioned[], route: LatLon[]): Positioned[] {
  return positioned(
    items.map((i) => [i.lat, i.lon] as LatLon),
    route
  )
}

function importedState(n = 11): PlannerState {
  const coords = line(n)
  return plannerStateFromImport(coords, coords.map(() => 100), PROFILE)
}

describe("plannerGeometry", () => {
  it("concatenates segments and drops the duplicated joint point", () => {
    let state = emptyPlannerState(PROFILE)
    const a: LatLon = [45.0, 7.0]
    const b: LatLon = [45.0, 7.001]
    const c: LatLon = [45.0, 7.002]

    state = (appendAnchor(state, a) as { state: PlannerState }).state
    state = (appendAnchor(state, b) as { state: PlannerState }).state
    state = (appendAnchor(state, c) as { state: PlannerState }).state
    state = withLeg(state, a, b, { coords: [a, b], elevations: [10, 20], distanceM: 79 })
    state = withLeg(state, b, c, { coords: [b, c], elevations: [20, 30], distanceM: 79 })

    const { coords, elevations } = plannerGeometry(state)
    // a, b, c - b appears once, not twice.
    expect(coords).toEqual([a, b, c])
    expect(elevations).toEqual([10, 20, 30])
  })

  it("draws an unrouted leg as a straight line so the route stays continuous", () => {
    let state = emptyPlannerState(PROFILE)
    state = (appendAnchor(state, [45.0, 7.0]) as { state: PlannerState }).state
    state = (appendAnchor(state, [45.0, 7.01]) as { state: PlannerState }).state

    const { coords, elevations } = plannerGeometry(state)
    expect(coords).toEqual([
      [45.0, 7.0],
      [45.0, 7.01],
    ])
    expect(elevations).toEqual([null, null])
  })
})

describe("edit operations", () => {
  it("appends anchors and reports them in order", () => {
    let state = emptyPlannerState(PROFILE)
    state = (appendAnchor(state, [45.0, 7.0]) as { state: PlannerState }).state
    state = (appendAnchor(state, [45.0, 7.01]) as { state: PlannerState }).state
    expect(plannerAnchors(state)).toEqual([
      [45.0, 7.0],
      [45.0, 7.01],
    ])
  })

  it("refuses an anchor placed on top of the current end", () => {
    let state = emptyPlannerState(PROFILE)
    state = (appendAnchor(state, [45.0, 7.0]) as { state: PlannerState }).state
    const result = appendAnchor(state, [45.0, 7.00005]) // ~4m away
    expect(result.ok).toBe(false)
  })

  it("enforces the anchor cap", () => {
    let state = emptyPlannerState(PROFILE)
    for (let i = 0; i < MAX_ANCHORS; i++) {
      const result = appendAnchor(state, [45.0, 7.0 + i * 0.001])
      expect(result.ok).toBe(true)
      state = (result as { state: PlannerState }).state
    }
    expect(appendAnchor(state, [45.0, 8.0]).ok).toBe(false)
  })

  it("moveAnchor re-points only the two segments touching that anchor", () => {
    let state = emptyPlannerState(PROFILE)
    for (const lon of [7.0, 7.001, 7.002, 7.003]) {
      state = (appendAnchor(state, [45.0, lon]) as { state: PlannerState }).state
    }
    const moved = moveAnchor(state, 2, [45.5, 7.002])
    expect(moved.ok).toBe(true)
    const segments = (moved as { state: PlannerState }).state.segments

    // Segments 0/1/2 join anchors 0-1, 1-2, 2-3. Moving anchor 2 must touch
    // segments 1 and 2 only.
    expect(segments[0]).toMatchObject({ from: [45.0, 7.0], to: [45.0, 7.001] })
    expect(segments[1]).toMatchObject({ to: [45.5, 7.002] })
    expect(segments[2]).toMatchObject({ from: [45.5, 7.002] })
  })

  it("refuses to move an anchor bounding imported geometry", () => {
    const state = importedState()
    expect(moveAnchor(state, 0, [45.5, 7.0]).ok).toBe(false)
  })

  it("removeLastAnchor drops the last segment", () => {
    let state = emptyPlannerState(PROFILE)
    state = (appendAnchor(state, [45.0, 7.0]) as { state: PlannerState }).state
    state = (appendAnchor(state, [45.0, 7.001]) as { state: PlannerState }).state
    const undone = removeLastAnchor(state)
    expect(undone.ok).toBe(true)
    expect(plannerAnchors((undone as { state: PlannerState }).state)).toEqual([[45.0, 7.0]])
  })

  it("prependAnchor extends the start", () => {
    const state = importedState()
    const result = prependAnchor(state, [45.0, 6.99])
    expect(result.ok).toBe(true)
    const anchors = plannerAnchors((result as { state: PlannerState }).state)
    expect(anchors[0]).toEqual([45.0, 6.99])
  })
})

describe("endpointNeighbourKind", () => {
  it("reports fixed for an import and routed for a drawn route", () => {
    expect(endpointNeighbourKind(importedState(), "start")).toBe("fixed")
    expect(endpointNeighbourKind(importedState(), "end")).toBe("fixed")

    let drawn = emptyPlannerState(PROFILE)
    for (const lon of [7.0, 7.001, 7.002]) {
      drawn = (appendAnchor(drawn, [45.0, lon]) as { state: PlannerState }).state
    }
    expect(endpointNeighbourKind(drawn, "start")).toBe("routed")
    expect(endpointNeighbourKind(drawn, "end")).toBe("routed")
  })

  it("reports null when there is no route", () => {
    expect(endpointNeighbourKind(emptyPlannerState(PROFILE), "start")).toBeNull()
  })
})

describe("insertAnchorAt", () => {
  // The property that makes an imported route safe to start editing: until
  // you actually move the new point, nothing about the import changes.
  it("splits imported geometry losslessly, with no routing needed", () => {
    const state = importedState(11)
    const before = plannerGeometry(state)

    const result = insertAnchorAt(state, 400)
    expect(result.ok).toBe(true)
    const next = (result as { state: PlannerState }).state

    expect(next.segments).toHaveLength(2)
    expect(next.segments.every((s) => s.kind === "fixed")).toBe(true)
    const after = plannerGeometry(next)
    expect(after.coords).toEqual(before.coords)
    expect(after.elevations).toEqual(before.elevations)
    // No routed segment means nothing to fetch.
    expect(pendingLegs(next)).toHaveLength(0)
  })

  it("adds exactly one anchor, and returns its index", () => {
    const state = importedState(11)
    const result = insertAnchorAt(state, 400) as { state: PlannerState; anchorIndex: number }
    const anchors = plannerAnchors(result.state)

    expect(anchors).toHaveLength(plannerAnchors(state).length + 1)
    expect(result.anchorIndex).toBe(1)
    // The returned index really does address the new point.
    expect(anchors[result.anchorIndex]).not.toEqual(anchors[0])
    expect(anchors[result.anchorIndex]).not.toEqual(anchors[anchors.length - 1])
  })

  it("splits a routed leg into two routed legs meeting at the split point", () => {
    let state = emptyPlannerState(PROFILE)
    const a: LatLon = [45.0, 7.0]
    const b: LatLon = [45.0, 7.01]
    state = (appendAnchor(state, a) as { state: PlannerState }).state
    state = (appendAnchor(state, b) as { state: PlannerState }).state
    state = withLeg(state, a, b, { coords: line(11), elevations: line(11).map(() => 100), distanceM: 790 })

    const result = insertAnchorAt(state, 400) as { state: PlannerState; anchorIndex: number }
    expect(result.state.segments).toHaveLength(2)
    expect(result.state.segments.every((s) => s.kind === "routed")).toBe(true)
    const [first, second] = result.state.segments as RoutedSegment[]
    expect(first.to).toEqual(second.from)
    expect(first.from).toEqual(a)
    expect(second.to).toEqual(b)
  })

  it("refuses a split that lands on an existing point", () => {
    expect(insertAnchorAt(importedState(11), 0).ok).toBe(false)
    expect(insertAnchorAt(emptyPlannerState(PROFILE), 100).ok).toBe(false)
  })
})

describe("moving points bounded by imported geometry", () => {
  it("converts only the two adjacent segments to routed", () => {
    // Three fixed segments: split an import twice.
    const first = insertAnchorAt(importedState(21), 300) as { state: PlannerState }
    const second = insertAnchorAt(first.state, 1000) as { state: PlannerState }
    expect(second.state.segments).toHaveLength(3)

    // Anchor 1 bounds segments 0 and 1, leaving segment 2 untouched.
    const moved = moveAnchor(second.state, 1, [45.02, 7.004])
    expect(moved.ok).toBe(true)
    const segments = (moved as { state: PlannerState }).state.segments

    expect(segments[0].kind).toBe("routed")
    expect(segments[1].kind).toBe("routed")
    expect(segments[2]).toEqual(second.state.segments[2])
    // The far ends stay put - only the moved point moved.
    expect((segments[0] as RoutedSegment).from).toEqual([45.0, 7.0])
    expect((segments[0] as RoutedSegment).to).toEqual([45.02, 7.004])
    expect((segments[1] as RoutedSegment).from).toEqual([45.02, 7.004])
  })

  it("still refuses an endpoint whose neighbour is imported geometry", () => {
    const state = importedState(11)
    expect(moveAnchor(state, 0, [45.5, 7.0]).ok).toBe(false)
    expect(moveAnchor(state, 1, [45.5, 7.0]).ok).toBe(false)
  })

  it("moves an endpoint whose neighbour is a routed leg", () => {
    let state = emptyPlannerState(PROFILE)
    for (const lon of [7.0, 7.001, 7.002]) {
      state = (appendAnchor(state, [45.0, lon]) as { state: PlannerState }).state
    }
    const moved = moveAnchor(state, 0, [45.01, 6.999])
    expect(moved.ok).toBe(true)
    const next = (moved as { state: PlannerState }).state
    expect(next.start).toEqual([45.01, 6.999])
    expect(plannerAnchors(next)[0]).toEqual([45.01, 6.999])
  })
})

describe("trimming", () => {
  it("trimEnd keeps the start of the route", () => {
    const state = importedState(11)
    const result = trimEnd(state, 300)
    expect(result.ok).toBe(true)
    const { coords } = plannerGeometry((result as { state: PlannerState }).state)
    expect(coords[0]).toEqual([45.0, 7.0])
    expect(coords.length).toBeLessThan(11)
  })

  it("trimStart keeps the end of the route", () => {
    const state = importedState(11)
    const result = trimStart(state, 300)
    expect(result.ok).toBe(true)
    const { coords } = plannerGeometry((result as { state: PlannerState }).state)
    expect(coords[coords.length - 1]).toEqual([45.0, 7.01])
    expect(coords[0]).not.toEqual([45.0, 7.0])
  })

  it("preserves elevations through a trim", () => {
    const coords = line(11)
    const state = plannerStateFromImport(
      coords,
      coords.map((_, i) => i * 10),
      PROFILE
    )
    const result = trimEnd(state, 300)
    const { elevations } = plannerGeometry((result as { state: PlannerState }).state)
    expect(elevations[0]).toBe(0)
    expect(elevations.every((e) => e !== null)).toBe(true)
  })

  it("refuses a trim that would leave no route", () => {
    expect(trimEnd(importedState(11), 0).ok).toBe(false)
  })
})

// The design rests on these two being *exact*, not approximate - a wrong
// distance here silently auto-unchecks the wrong waypoints.
describe("incremental distance updates match a full recompute", () => {
  const route = line(11)
  const points: LatLon[] = [
    [45.0005, 7.0], // ~55m off, near the start
    [45.0009, 7.005], // ~100m off, mid-route
    [45.0, 7.0095], // on the line, near the end
    [45.02, 7.02], // far from everything
  ]

  it("end-trim: untouched points keep their exact cached value", () => {
    const items = positioned(points, route)
    const trimmed = trimEnd(plannerStateFromImport(route, route.map(() => 0), PROFILE), 400)
    expect(trimmed.ok).toBe(true)
    const trimResult = trimmed as {
      state: PlannerState
      survivingSegmentRange: { start: number; end: number }
      startMoved: boolean
    }
    const newRoute = plannerGeometry(trimResult.state).coords

    const incremental = updateDistancesAfterTrim(
      items,
      newRoute,
      trimResult.survivingSegmentRange,
      trimResult.startMoved
    )
    const oracle = fullRecompute(items, newRoute)

    incremental.forEach((item, i) => {
      expect(item.distanceFromRouteM).toBeCloseTo(oracle[i].distanceFromRouteM, 6)
      expect(item.distanceFromStartM).toBeCloseTo(oracle[i].distanceFromStartM, 6)
    })
  })

  it("start-trim reprojects everything, since distance-from-start shifts", () => {
    const items = positioned(points, route)
    const trimmed = trimStart(plannerStateFromImport(route, route.map(() => 0), PROFILE), 400)
    const trimResult = trimmed as {
      state: PlannerState
      survivingSegmentRange: { start: number; end: number }
      startMoved: boolean
    }
    expect(trimResult.startMoved).toBe(true)
    const newRoute = plannerGeometry(trimResult.state).coords

    const incremental = updateDistancesAfterTrim(
      items,
      newRoute,
      trimResult.survivingSegmentRange,
      trimResult.startMoved
    )
    const oracle = fullRecompute(items, newRoute)
    incremental.forEach((item, i) => {
      expect(item.distanceFromRouteM).toBeCloseTo(oracle[i].distanceFromRouteM, 6)
      expect(item.distanceFromStartM).toBeCloseTo(oracle[i].distanceFromStartM, 6)
    })
  })

  it("extend: measuring against the added legs alone gives the same answer", () => {
    const items = positioned(points, route)
    // Extend eastward, passing close to the previously-far point.
    const added: LatLon[] = [
      [45.0, 7.01],
      [45.01, 7.015],
      [45.02, 7.021],
    ]
    const newRoute = [...route, ...added.slice(1)]

    const incremental = updateDistancesAfterExtend(items, newRoute, added, false)
    const oracle = fullRecompute(items, newRoute)

    incremental.forEach((item, i) => {
      expect(item.distanceFromRouteM).toBeCloseTo(oracle[i].distanceFromRouteM, 6)
      expect(item.distanceFromStartM).toBeCloseTo(oracle[i].distanceFromStartM, 6)
    })
    // The far point really did get closer - otherwise this asserts nothing.
    expect(incremental[3].distanceFromRouteM).toBeLessThan(items[3].distanceFromRouteM)
  })

  it("extend: an extension nowhere near a point leaves it untouched", () => {
    const items = positioned(points, route)
    const added: LatLon[] = [
      [45.0, 7.01],
      [46.0, 8.0],
    ]
    const newRoute = [...route, added[1]]
    const incremental = updateDistancesAfterExtend(items, newRoute, added, false)
    expect(incremental[0]).toEqual(items[0])
  })
})

describe("offRouteItems", () => {
  it("selects exactly the items beyond the threshold", () => {
    const route = line(11)
    const items = positioned(
      [
        [45.0002, 7.005], // ~22m
        [45.01, 7.005], // ~1.1km
      ],
      route
    )
    expect(offRouteItems(items, 500)).toHaveLength(1)
    expect(offRouteItems(items, 500)[0].lat).toBe(45.01)
  })
})
