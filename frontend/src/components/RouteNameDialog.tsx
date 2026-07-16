import { useEffect, useState, type SubmitEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface RouteNameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultName: string
  confirmLabel: string
  onConfirm: (name: string) => void
}

// Generic "name your route" confirmation step, shared by both the download
// and Send-to-Wahoo actions - kept minimal (a single field) but structured
// as its own component/form so more fields can be added later without
// restructuring either caller.
export function RouteNameDialog({
  open,
  onOpenChange,
  defaultName,
  confirmLabel,
  onConfirm,
}: RouteNameDialogProps) {
  const [name, setName] = useState(defaultName)

  // Re-seed from defaultName each time the dialog opens, rather than only
  // on mount - the same dialog instance is reused across repeated opens.
  useEffect(() => {
    if (open) setName(defaultName)
  }, [open, defaultName])

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    onConfirm(name.trim() || defaultName)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Name your route</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="route-name">Route name</Label>
            <Input
              id="route-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <Button type="submit" className="w-fit">
            {confirmLabel}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
