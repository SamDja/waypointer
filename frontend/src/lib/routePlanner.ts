// The route planner's data model and edit operations. Pure - no React, no
// MapLibre, no network - so the invariants below can be reasoned about (and
// tested) on their own.
//
// A route is an ordered list of segments rather than a list of anchors. An
// imported GPX is a dense polyline with no anchors, and guessing anchors
// back out of one is exactly that - guessing. Modelling segments instead
// makes "draw from scratch" and "extend/trim an import" the same feature:
//
//   import              -> one `fixed` segment
//   trim                -> slice that segment (no routing call at all)
//   extend              -> append/prepend a `routed` leg
//   draw from scratch   -> `routed` legs only
//
// A `fixed` segment is never re-routed, so imported geometry (and its
// elevation) survives editing byte-for-byte - which matters because a FIT
// course with no altitude data renders flat black on a Wahoo ELEMNT ROAM.

import {
  bboxOfCoords,
  haversineM,
  isInBbox,
  projectOntoPolylineM,
  totalDistanceM,
} from "@/lib/geometry"

export type LatLon = [number, number]

export interface FixedSegment {
  kind: "fixed"
  coords: LatLon[]
  // Index-parallel to coords; null where the source had no <ele>, matching
  // lib/gpx.ts's parseRouteElevationsFromGpx.
  elevations: (number | null)[]
}

export interface RoutedSegment {
  kind: "routed"
  from: LatLon
  to: LatLon
}

export type Segment = FixedSegment | RoutedSegment

export interface RoutedLeg {
  coords: LatLon[]
  elevations: (number | null)[]
  distanceM: number
}

// What happens after the last point:
// - one-way: nothing, the route ends there.
// - loop: a routed return leg from the last point back to the start.
// - out-and-back: the outbound geometry again, reversed - the last point is
//   the turnaround.
// The return part is never stored as segments: plannerGeometry derives it,
// so anchors stay the outbound points only and every edit operation (append
// inserts before the return, delete, reorder, ...) works unchanged.
export type RouteShape = "one-way" | "loop" | "out-and-back"

// BRouter profile options (see lib/mapStyles.ts's RoutingOptionSpec) - part
// of every leg's cache key, since the same two points route differently
// under different options.
export type RoutingOptions = Record<string, boolean | number>

export interface PlannerState {
  // The route's first point, held separately from the segments because the
  // first click has nothing to route to yet. Representing it as a
  // one-coordinate segment instead would break the anchor/segment index
  // relationship every edit operation relies on: anchor 0 is segments[0]'s
  // start, and anchor i>0 is segments[i-1]'s end and segments[i]'s start.
  start: LatLon | null
  segments: Segment[]
  // Routed geometry, keyed by legKey(). Kept beside the segments rather than
  // inside them so that dragging an anchor away and back, or undoing an
  // edit, reuses geometry already fetched instead of re-requesting it.
  legs: Record<string, RoutedLeg>
  profile: string
  options: RoutingOptions
  shape: RouteShape
}

// Guardrails on a hand-drawn route: each anchor costs a routing request, and
// the whole polyline is resubmitted to every POI search and export.
export const MAX_ANCHORS = 50
export const MAX_ROUTE_DISTANCE_M = 300_000

// Two clicks closer together than this are treated as the same place - used
// to detect closing a loop by clicking back on the start anchor.
export const ANCHOR_SNAP_M = 25

export function emptyPlannerState(profile: string, options: RoutingOptions = {}): PlannerState {
  return { start: null, segments: [], legs: {}, profile, options, shape: "one-way" }
}

export function plannerStateFromImport(
  coords: LatLon[],
  elevations: (number | null)[],
  profile: string,
  options: RoutingOptions = {}
): PlannerState {
  return {
    start: coords.length > 0 ? coords[0] : null,
    segments: coords.length > 0 ? [{ kind: "fixed", coords, elevations }] : [],
    legs: {},
    profile,
    options,
    shape: "one-way",
  }
}

