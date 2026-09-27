import { CircleUser } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { StravaWordmark, WahooLogo } from "@/components/FitnessAppLogos"
import { FitnessAppsDialog } from "@/components/FitnessAppsDialog"
import { FitnessAppRoutesDialog } from "@/components/FitnessAppRoutesDialog"
import type { StravaTokens } from "@/lib/stravaSettings"
import type { WahooTokens } from "@/lib/wahooSettings"

export interface FitnessAppsMenuProps {
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
  stravaTokens: StravaTokens | null
  onStravaTokensChange: (tokens: StravaTokens | null) => void
}

// The header's profile pill. With no app connected it is just the invitation
// to connect one; once one is, it becomes a menu over every connected app.
export function FitnessAppsMenu({
  wahooTokens,
  onWahooTokensChange,
  stravaTokens,
  onStravaTokensChange,
}: FitnessAppsMenuProps) {
  const [showAppsDialog, setShowAppsDialog] = useState(false)
  const [showRoutesDialog, setShowRoutesDialog] = useState(false)
  const anyConnected = wahooTokens !== null || stravaTokens !== null
  // Any connected account's name will do for the pill - it's the same
  // person whichever app it came from.
  const accountLabel = wahooTokens?.athleteLabel || stravaTokens?.athleteLabel

  return (
    <>
      {anyConnected ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-fit">
              <CircleUser className="size-4" />
              {accountLabel || "Your fitness apps"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="flex flex-col gap-1">
              <span className="text-xs font-normal text-muted-foreground">Connected to</span>
              {wahooTokens && (
                <span className="flex items-center gap-2">
                  <WahooLogo className="h-3 w-auto shrink-0 text-foreground" />
                  {wahooTokens.athleteLabel && (
                    <span className="truncate font-normal text-foreground">{wahooTokens.athleteLabel}</span>
                  )}
                </span>
              )}
              {stravaTokens && (
                <span className="flex items-center gap-2">
                  <StravaWordmark className="text-xs text-foreground" />
                  {stravaTokens.athleteLabel && (
                    <span className="truncate font-normal text-foreground">{stravaTokens.athleteLabel}</span>
                  )}
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setShowRoutesDialog(true)}>Manage routes</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setShowAppsDialog(true)}>Manage fitness apps</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button variant="ghost" className="w-fit" onClick={() => setShowAppsDialog(true)}>
          <CircleUser className="size-4" />
          {/* The header shares a phone's first row with the logo pill. */}
          <span className="sm:hidden">Connect your apps</span>
          <span className="hidden sm:inline">Connect your fitness apps</span>
        </Button>
      )}

      {/* Mounted whichever of the two the pill is showing: disconnecting the
          last app from inside it swaps the pill back to the connect button,
          and the dialog has to stay open across that. */}
      <FitnessAppsDialog
        open={showAppsDialog}
        onOpenChange={setShowAppsDialog}
        wahooTokens={wahooTokens}
        onWahooTokensChange={onWahooTokensChange}
        stravaTokens={stravaTokens}
        onStravaTokensChange={onStravaTokensChange}
      />
      {anyConnected && (
        <FitnessAppRoutesDialog
          open={showRoutesDialog}
          onOpenChange={setShowRoutesDialog}
          mode="manage"
          wahooConnected={wahooTokens !== null}
          stravaConnected={stravaTokens !== null}
        />
      )}
    </>
  )
}
