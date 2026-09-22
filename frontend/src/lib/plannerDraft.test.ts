import { describe, expect, it } from "vitest"
import { DRAFT_VERSION, clearDraft, loadDraft, saveDraft } from "@/lib/plannerDraft"
import { appendAnchor, emptyPlannerState, moveAnchor, withLeg, type LatLon, type PlannerState } from "@/lib/routePlanner"

/** A minimal in-memory Storage; setting `quota` (characters) makes setItem throw like a full localStorage. */
function memoryStorage(): Storage & { quota: number } {
  const data = new Map<string, string>()
  return {
    quota: Infinity,
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem(key, value) {
      if (value.length > this.quota) throw new DOMException("quota", "QuotaExceededError")
      data.set(key, value)
    },
  }
}

const a: LatLon = [45.0, 7.0]
const b: LatLon = [45.0, 7.01]
const leg = { coords: [a, b], elevations: [1, 2], distanceM: 790 }

function planned(): PlannerState {
  let state = emptyPlannerState("fastbike")
  state = (appendAnchor(state, a) as { state: PlannerState }).state
  state = (appendAnchor(state, b) as { state: PlannerState }).state
  return withLeg(state, a, b, leg)
}

const draftOf = (state: PlannerState) => ({ state, mode: "new" as const, filename: "Planned route.gpx", sourceGpx: null })

describe("planner draft", () => {
  it("round-trips a plan, routed geometry included", () => {
    const store = memoryStorage()
    expect(saveDraft(draftOf(planned()), store)).toBe("saved")
    const draft = loadDraft(store)
    expect(draft?.version).toBe(DRAFT_VERSION)
    expect(draft?.state.segments).toEqual(planned().segments)
    expect(Object.values(draft?.state.legs ?? {})).toEqual([leg])
  })

  it("keeps only the legs the route still uses", () => {
    // Drag the end somewhere and back: the cache now also holds the detour's leg.
    const detour = moveAnchor(planned(), 1, [45.1, 7.01]) as { state: PlannerState }
    let state = withLeg(detour.state, a, [45.1, 7.01], leg)
    state = (moveAnchor(state, 1, b) as { state: PlannerState }).state
    expect(Object.keys(state.legs)).toHaveLength(2)

    const store = memoryStorage()
    saveDraft(draftOf(state), store)
    expect(Object.keys(loadDraft(store)?.state.legs ?? {})).toHaveLength(1)
  })

  it("reports a draft too big for storage, and leaves no stale older one behind", () => {
    const store = memoryStorage()
    expect(saveDraft(draftOf(planned()), store)).toBe("saved")
    // The route grows past the quota: the save fails, and the earlier,
    // now-outdated draft must not be offered back later as if it were current.
    store.quota = 10
    expect(saveDraft(draftOf(planned()), store)).toBe("too-big")
    expect(loadDraft(store)).toBeNull()
  })

  it("ignores a draft from another version or one that isn't a draft", () => {
    const store = memoryStorage()
    store.setItem("waypointer.plannerDraft", JSON.stringify({ version: DRAFT_VERSION + 1, state: planned() }))
    expect(loadDraft(store)).toBeNull()
    store.setItem("waypointer.plannerDraft", "not json")
    expect(loadDraft(store)).toBeNull()
  })

  it("clears the draft", () => {
    const store = memoryStorage()
    saveDraft(draftOf(planned()), store)
    clearDraft(store)
    expect(loadDraft(store)).toBeNull()
  })
})