// Rounded so that a drag returning to (visually) the same spot hits the
// cache. 5 decimal places is ~1m, well below ANCHOR_SNAP_M.
function coordKey([lat, lon]: LatLon): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`
}

function optionsKey(options: RoutingOptions): string {
  return Object.keys(options)
    .sort()
    .map((key) => `${key}=${options[key]}`)
    .join(",")
}

export function legKey(from: LatLon, to: LatLon, profile: string, options: RoutingOptions = {}): string {
  return `${profile}|${optionsKey(options)}|${coordKey(from)}|${coordKey(to)}`
}

function stateLegKey(state: PlannerState, from: LatLon, to: LatLon): string {
  return legKey(from, to, state.profile, state.options)
}

/** Whether this routed segment has its geometry for the state's current profile and options. */
export function isLegRouted(state: PlannerState, segment: RoutedSegment): boolean {
  return state.legs[stateLegKey(state, segment.from, segment.to)] !== undefined
}

/**
 * Geometry this leg had under other options, if any was fetched - drawn
 * while it's re-routed under the new ones, so changing an option doesn't
 * collapse the route into straight lines (and the off-route check doesn't
 * measure against them) for the few seconds the requests take.
 */
function previouslyRoutedLeg(state: PlannerState, from: LatLon, to: LatLon): RoutedLeg | undefined {
  const prefix = `${state.profile}|`
  const suffix = `|${coordKey(from)}|${coordKey(to)}`
  for (const [key, leg] of Object.entries(state.legs)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) return leg
  }
  return undefined
}

/**
 * The routed legs with no geometry at all yet - not even from other
 * options - so they're drawn as straight placeholders (RouteMap dashes
 * them). A subset of pendingLegs.
 */
export function unroutedLegs(state: PlannerState): RoutedSegment[] {
  return pendingLegs(state).filter((s) => previouslyRoutedLeg(state, s.from, s.to) === undefined)
}

/** Switches the routing options; every routed leg is then re-fetched under them. */
export function setRoutingOptions(state: PlannerState, options: RoutingOptions): PlannerState {
  return { ...state, options }
}

/** The routed legs in `state` that have no geometry fetched yet. */
export function pendingLegs(state: PlannerState): RoutedSegment[] {
  const returning = returnLeg(state)
  return [...state.segments, ...(returning ? [returning] : [])].filter(
    (s): s is RoutedSegment => s.kind === "routed" && !isLegRouted(state, s)
  )
}

/**
 * Stores fetched leg geometry. Pass `routedWith` - the profile and options
 * the request was made with - whenever the state may have changed while it
 * was in flight: a late response must land under its own options' key, not
 * whichever options are current by then.
 */
export function withLeg(
  state: PlannerState,
  from: LatLon,
  to: LatLon,
  leg: RoutedLeg,
  routedWith: { profile: string; options: RoutingOptions } = state
): PlannerState {
  return { ...state, legs: { ...state.legs, [legKey(from, to, routedWith.profile, routedWith.options)]: leg } }
}

function segmentGeometry(
  segment: Segment,
  state: PlannerState
): { coords: LatLon[]; elevations: (number | null)[] } {
  if (segment.kind === "fixed") return { coords: segment.coords, elevations: segment.elevations }
  const leg =
    state.legs[stateLegKey(state, segment.from, segment.to)] ?? previouslyRoutedLeg(state, segment.from, segment.to)
  // A leg whose geometry hasn't arrived yet contributes a straight line, so
  // the route stays continuous while the request is in flight. RouteMap
  // renders these dashed (see unroutedLegs).
  if (!leg) return { coords: [segment.from, segment.to], elevations: [null, null] }
  return { coords: leg.coords, elevations: leg.elevations }
}

interface PlannerGeometry {
  coords: LatLon[]
  elevations: (number | null)[]
}

/**
 * The route as drawn - every segment's geometry in order, dropping the
 * duplicated joint point where one segment ends and the next begins - without
 * the return part a loop or out-and-back adds (see plannerGeometry). This is
 * what trims measure against: the return is derived, never cut.
 */
export function outboundGeometry(state: PlannerState): PlannerGeometry {
  const coords: LatLon[] = []
  const elevations: (number | null)[] = []
  // Before the second click there are no segments, only a placed start point.
  if (state.segments.length === 0) {
    return state.start ? { coords: [state.start], elevations: [null] } : { coords: [], elevations: [] }
  }
  for (const segment of state.segments) {
    const geometry = segmentGeometry(segment, state)
    if (geometry.coords.length === 0) continue
    // Skip the first point when it repeats the previous segment's last.
    const skipFirst =
      coords.length > 0 &&
      haversineM(
        coords[coords.length - 1][0],
        coords[coords.length - 1][1],
        geometry.coords[0][0],
        geometry.coords[0][1]
      ) < 1
    for (let i = skipFirst ? 1 : 0; i < geometry.coords.length; i++) {
      coords.push(geometry.coords[i])
      elevations.push(geometry.elevations[i] ?? null)
    }
  }
  return { coords, elevations }
}

/**
 * A loop's return leg, from the last point back to the start - or null when
 * the route isn't a loop, has fewer than two points, or already ends on its
 * start (routing a leg of a few metres would only add a spur).
 */
export function returnLeg(state: PlannerState): RoutedSegment | null {
  if (state.shape !== "loop") return null
  const anchors = plannerAnchors(state)
  if (anchors.length < 2) return null
  const last = anchors[anchors.length - 1]
  const first = anchors[0]
  if (haversineM(last[0], last[1], first[0], first[1]) < ANCHOR_SNAP_M) return null
  return { kind: "routed", from: last, to: first }
}

/** Just the part the shape adds after the last point - empty for one-way. */
function returnGeometry(state: PlannerState, outbound: PlannerGeometry): PlannerGeometry {
  if (state.shape === "out-and-back" && outbound.coords.length >= 2) {
    // Back the way it came: everything before the turnaround, reversed.
    return {
      coords: outbound.coords.slice(0, -1).reverse(),
      elevations: outbound.elevations.slice(0, -1).reverse(),
    }
  }
  const returning = returnLeg(state)
  if (!returning) return { coords: [], elevations: [] }
  const geometry = segmentGeometry(returning, state)
  // Its first point is the last point of the outbound route.
  return { coords: geometry.coords.slice(1), elevations: geometry.elevations.slice(1) }
}

/**
 * The whole route as ridden: the outbound geometry plus whatever the shape
 * adds (a loop's return leg, an out-and-back's way back). This is what the
 * map draws, what's exported, and what distances and POI searches measure.
 */
export function plannerGeometry(state: PlannerState): PlannerGeometry {
  const outbound = outboundGeometry(state)
  const returning = returnGeometry(state, outbound)
  return {
    coords: [...outbound.coords, ...returning.coords],
    elevations: [...outbound.elevations, ...returning.elevations],
  }
}

/** Length of the part the shape adds after the last point - null for one-way. */
export function plannerReturnDistanceM(state: PlannerState): number | null {
  if (state.shape === "one-way") return null
  const outbound = outboundGeometry(state)
  const returning = returnGeometry(state, outbound)
  if (returning.coords.length === 0) return null
  return totalDistanceM([outbound.coords[outbound.coords.length - 1], ...returning.coords])
}

/**
 * Switches what happens after the last point. A loop or out-and-back needs at
 * least two points - with only a start there's nowhere to come back from.
 */
export function setRouteShape(state: PlannerState, shape: RouteShape): PlannerResult {
  if (shape === state.shape) return { ok: true, state }
  if (shape !== "one-way" && plannerAnchors(state).length < 2) {
    return { ok: false, error: "Add at least two points first." }
  }
  return guardCaps({ ...state, shape })
}

/**
 * The draggable points: the start, then each segment's end. A `fixed`
 * segment contributes only its endpoints - its interior is imported
 * geometry, not something the visitor placed.
 *
 * The indexing this produces is what every edit operation is written
 * against: anchor 0 is segments[0]'s start, and anchor i>0 is both
 * segments[i-1]'s end and segments[i]'s start.
 */
export function plannerAnchors(state: PlannerState): LatLon[] {
  if (state.start === null) return []
  const anchors: LatLon[] = [state.start]
  for (const segment of state.segments) {
    const { coords } = segmentGeometry(segment, state)
    if (coords.length === 0) continue
    anchors.push(coords[coords.length - 1])
  }
  return anchors
}

/**
 * How many leading coordinates two versions of a route share. Edits that
 * don't come with their own notion of "what changed" (deleting a point,
 * undo/redo) use this to re-search POIs only past the unchanged prefix - and
 * not at all when the new route is just a prefix of the old one, since a
 * route that only shrank covers no new ground.
 */
export function commonPrefixLength(a: LatLon[], b: LatLon[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i][0] === b[i][0] && a[i][1] === b[i][1]) i++
  return i
}

/**
 * Distance along the route of each segment - i.e. from each point to the
 * next, index-aligned with segments (segment i runs from anchor i to i+1).
 * A leg still being routed counts as its straight-line placeholder.
 */
export function plannerLegDistancesM(state: PlannerState): number[] {
  return state.segments.map((segment) => totalDistanceM(segmentGeometry(segment, state).coords))
}

export function plannerDistanceM(state: PlannerState): number {
  return totalDistanceM(plannerGeometry(state).coords)
}

export type PlannerResult =
  | { ok: true; state: PlannerState }
  | { ok: false; error: string }

export type TrimResult =
  | {
      ok: true
      state: PlannerState
      // Polyline segment indices that kept their numbering through the trim
      // - feeds updateDistancesAfterTrim's cheap path.
      survivingSegmentRange: { start: number; end: number }
      startMoved: boolean
    }
  | { ok: false; error: string }

function guardCaps(state: PlannerState): PlannerResult {
  if (plannerAnchors(state).length > MAX_ANCHORS) {
    return { ok: false, error: `A planned route can have at most ${MAX_ANCHORS} points.` }
  }
  const distanceM = plannerDistanceM(state)
  if (distanceM > MAX_ROUTE_DISTANCE_M) {
    return {
      ok: false,
      error: `A planned route can be at most ${MAX_ROUTE_DISTANCE_M / 1000}km long.`,
    }
  }
  return { ok: true, state }
}

export function appendAnchor(state: PlannerState, point: LatLon): PlannerResult {
  const anchors = plannerAnchors(state)
  if (anchors.length === 0) {
    // The very first click just places the start; there is nothing to route
    // to until a second point exists.
    return guardCaps({ ...state, start: point })
  }
  const last = anchors[anchors.length - 1]
  if (haversineM(last[0], last[1], point[0], point[1]) < ANCHOR_SNAP_M) {
    return { ok: false, error: "That point is already the end of the route." }
  }
  return guardCaps({
    ...state,
    segments: [...state.segments, { kind: "routed", from: last, to: point }],
  })
}

export function prependAnchor(state: PlannerState, point: LatLon): PlannerResult {
  const anchors = plannerAnchors(state)
  if (anchors.length === 0) return appendAnchor(state, point)
  const first = anchors[0]
  if (haversineM(first[0], first[1], point[0], point[1]) < ANCHOR_SNAP_M) {
    return { ok: false, error: "That point is already the start of the route." }
  }
  return guardCaps({
    ...state,
    start: point,
    segments: [{ kind: "routed", from: point, to: first }, ...state.segments],
  })
}

/**
 * What the route's first or last anchor is attached to, or null when there
 * is no route yet.
 *
 * This is the distinction the endpoint drag behaviour keys off - not
 * "imported vs drawn". An endpoint next to a routed leg can simply move
 * (re-point that leg). An endpoint next to `fixed` geometry cannot: on a
 * pristine import that single segment spans the entire route, so "moving"
 * it would replace the whole imported track with one routed leg. Those
 * extend or trim instead (see App.tsx's handleMoveEndpoint).
 */
export function endpointNeighbourKind(
  state: PlannerState,
  which: "start" | "end"
): Segment["kind"] | null {
  if (state.segments.length === 0) return null
  return which === "start"
    ? state.segments[0].kind
    : state.segments[state.segments.length - 1].kind
}

function segmentStart(segment: Segment): LatLon {
  return segment.kind === "fixed" ? segment.coords[0] : segment.from
}

function segmentEnd(segment: Segment): LatLon {
  return segment.kind === "fixed" ? segment.coords[segment.coords.length - 1] : segment.to
}

/** Endpoints of a `fixed` segment, which are also its only anchors. */
function fixedSegmentEnds(segment: FixedSegment): { from: LatLon; to: LatLon } {
  return { from: segment.coords[0], to: segment.coords[segment.coords.length - 1] }
}

/**
 * Moves the anchor at `anchorIndex` (an index into plannerAnchors) and
 * re-points only the segments touching it - which is why dragging a middle
 * anchor costs two routing requests rather than a whole recompute.
 *
 * An adjacent `fixed` segment is converted to a routed one pinned to the
 * moved point: imported geometry can't survive one of its ends moving, but
 * the loss is bounded to that one stretch. Splitting an import first (see
 * insertAnchorAt) is what lets a visitor keep that bound small.
 *
 * Still refuses when the anchor is an *endpoint* whose neighbour is fixed -
 * there the affected stretch is the whole import, so the caller extends or
 * trims instead.
 */
export function moveAnchor(state: PlannerState, anchorIndex: number, point: LatLon): PlannerResult {
  const anchors = plannerAnchors(state)
  if (anchorIndex < 0 || anchorIndex >= anchors.length) {
    return { ok: false, error: "No such route point." }
  }
  // Anchor i ends segment i-1 and starts segment i (see plannerAnchors).
  const before = state.segments[anchorIndex - 1]
  const after = state.segments[anchorIndex]
  const isEndpoint = before === undefined || after === undefined
  if (isEndpoint && (before?.kind === "fixed" || after?.kind === "fixed")) {
    return { ok: false, error: "That point belongs to the imported route - trim it instead." }
  }

  const segments = state.segments.map((segment, i): Segment => {
    if (i !== anchorIndex - 1 && i !== anchorIndex) return segment
    const movingIsSegmentEnd = i === anchorIndex - 1
    if (segment.kind === "routed") {
      return movingIsSegmentEnd ? { ...segment, to: point } : { ...segment, from: point }
    }
    // Converting fixed -> routed: keep the far end where it is, and drop
    // this segment's imported geometry (BRouter supplies the replacement,
    // elevation included).
    const ends = fixedSegmentEnds(segment)
    return movingIsSegmentEnd
      ? { kind: "routed", from: ends.from, to: point }
      : { kind: "routed", from: point, to: ends.to }
  })
  // Moving anchor 0 moves the route's start as well as segment 0's origin.
  return guardCaps({ ...state, start: anchorIndex === 0 ? point : state.start, segments })
}

export type InsertResult =
  | { ok: true; state: PlannerState; anchorIndex: number }
  | { ok: false; error: string }

/**
 * Splits the segment containing `distanceFromStartM` in two, making the
 * split point a new anchor. Returns its index in plannerAnchors so the
 * caller can move it immediately (that's the drag-the-line gesture: split
 * where you grabbed, then move to where you dropped).
 *
 * A `fixed` segment splits into two `fixed` halves, so a bare insert on an
 * imported route costs no routing calls and changes no coordinates at all -
 * which is what makes an import safe to start editing.
 */
export function insertAnchorAt(state: PlannerState, distanceFromStartM: number): InsertResult {
  if (state.segments.length === 0) return { ok: false, error: "There's no route to add a point to." }

  // Find the segment holding that distance, and how far into it the split
  // falls. Segment lengths come from the same geometry the caller measured
  // distanceFromStartM against, so the two always agree.
  let cumulativeM = 0
  for (let i = 0; i < state.segments.length; i++) {
    const segment = state.segments[i]
    const { coords, elevations } = segmentGeometry(segment, state)
    const segmentLengthM = totalDistanceM(coords)
    const isLast = i === state.segments.length - 1
    if (!isLast && cumulativeM + segmentLengthM <= distanceFromStartM) {
      cumulativeM += segmentLengthM
      continue
    }

    const intoSegmentM = distanceFromStartM - cumulativeM
    // Walk to the nearest coordinate index at that offset. Splitting on an
    // existing vertex (rather than interpolating) keeps a fixed split exactly
    // lossless - no synthesised coordinate enters the geometry.
    let walkedM = 0
    let splitIndex = 0
    for (let j = 0; j < coords.length - 1; j++) {
      const stepM = haversineM(coords[j][0], coords[j][1], coords[j + 1][0], coords[j + 1][1])
      if (walkedM + stepM >= intoSegmentM) {
        splitIndex = walkedM + stepM - intoSegmentM < intoSegmentM - walkedM ? j + 1 : j
        break
      }
      walkedM += stepM
      splitIndex = j + 1
    }
    if (splitIndex <= 0 || splitIndex >= coords.length - 1) {
      return { ok: false, error: "That's too close to an existing point." }
    }

    const splitPoint = coords[splitIndex]
    const halves: Segment[] =
      segment.kind === "fixed"
        ? [
            { kind: "fixed", coords: coords.slice(0, splitIndex + 1), elevations: elevations.slice(0, splitIndex + 1) },
            { kind: "fixed", coords: coords.slice(splitIndex), elevations: elevations.slice(splitIndex) },
          ]
        : [
            { kind: "routed", from: segment.from, to: splitPoint },
            { kind: "routed", from: splitPoint, to: segment.to },
          ]

    const next = guardCaps({
      ...state,
      segments: [...state.segments.slice(0, i), ...halves, ...state.segments.slice(i + 1)],
    })
    if (!next.ok) return next
    // Anchor 0 is the start and anchor i+1 ends segment i, so the new
    // anchor - which ends the first half, at segment index i - is i + 1.
    return { ok: true, state: next.state, anchorIndex: i + 1 }
  }

  return { ok: false, error: "That point isn't on the route." }
}

/**
 * Deletes the anchor at `anchorIndex` (an index into plannerAnchors).
 *
 * - An interior anchor merges the two segments it joins. Two `fixed`
 *   neighbours rejoin into one `fixed` segment, byte-identical to before the
 *   anchor was inserted (the inverse of insertAnchorAt's split), so no
 *   routing is needed. Otherwise the merged stretch becomes one `routed` leg
 *   between the neighbouring anchors - the imported geometry on a `fixed`
 *   side can't survive losing one of its ends, but the loss is bounded to
 *   that stretch, as with moveAnchor.
 * - An endpoint drops the segment it bounds. Refused when that segment is
 *   `fixed`: on a pristine import it spans the whole route, so deleting the
 *   start would delete the entire track (trimming is the tool for that).
 * - The last remaining anchor clears the route.
 */
export function removeAnchor(state: PlannerState, anchorIndex: number): PlannerResult {
  const anchors = plannerAnchors(state)
  if (anchorIndex < 0 || anchorIndex >= anchors.length) {
    return { ok: false, error: "No such route point." }
  }
  if (anchors.length === 1) return { ok: true, state: { ...state, start: null, segments: [], shape: "one-way" } }
  // Down to a single point, there's no loop or out-and-back left to ride.
  const shape: RouteShape = anchors.length === 2 ? "one-way" : state.shape

  // Anchor i ends segment i-1 and starts segment i (see plannerAnchors).
  const before = state.segments[anchorIndex - 1]
  const after = state.segments[anchorIndex]

  if (before === undefined || after === undefined) {
    const bounded = before ?? after
    if (bounded.kind === "fixed") {
      return { ok: false, error: "That point belongs to the imported route - trim it instead." }
    }
    if (anchorIndex > 0) return { ok: true, state: { ...state, shape, segments: state.segments.slice(0, -1) } }
    const rest = state.segments.slice(1)
    // The next segment's own origin, not plannerAnchors' reading of it, so
    // the start stays in step with that segment's leg cache key.
    const nextStart = rest.length === 0 ? anchors[1] : segmentStart(rest[0])
    return { ok: true, state: { ...state, shape, start: nextStart, segments: rest } }
  }

  const merged: Segment =
    before.kind === "fixed" && after.kind === "fixed"
      ? {
          kind: "fixed",
          // The shared joint point appears in both; keep it once.
          coords: [...before.coords, ...after.coords.slice(1)],
          elevations: [...before.elevations, ...after.elevations.slice(1)],
        }
      : // The neighbours' own far ends (as moveAnchor does), not the
        // snapped points plannerAnchors reports, so unchanged legs elsewhere
        // keep matching their cached geometry.
        { kind: "routed", from: segmentStart(before), to: segmentEnd(after) }
  const segments = [
    ...state.segments.slice(0, anchorIndex - 1),
    merged,
    ...state.segments.slice(anchorIndex + 1),
  ]
  // Merging can only shorten a routed stretch or restore imported geometry,
  // but a merged routed leg could in principle route longer than the two it
  // replaces - so the distance cap still applies.
  return guardCaps({ ...state, segments })
}

/**
 * Splits the route at `distanceFromStartM` and keeps one side.
 *
 * Both sides of a split fall inside a single segment, so the result is that
 * segment sliced (fixed) or dropped/replaced (routed), plus every segment
 * wholly on the kept side. A routed segment cut partway through becomes a
 * fixed segment holding the kept part of its geometry - the cut point is no
 * longer an anchor the visitor placed, and re-routing to it would move the
 * line they just trimmed.
 */
function trim(state: PlannerState, distanceFromStartM: number, keep: "before" | "after"): TrimResult {
  const { coords, elevations } = outboundGeometry(state)
  if (coords.length < 2) return { ok: false, error: "Nothing to trim." }

  // Walk the concatenated polyline to find the cut index.
  let cumulativeM = 0
  let cutIndex = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const stepM = haversineM(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
    if (cumulativeM + stepM >= distanceFromStartM) {
      cutIndex = cumulativeM + stepM - distanceFromStartM < distanceFromStartM - cumulativeM ? i + 1 : i
      break
    }
    cumulativeM += stepM
    cutIndex = i + 1
  }

  const keptCoords = keep === "before" ? coords.slice(0, cutIndex + 1) : coords.slice(cutIndex)
  const keptElevations =
    keep === "before" ? elevations.slice(0, cutIndex + 1) : elevations.slice(cutIndex)
  if (keptCoords.length < 2) return { ok: false, error: "That would leave no route." }

  // Collapse to a single fixed segment: the kept geometry is now settled,
  // and the trim point is not an anchor the visitor placed.
  return {
    ok: true,
    state: {
      ...state,
      start: keptCoords[0],
      segments: [{ kind: "fixed", coords: keptCoords, elevations: keptElevations }],
    },
    // Trimming the end preserves polyline segment numbering for everything
    // kept (0..cutIndex-1); trimming the start shifts every index and every
    // distance-from-start, which is what startMoved tells the distance
    // updater below.
    survivingSegmentRange: { start: 0, end: cutIndex - 1 },
    startMoved: keep === "after",
  }
}

export function trimStart(state: PlannerState, distanceFromStartM: number): TrimResult {
  return trim(state, distanceFromStartM, "after")
}

export function trimEnd(state: PlannerState, distanceFromStartM: number): TrimResult {
  return trim(state, distanceFromStartM, "before")
}

// -- Incremental distance updates -----------------------------------------
//
// Every edit changes the polyline in one direction only, which makes an
// exact update possible without re-measuring every point against the whole
// route:
//
//   trim   - the route only shrinks, so distances can only INCREASE. A point
//            whose nearest segment survived the trim keeps its exact cached
//            value; only points that were nearest the removed part move.
//   extend - the route only grows, so distances can only DECREASE. Measuring
//            against the new geometry alone and taking the smaller of the two
//            is exact.
//
// This exists for immediate feedback - the off-route confirmation has to open
// without a network round trip. The backend's own numbers still win once a
// re-search returns them.

export interface Positioned {
  lat: number
  lon: number
  distanceFromRouteM: number
  distanceFromStartM: number
  nearestSegmentIndex: number
}

function reproject<T extends Positioned>(item: T, route: LatLon[]): T {
  const projection = projectOntoPolylineM([item.lat, item.lon], route)
  return {
    ...item,
    distanceFromRouteM: projection.distanceFromRouteM,
    distanceFromStartM: projection.distanceFromStartM,
    nearestSegmentIndex: projection.nearestSegmentIndex,
  }
}

/**
 * After a trim, only points whose nearest segment was removed can have
 * moved. `removedSegmentIndices` is the set of old segment indices no longer
 * present; everything else keeps its cached value untouched.
 *
 * Note distanceFromStartM shifts for every point when the route's *start*
 * moves, so a start-side trim reprojects everything - only an end-side trim
 * gets the cheap path.
 */
export function updateDistancesAfterTrim<T extends Positioned>(
  items: T[],
  newRoute: LatLon[],
  survivingSegmentRange: { start: number; end: number },
  startMoved: boolean
): T[] {
  if (startMoved) return items.map((item) => reproject(item, newRoute))
  return items.map((item) => {
    const stillOnRoute =
      item.nearestSegmentIndex >= survivingSegmentRange.start &&
      item.nearestSegmentIndex <= survivingSegmentRange.end
    return stillOnRoute ? item : reproject(item, newRoute)
  })
}

/**
 * After an extend, a point's distance can only have decreased, so it's
 * enough to measure against the newly added geometry and keep whichever
 * value is smaller. Points outside the new geometry's padded bounding box
 * cannot have improved and are skipped entirely.
 *
 * `startMoved` again forces a full reprojection, since prepending geometry
 * shifts every distanceFromStartM.
 */
export function updateDistancesAfterExtend<T extends Positioned>(
  items: T[],
  newRoute: LatLon[],
  addedCoords: LatLon[],
  startMoved: boolean
): T[] {
  if (startMoved) return items.map((item) => reproject(item, newRoute))

  // Unpadded once; each item then tests against a box grown by its own
  // current distance, since that is exactly how much closer the new geometry
  // would have to be to matter. Padding by the whole set's maximum instead
  // would make the prefilter almost useless whenever one point is far away.
  const rawBox = bboxOfCoords(addedCoords, 0)
  if (!rawBox) return items

  return items.map((item) => {
    const reach = item.distanceFromRouteM
    const box = bboxOfCoords(
      [
        [rawBox.minLat, rawBox.minLon],
        [rawBox.maxLat, rawBox.maxLon],
      ],
      reach
    )!
    if (!isInBbox([item.lat, item.lon], box)) return item
    const candidate = projectOntoPolylineM([item.lat, item.lon], addedCoords)
    if (candidate.distanceFromRouteM >= item.distanceFromRouteM) return item
    // It got closer, so its position along the route changed too - measure
    // that against the full new route rather than the added fragment.
    return reproject(item, newRoute)
  })
}

/** Items now further than `thresholdM` from the route. */
export function offRouteItems<T extends Positioned>(items: T[], thresholdM: number): T[] {
  return items.filter((item) => item.distanceFromRouteM > thresholdM)
}

// Positions of everything pinned to the route (pre-existing waypoints and
// found candidates alike), carried across edits so the incremental update
// has a previous value to improve on. Keyed "w:<index>" / "c:<osmId>" -
// App.tsx owns the two id spaces, this module only needs them to stay
// distinct.
export type TrackedPositions = Record<string, Positioned>

export function trackPositions(
  entries: { key: string; lat: number; lon: number }[],
  route: LatLon[]
): TrackedPositions {
  const tracked: TrackedPositions = {}
  for (const entry of entries) {
    const projection = projectOntoPolylineM([entry.lat, entry.lon], route)
    tracked[entry.key] = {
      lat: entry.lat,
      lon: entry.lon,
      distanceFromRouteM: projection.distanceFromRouteM,
      distanceFromStartM: projection.distanceFromStartM,
      nearestSegmentIndex: projection.nearestSegmentIndex,
    }
  }
  return tracked
}

function fromEntries(keys: string[], values: Positioned[]): TrackedPositions {
  const next: TrackedPositions = {}
  keys.forEach((key, i) => {
    next[key] = values[i]
  })
  return next
}

export function trackedAfterTrim(
  tracked: TrackedPositions,
  newRoute: LatLon[],
  survivingSegmentRange: { start: number; end: number },
  startMoved: boolean
): TrackedPositions {
  const keys = Object.keys(tracked)
  return fromEntries(
    keys,
    updateDistancesAfterTrim(
      keys.map((k) => tracked[k]),
      newRoute,
      survivingSegmentRange,
      startMoved
    )
  )
}

export function trackedAfterExtend(
  tracked: TrackedPositions,
  newRoute: LatLon[],
  addedCoords: LatLon[],
  startMoved: boolean
): TrackedPositions {
  const keys = Object.keys(tracked)
  return fromEntries(
    keys,
    updateDistancesAfterExtend(
      keys.map((k) => tracked[k]),
      newRoute,
      addedCoords,
      startMoved
    )
  )
}

/**
 * Moves the anchor at `from` to position `to` in the point order (the
 * point-list drag), re-pointing the route through the new order.
 *
 * A pair of anchors that stays consecutive, in the same direction, keeps its
 * segment as-is - routed geometry already fetched, or imported geometry
 * verbatim. Every new pair becomes a `routed` leg.
 *
 * Refused when it would break up a `fixed` segment: on a pristine import
 * that one segment is the whole track, so e.g. swapping its start and end
 * would replace an entire imported route with a single routed leg. Imported
 * stretches keep their order; moving points on the map is the tool there.
 */
export function reorderAnchors(state: PlannerState, from: number, to: number): PlannerResult {
  const anchors = plannerAnchors(state)
  if (from < 0 || from >= anchors.length || to < 0 || to >= anchors.length) {
    return { ok: false, error: "No such route point." }
  }
  if (from === to) return { ok: true, state }

  const order = anchors.map((_, i) => i)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)

  const segments: Segment[] = []
  for (let k = 0; k < order.length - 1; k++) {
    const a = order[k]
    const b = order[k + 1]
    // Segment a runs from anchor a to anchor a+1 (see plannerAnchors).
    segments.push(b === a + 1 ? state.segments[a] : { kind: "routed", from: anchors[a], to: anchors[b] })
  }

  const kept = new Set(segments)
  if (state.segments.some((segment) => segment.kind === "fixed" && !kept.has(segment))) {
    return { ok: false, error: "Imported parts of the route keep their order - move points on the map instead." }
  }

  const start = segments.length > 0 ? segmentStart(segments[0]) : anchors[order[0]]
  return guardCaps({ ...state, start, segments })
}
