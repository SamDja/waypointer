import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PROVIDER_NAMES } from "@/lib/connections"
import { MAP_STYLES } from "@/lib/mapStyles"
import type { ImportOutcome, LocalDataOffer } from "@/lib/useAccountData"

export interface ImportLocalDataDialogProps {
  offer: LocalDataOffer | null
  onAccept: () => Promise<ImportOutcome>
  onDismiss: () => void
}

function activityLabel(styleKey: string): string {
  return MAP_STYLES.find((s) => s.key === styleKey)?.label ?? styleKey
}

// Shown once after signing in on a browser that still holds things from
// before accounts existed: connected fitness apps and per-activity speeds.
// Moving them makes the account the one place they live, so they follow
// the visitor to any device.
export function ImportLocalDataDialog({ offer, onAccept, onDismiss }: ImportLocalDataDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState<string[] | null>(null)

  async function handleAccept() {
    setBusy(true)
    setError(null)
    try {
      const { failed } = await onAccept()
      if (failed.length > 0) setExpired(failed.map((p) => PROVIDER_NAMES[p]))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move everything - please try again.")
    } finally {
      setBusy(false)
    }
  }

  const speeds = offer ? Object.entries(offer.avgSpeedKmh) : []
  // After accepting, the offer is gone but an expired app still has to be
  // explained before the dialog closes.
  const open = offer !== null || expired !== null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        if (expired) setExpired(null)
        else onDismiss()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move this browser's data to your account?</DialogTitle>
          <DialogDescription>
            This browser still has a few things from before you signed in. Moved to your account, they'll be there on
            every device you use Sulla Via on.
          </DialogDescription>
        </DialogHeader>

        {expired ? (
          <Callout variant="warning">
            Your {expired.join(" and ")} connection had expired, so it couldn't be moved - connect it again from
            your account settings.
          </Callout>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {offer?.connections.map((c) => (
              <li key={c.provider}>
                Your {PROVIDER_NAMES[c.provider]} connection{c.label ? ` (${c.label})` : ""}
              </li>
            ))}
            {speeds.map(([style, speed]) => (
              <li key={style}>
                Your {activityLabel(style).toLowerCase()} speed: {speed} km/h
              </li>
            ))}
          </ul>
        )}
        {error && (
          <Callout variant="destructive" role="alert">
            {error}
          </Callout>
        )}

        <div className="flex justify-end gap-2">
          {expired ? (
            <Button onClick={() => setExpired(null)}>OK</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onDismiss} disabled={busy}>
                Not now
              </Button>
              <Button onClick={() => void handleAccept()} loading={busy}>
                Move to my account
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
