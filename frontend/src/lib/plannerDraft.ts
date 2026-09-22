// The route planner's in-progress plan, kept in localStorage so a reload or
// an accidentally closed tab doesn't lose it. Plain functions over a Storage
// (localStorage by default), like lib/settings.ts - no React.

import { withPrunedLegs, type PlannerState } from "@/lib/routePlanner"

const DRAFT_KEY = "waypointer.plannerDraft"
// Bumped whenever PlannerState's shape changes incompatibly: a draft from an
// older version is dropped rather than restored into a state it doesn't fit.
export const DRAFT_VERSION = 1

export interface PlannerDraft {
  version: number
  savedAt: number
  state: PlannerState
  // Whether the plan started from an empty map or from a loaded route.
  mode: "new" | "edit"
  // The route file's name, reused for the file the planner synthesizes.
  filename: string
  // The imported GPX's own text, when the plan started from one - restoring
  // re-parses it, so the import's <wpt> entries and waypointer: markers
  // survive into the synthesized file exactly as they would have.
  sourceGpx: string | null
}

export type SaveResult = "saved" | "too-big" | "unavailable"

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * Saves the draft, with the leg cache pruned to what the route uses (see
 * withPrunedLegs). "too-big" when the storage quota rejects it - a very long
 * import can exceed it - so the caller can say so quietly; "unavailable" when
 * storage is blocked. Never throws.
 */
export function saveDraft(draft: Omit<PlannerDraft, "version" | "savedAt">, store = storage()): SaveResult {
  if (!store) return "unavailable"
  const full: PlannerDraft = { ...draft, state: withPrunedLegs(draft.state), version: DRAFT_VERSION, savedAt: Date.now() }
  try {
    store.setItem(DRAFT_KEY, JSON.stringify(full))
    return "saved"
  } catch (err) {
    // A quota error leaves nothing stale behind: drop any older draft, which
    // would otherwise be offered back later as if it were this one.
    clearDraft(store)
    return err instanceof DOMException && (err.name === "QuotaExceededError" || err.code === 22) ? "too-big" : "unavailable"
  }
}

/** The saved draft, or null if there's none, it's unreadable, or it's from another version. */
export function loadDraft(store = storage()): PlannerDraft | null {
  if (!store) return null
  try {
    const raw = store.getItem(DRAFT_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw) as PlannerDraft
    if (draft?.version !== DRAFT_VERSION || !draft.state || !Array.isArray(draft.state.segments)) return null
    return draft
  } catch {
    return null
  }
}

export function clearDraft(store = storage()): void {
  try {
    store?.removeItem(DRAFT_KEY)
  } catch {
    // Nothing to clear if storage is blocked.
  }
}
