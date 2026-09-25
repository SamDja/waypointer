import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export interface ActivitySwitchConsequences {
  // The plan will be re-routed under the new activity's profile, so its
  // shape on the ground changes.
  reroutes: boolean
  // POIs were found against the old activity's types and distances.
  clearsPois: boolean
}

export interface ActivitySwitchDialogProps {
  // The activity being switched to, or null when nothing is pending.
  toLabel: string | null
  consequences: ActivitySwitchConsequences
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirms a switch of activity when there's work in progress to disturb.
 *
 * An activity isn't a map style: it carries the routing profile, the pace
 * and tolerances, and which POIs are worth looking for. Switching therefore
 * re-routes the plan and drops results found under the old one - which is
 * a lot to happen silently behind a picker that looks like a view toggle.
 * Only shown when something would actually be lost; with no route and no
 * results the switch is immediate.
 */
export function ActivitySwitchDialog({ toLabel, consequences, onConfirm, onCancel }: ActivitySwitchDialogProps) {
  const { reroutes, clearsPois } = consequences
  return (
    <AlertDialog open={toLabel !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to {toLabel}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <span>
                {toLabel} has its own routing, pace and points of interest, and they&apos;ll be applied to what
                you have open.
              </span>
              <ul className="list-disc pl-5">
                {reroutes && <li>Your route will be re-routed for {toLabel}, so its shape may change.</li>}
                {clearsPois && <li>The points of interest you&apos;ve found will be cleared.</li>}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Switch</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
