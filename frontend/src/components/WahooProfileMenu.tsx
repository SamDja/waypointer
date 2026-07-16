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
import { revokeWahooAccess } from "@/lib/wahooApi"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { clearWahooTokens, getValidWahooAccessToken, type WahooTokens } from "@/lib/wahooSettings"

export interface WahooProfileMenuProps {
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
  onStatus: (message: string, isError: boolean) => void
}

export function WahooProfileMenu({ wahooTokens, onWahooTokensChange, onStatus }: WahooProfileMenuProps) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  async function handleConnect() {
    setIsConnecting(true)
    onStatus("Connecting to Wahoo...", false)
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      onStatus(scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null)
    } catch (err) {
      onStatus(err instanceof Error ? err.message : "Failed to connect to Wahoo.", true)
    } finally {
      setIsConnecting(false)
    }
  }

  async function handleDisconnect() {
    setIsDisconnecting(true)
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
      onStatus("Disconnected from Wahoo.", false)
    } finally {
      setIsDisconnecting(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-fit" loading={isConnecting || isDisconnecting}>
          <CircleUser className="size-4" />
          {wahooTokens?.athleteLabel ?? "Wahoo"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {wahooTokens ? (
          <>
            <DropdownMenuLabel>
              Connected {wahooTokens.athleteLabel ? `as ${wahooTokens.athleteLabel}` : "to Wahoo"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleDisconnect}>Disconnect</DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={handleConnect}>Connect Wahoo</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
