import { useState } from "react"
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
import { Button } from "@/components/ui/button"
import { Trash2Icon } from "lucide-react"

export interface RemoveRouteButtonProps {
  onRemove: () => void
}

// Removing a route clears every selection and search result with it, so it's
// always confirmed first - from ImportCard and from PlannerPanel alike.
export function RemoveRouteButton({ onRemove }: RemoveRouteButtonProps) {
  const [showConfirm, setShowConfirm] = useState(false)

  return (
    <>
      <Button variant="destructive" className="w-fit" onClick={() => setShowConfirm(true)}>
        <Trash2Icon className="size-4" />
        Remove route
      </Button>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this route?</AlertDialogTitle>
            <AlertDialogDescription>Your POI selections and search results will be cleared too.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove} className="bg-red-600 text-white hover:bg-red-700">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
