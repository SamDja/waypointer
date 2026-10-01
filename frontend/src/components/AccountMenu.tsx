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
import type { Account } from "@/types/account"

export interface AccountMenuProps {
  account: Account | null
  onOpen: (view: AccountView) => void
  onSignOut: () => void
}

// The header pill's account control. Anonymous: a "Sign in" button (the
// app works fully without one). Signed in: a menu over the account. The
// dialogs themselves are AccountDialog, owned by App so that email links
// can open them too.
export function AccountMenu({ account, onOpen, onSignOut }: AccountMenuProps) {
  if (!account) {
    return (
      <Button variant="ghost" className="w-fit" aria-label="Sign in" onClick={() => onOpen("signin")}>
        <LogIn className="size-4" />
        {/* The header shares a phone's first row with the logo pill. */}
        <span className="hidden sm:inline">Sign in</span>
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-fit" aria-label="Your account">
          <UserRound className="size-4" />
          {!account.email_verified && <MailWarning className="size-4 text-warning-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="text-xs font-normal text-muted-foreground">Signed in as</span>
          <span className="truncate font-normal text-foreground">{account.email}</span>
          {!account.email_verified && (
            <span className="text-xs font-normal text-warning-foreground">
              Email not verified yet - check your inbox
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onOpen("settings")}>Account settings</DropdownMenuItem>
        <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
