import { useState } from "react"
import { LogIn, MailWarning, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AccountView } from "@/components/AccountDialog"
import { StravaWordmark, WahooLogo } from "@/components/FitnessAppLogos"
import { FitnessAppRoutesDialog } from "@/components/FitnessAppRoutesDialog"
import { unverifiedDeadline } from "@/lib/accountApi"
import { findConnection, type Connection } from "@/lib/connections"
import type { Account } from "@/types/account"

export interface AccountMenuProps {
  account: Account | null
  connections: Connection[]
  onOpen: (view: AccountView) => void
  onSignOut: () => void
}

// The header pill's account control - and, since connecting a fitness app
// needs an account, the way to those too. Anonymous: a "Sign in" button
// (the app works fully without one). Signed in: a menu over the account
// and its connected apps; connecting and disconnecting apps is in the
// account settings. The dialogs themselves are AccountDialog, owned by App
// so that email links can open them too.
export function AccountMenu({ account, connections, onOpen, onSignOut }: AccountMenuProps) {
  const [showRoutesDialog, setShowRoutesDialog] = useState(false)

  if (!account) {
    return (
      <Button variant="ghost" className="w-fit" aria-label="Sign in" onClick={() => onOpen("signin")}>
        <LogIn className="size-4" />
        {/* The header shares a phone's first row with the logo pill. */}
        <span className="hidden sm:inline">Sign in</span>
      </Button>
    )
  }

  const wahoo = findConnection(connections, "wahoo")
  const strava = findConnection(connections, "strava")

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="w-fit max-w-48" aria-label="Your account">
            <UserRound className="size-4" />
            {/* Their name, as they gave it - a phone's header row is shared
                with the logo pill, so a long one is cut short there. */}
            {account.name && <span className="max-w-24 truncate sm:max-w-36">{account.name}</span>}
            {!account.email_verified && <MailWarning className="size-4 text-warning-foreground" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-72">
          <DropdownMenuLabel className="flex flex-col gap-1">
            <span className="text-xs font-normal text-muted-foreground">Signed in as</span>
            {account.name && <span className="truncate text-foreground">{account.name}</span>}
            <span className={account.name ? "truncate text-xs font-normal text-muted-foreground" : "truncate font-normal text-foreground"}>
              {account.email}
            </span>
            {!account.email_verified && (
              <span className="text-xs font-normal text-warning-foreground">
                Confirm your email by {unverifiedDeadline(account)}, or the account will be deleted - check your
                inbox.
              </span>
            )}
          </DropdownMenuLabel>
          {(wahoo || strava) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex flex-col gap-1">
                <span className="text-xs font-normal text-muted-foreground">Connected to</span>
                {wahoo && (
                  <span className="flex items-center gap-2">
                    <WahooLogo className="h-3 w-auto shrink-0 text-foreground" />
                    {wahoo.label && <span className="truncate font-normal text-foreground">{wahoo.label}</span>}
                  </span>
                )}
                {strava && (
                  <span className="flex items-center gap-2">
                    <StravaWordmark className="text-xs text-foreground" />
                    {strava.label && <span className="truncate font-normal text-foreground">{strava.label}</span>}
                  </span>
                )}
              </DropdownMenuLabel>
            </>
          )}
          <DropdownMenuSeparator />
          {(wahoo || strava) && (
            <DropdownMenuItem onSelect={() => setShowRoutesDialog(true)}>Manage routes</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onOpen("settings")}>Account settings</DropdownMenuItem>
          <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {(wahoo || strava) && (
        <FitnessAppRoutesDialog
          open={showRoutesDialog}
          onOpenChange={setShowRoutesDialog}
          mode="manage"
          connections={connections}
        />
      )}
    </>
  )
}
