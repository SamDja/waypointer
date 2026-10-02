import { useState, type ReactNode } from "react"
import { Link, MailWarning, Unlink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { StravaWordmark, WahooLogo } from "@/components/FitnessAppLogos"
import { track } from "@/lib/analytics"
import {
  disconnectApp,
  findConnection,
  withConnection,
  withoutConnection,
  type Connection,
  type Provider,
} from "@/lib/connections"
import { missingStravaScopeWarning } from "@/lib/stravaAuth"
import { connectStrava } from "@/lib/stravaConnect"
import { toast, updateToast } from "@/lib/toast"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import type { Account } from "@/types/account"

export interface FitnessAppsListProps {
  account: Account | null
  // Opens the sign-in dialog - connections belong to an account.
  onSignIn: () => void
  connections: Connection[]
  onConnectionsChange: (connections: Connection[]) => void
}

// One row per app a visitor can connect - Wahoo and Strava today; Garmin
// and the rest join this list, each bringing its own connect, and the
// dialog around them doesn't change.
interface FitnessAppRow {
  provider: Provider
  name: string
  logo: ReactNode
  connect: () => Promise<Connection>
  scopeWarning: (scope: string | null) => string | null
}

const APPS: FitnessAppRow[] = [
  {
    provider: "wahoo",
    name: "Wahoo",
    logo: <WahooLogo className="h-4 w-auto" />,
    connect: connectWahoo,
    scopeWarning: missingWahooScopeWarning,
  },
  {
    provider: "strava",
    name: "Strava",
    logo: <StravaWordmark className="text-sm" />,
    connect: connectStrava,
    scopeWarning: missingStravaScopeWarning,
  },
]

// One row per app: connected apps can be disconnected, the others
// connected. Shown in the account settings, and in the dialog step 2's
// "Connect a fitness app to import a route" opens. A connection is kept
// with the visitor's account (so it works on every device they sign in
// on), which is why connecting needs one - signed out or unverified, this
// says what's missing instead.
export function FitnessAppsList({ account, onSignIn, connections, onConnectionsChange }: FitnessAppsListProps) {
  const [busy, setBusy] = useState<Provider | null>(null)

  async function handleConnect(app: FitnessAppRow) {
    setBusy(app.provider)
    const toastId = toast(`Connecting to ${app.name}...`, "loading")
    track(`${app.provider}_connect_initiated`, { source: "fitness_apps" })
    try {
      const connection = await app.connect()
      onConnectionsChange(withConnection(connections, connection))
      const warning = app.scopeWarning(connection.scope)
      updateToast(toastId, warning ?? `Connected to ${app.name}.`, warning !== null ? "error" : "success")
      track(`${app.provider}_connect_succeeded`, { source: "fitness_apps" })
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : `Failed to connect to ${app.name}.`, "error")
      track(`${app.provider}_connect_failed`, { source: "fitness_apps" })
    } finally {
      setBusy(null)
    }
  }

  async function handleDisconnect(app: FitnessAppRow) {
    setBusy(app.provider)
    const toastId = toast(`Disconnecting from ${app.name}...`, "loading")
    try {
      // The server revokes access at the app's end too, and forgets the
      // connection even if the app can't be reached.
      await disconnectApp(app.provider)
      onConnectionsChange(withoutConnection(connections, app.provider))
      updateToast(toastId, `Disconnected from ${app.name}.`, "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : `Couldn't disconnect from ${app.name}.`, "error")
    } finally {
      setBusy(null)
    }
  }

  let body: ReactNode
  if (!account) {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          Sign in to connect your fitness apps. Your connections are kept with your account, so they work on every
          device you use Sulla Via on.
        </p>
        <Button className="w-fit" onClick={onSignIn}>
          Sign in
        </Button>
      </div>
    )
  } else if (!account.email_verified) {
    body = (
      <Callout variant="warning">
        <MailWarning className="mt-0.5 size-4 shrink-0" />
        Confirm your email address first - we sent a link to {account.email}. You can resend it from your account
        settings.
      </Callout>
    )
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {APPS.map((app) => {
          const connection = findConnection(connections, app.provider)
          return (
            <li key={app.provider} className="flex items-center gap-3 rounded-control border p-3">
              <span className="flex w-20 shrink-0 items-center">{app.logo}</span>
              <span className="min-w-0 flex-1 text-sm">
                {connection === null ? (
                  <span className="flex flex-row items-center gap-2 text-muted-foreground">
                    <Unlink size={12} />
                    Not connected
                  </span>
                ) : (
                  <>
                    <span className="flex flex-row items-center gap-2 text-success-foreground">
                      <Link size={12} /> Connected
                    </span>
                    {connection.label && <span className="block truncate font-medium">{connection.label}</span>}
                  </>
                )}
              </span>
              {connection === null ? (
                <Button size="sm" loading={busy === app.provider} onClick={() => void handleConnect(app)}>
                  Connect
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === app.provider}
                  onClick={() => void handleDisconnect(app)}
                >
                  Disconnect
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  return body
}
