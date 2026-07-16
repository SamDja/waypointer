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
      {/* z-[1150]/1151 - a tier above the base Dialog (z-[1100]/1101, see
          dialog.tsx) since this can be opened nested on top of another
          already-open Dialog (e.g. WahooRoutesDialog's rename flow) - without
          this, CSS z-index ties would let that outer Dialog's opaque content
          paint over this one's overlay, hiding the dimmed backdrop (same bug
          fixed for alert-dialog.tsx, which sits one tier higher still since
          it can in turn confirm on top of this dialog). */}
      <DialogContent className="z-[1151]" overlayClassName="z-[1150]">
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
