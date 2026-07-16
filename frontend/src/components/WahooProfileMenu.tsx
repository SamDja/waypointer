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
import { WahooRoutesDialog } from "@/components/WahooRoutesDialog"
import { toast, updateToast } from "@/lib/toast"
import { revokeWahooAccess } from "@/lib/wahooApi"
import { missingWahooScopeWarning } from "@/lib/wahooAuth"
import { connectWahoo } from "@/lib/wahooConnect"
import { clearWahooTokens, getValidWahooAccessToken, type WahooTokens } from "@/lib/wahooSettings"

export interface WahooProfileMenuProps {
  wahooTokens: WahooTokens | null
  onWahooTokensChange: (tokens: WahooTokens | null) => void
}

export function WahooProfileMenu({ wahooTokens, onWahooTokensChange }: WahooProfileMenuProps) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [showManageDialog, setShowManageDialog] = useState(false)

  async function handleConnect() {
    setIsConnecting(true)
    const toastId = toast("Connecting to Wahoo...", "loading")
    try {
      const tokens = await connectWahoo()
      onWahooTokensChange(tokens)
      const scopeWarning = missingWahooScopeWarning(tokens)
      updateToast(toastId, scopeWarning ?? "Connected to Wahoo.", scopeWarning !== null ? "error" : "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to connect to Wahoo.", "error")
    } finally {
      setIsConnecting(false)
    }
  }

  async function handleDisconnect() {
    setIsDisconnecting(true)
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
      setIsDisconnecting(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="w-fit" loading={isConnecting || isDisconnecting}>
            <CircleUser className="size-4" />
            {wahooTokens?.athleteLabel ?? "Connect Wahoo"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {wahooTokens ? (
            <>
              <DropdownMenuLabel className="flex flex-col">
                {wahooTokens.athleteLabel ? (
                  <>
                  <span className="text-black">{wahooTokens.athleteLabel}</span>
                  </>
                ): (<></>)
                }
                <span className="text-xs font-normal text-muted-foreground">Connected to Wahoo</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowManageDialog(true)}>Manage routes</DropdownMenuItem>
              <DropdownMenuItem onSelect={handleDisconnect}>Disconnect</DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={handleConnect}>Connect Wahoo</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {wahooTokens && (
        <WahooRoutesDialog open={showManageDialog} onOpenChange={setShowManageDialog} mode="manage" />
      )}
    </>
  )
}
