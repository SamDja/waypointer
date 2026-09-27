import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { WahooLogo } from "@/components/FitnessAppLogos"
import { track } from "@/lib/analytics"
import { toast, updateToast } from "@/lib/toast"
import { revokeWahooAccess } from "@/lib/wahooApi"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { clearWahooTokens, getValidWahooAccessToken, type WahooTokens } from "@/lib/wahooSettings"
import { Link, Unlink } from "lucide-react"

export interface FitnessAppsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
}

// One row per app a visitor can connect. Only Wahoo exists today; Strava,
// Garmin and the rest join this list, each bringing its own connect and
// disconnect, and the dialog around them doesn't change.
interface FitnessAppRow {
  key: string
  name: string
  logo: ReactNode
  // null while not connected; "" when connected but the account's name
  // couldn't be read.
  account: string | null
  busy: boolean
  onConnect: () => void
  onDisconnect: () => void
}

// Both "Connect your fitness apps" and the menu's "Manage fitness apps" open
// this: connected apps can be disconnected, the others connected.
export function FitnessAppsDialog({ open, onOpenChange, wahooTokens, onWahooTokensChange }: FitnessAppsDialogProps) {
  const [wahooBusy, setWahooBusy] = useState(false)

  async function handleConnectWahoo() {
    setWahooBusy(true)
    const toastId = toast("Connecting to Wahoo...", "loading")
    track("wahoo_connect_initiated", { source: "fitness_apps" })
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      updateToast(toastId, scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null ? "error" : "success")
      track("wahoo_connect_succeeded", { source: "fitness_apps" })
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Wahoo.", "error")
      track("wahoo_connect_failed", { source: "fitness_apps" })
    } finally {
      setWahooBusy(false)
    }
  }

  async function handleDisconnectWahoo() {
    setWahooBusy(true)
    const toastId = toast("Disconnecting from Wahoo...", "loading")
    try {
      // Revoke server-side before forgetting the token locally - Wahoo caps
      // unrevoked tokens per app+user, so merely dropping it from
      // localStorage leaves it live on their end and eventually exhausts
      // that cap. Clear local state regardless of whether revoke succeeds
      // (e.g. the token's already expired/invalid) so the user isn't stuck
      // "connected".
      try {
        const accessToken = await getValidWahooAccessToken()
        await revokeWahooAccess(accessToken)
      } catch {
        // best-effort
      }
      clearWahooTokens()
      onWahooTokensChange(null)
      updateToast(toastId, "Disconnected from Wahoo.", "success")
    } finally {
      setWahooBusy(false)
    }
  }

  const apps: FitnessAppRow[] = [
    {
      key: "wahoo",
      name: "Wahoo",
      logo: <WahooLogo className="h-4 w-auto" />,
      account: wahooTokens ? (wahooTokens.athleteLabel ?? "") : null,
      busy: wahooBusy,
      onConnect: handleConnectWahoo,
      onDisconnect: handleDisconnectWahoo,
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Your fitness apps</DialogTitle>
          <DialogDescription>
            Sync the routes you create in Sulla Via with your favourite devices!
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {apps.map((app) => (
            <li key={app.key} className="flex items-center gap-3 rounded-md border p-3">
              <span className="flex w-20 shrink-0 items-center">{app.logo}</span>
              <span className="min-w-0 flex-1 text-sm">
                {app.account === null ? (
                  <span className="flex flex-row gap-2 items-center text-muted-foreground"><Unlink size={12}/>Not connected</span>
                ) : (
                  <>
                    <span className="flex flex-row gap-2 items-center text-green-700"><Link size={12} /> Connected</span>
                    {app.account && <span className="block truncate font-medium">{app.account}</span>}
                  </>
                )}
              </span>
              {app.account === null ? (
                <Button size="sm" loading={app.busy} onClick={app.onConnect}>
                  Connect
                </Button>
              ) : (
                <Button size="sm" variant="outline" loading={app.busy} onClick={app.onDisconnect}>
                  Disconnect
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
