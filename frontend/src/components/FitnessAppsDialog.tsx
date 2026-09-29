import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StravaWordmark, WahooLogo } from "@/components/FitnessAppLogos"
import { track } from "@/lib/analytics"
import { missingStravaScopeWarning } from "@/lib/stravaAuth"
import { revokeStravaAccess } from "@/lib/stravaApi"
import { connectStrava } from "@/lib/stravaConnect"
import { clearStravaTokens, getValidStravaTokens, type StravaTokens } from "@/lib/stravaSettings"
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
  stravaTokens: StravaTokens | null
  onStravaTokensChange: (tokens: StravaTokens | null) => void
}

// One row per app a visitor can connect - Wahoo and Strava today; Garmin
// and the rest join this list, each bringing its own connect and
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
export function FitnessAppsDialog({
  open,
  onOpenChange,
  wahooTokens,
  onWahooTokensChange,
  stravaTokens,
  onStravaTokensChange,
}: FitnessAppsDialogProps) {
  const [wahooBusy, setWahooBusy] = useState(false)
  const [stravaBusy, setStravaBusy] = useState(false)

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

  async function handleConnectStrava() {
    setStravaBusy(true)
    const toastId = toast("Connecting to Strava...", "loading")
    track("strava_connect_initiated", { source: "fitness_apps" })
    try {
      const tokens = await connectStrava()
      onStravaTokensChange(tokens)
      const scopeWarning = missingStravaScopeWarning(tokens.scope ?? null)
      updateToast(toastId, scopeWarning ?? "Connected to Strava.", scopeWarning !== null ? "error" : "success")
      track("strava_connect_succeeded", { source: "fitness_apps" })
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Strava.", "error")
      track("strava_connect_failed", { source: "fitness_apps" })
    } finally {
      setStravaBusy(false)
    }
  }

  async function handleDisconnectStrava() {
    setStravaBusy(true)
    const toastId = toast("Disconnecting from Strava...", "loading")
    try {
      // Revoke on Strava's side too, so disconnecting here really removes
      // Sulla Via from the visitor's Strava account. As with Wahoo, forget
      // the token locally whatever happens, so nobody is stuck "connected".
      try {
        const tokens = await getValidStravaTokens()
        await revokeStravaAccess(tokens.accessToken)
      } catch {
        // best-effort
      }
      clearStravaTokens()
      onStravaTokensChange(null)
      updateToast(toastId, "Disconnected from Strava.", "success")
    } finally {
      setStravaBusy(false)
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
    {
      key: "strava",
      name: "Strava",
      logo: <StravaWordmark className="text-sm" />,
      account: stravaTokens ? (stravaTokens.athleteLabel ?? "") : null,
      busy: stravaBusy,
      onConnect: handleConnectStrava,
      onDisconnect: handleDisconnectStrava,
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
            <li key={app.key} className="flex items-center gap-3 rounded-control border p-3">
              <span className="flex w-20 shrink-0 items-center">{app.logo}</span>
              <span className="min-w-0 flex-1 text-sm">
                {app.account === null ? (
                  <span className="flex flex-row gap-2 items-center text-muted-foreground"><Unlink size={12}/>Not connected</span>
                ) : (
                  <>
                    <span className="flex flex-row gap-2 items-center text-success-foreground"><Link size={12} /> Connected</span>
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
