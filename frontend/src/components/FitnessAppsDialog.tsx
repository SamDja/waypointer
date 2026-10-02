import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FitnessAppsList, type FitnessAppsListProps } from "@/components/FitnessAppsList"

export interface FitnessAppsDialogProps extends FitnessAppsListProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Step 2's "Connect a fitness app to import a route" - the same list as
// the account settings' "Fitness apps" section, on its own, so connecting
// doesn't mean leaving the step for the settings.
export function FitnessAppsDialog({ open, onOpenChange, onSignIn, ...list }: FitnessAppsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Your fitness apps</DialogTitle>
          <DialogDescription>Sync the routes you create in Sulla Via with your favourite devices!</DialogDescription>
        </DialogHeader>
        <FitnessAppsList
          {...list}
          onSignIn={() => {
            onOpenChange(false)
            onSignIn()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
