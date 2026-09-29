import * as React from "react"
import { Toast as ToastPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { closeButtonClass } from "@/components/ui/close-button"

function ToastProvider({ ...props }: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider data-slot="toast-provider" {...props} />
}

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        // z-[1100] - same Leaflet-stacking reasoning as dialog.tsx/
        // dropdown-menu.tsx: this renders via a Radix portal into
        // document.body, competing with Leaflet's panes/controls directly.
        "fixed top-0 right-0 z-[1100] flex w-full max-w-sm flex-col gap-2 p-4",
        className
      )}
      {...props}
    />
  )
}

function ToastRoot({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & {
  variant?: "default" | "destructive" | "success"
}) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      // Radix's own internal auto-close timer (ToastProvider's `duration`,
      // default 5000ms) is independent of our lib/toast.ts store's
      // setTimeout-based dismissal - without disabling it here, Radix would
      // close every toast (including "loading" ones, which must persist
      // until explicitly resolved) on its own schedule regardless of what
      // our store intends.
      duration={Infinity}
      className={cn(
        "pointer-events-auto flex items-center gap-2 rounded-surface border border-transparent bg-background p-4 shadow-floating ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-full data-[swipe=end]:animate-out",
        // Opaque backgrounds: toasts float over the map, and a tinted,
        // see-through one lets the basemap's labels show through the text.
        variant === "destructive" &&
          "ring-destructive-border bg-destructive-surface text-destructive-foreground",
        variant === "success" &&
          "ring-success-border bg-success-surface text-success-foreground",
        className
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("flex-1 text-sm font-medium", className)}
      {...props}
    />
  )
}

// A button inside the toast that acts on it (e.g. "Restore"). Radix requires
// altText: what a screen reader announces as the way to do the same thing.
function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Action>) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-control border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted focus:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  )
}

function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        closeButtonClass,
        className
      )}
      {...props}
    >
      <XIcon className="size-4" />
      <span className="sr-only">Dismiss</span>
    </ToastPrimitive.Close>
  )
}

export { ToastAction, ToastClose, ToastProvider, ToastRoot, ToastTitle, ToastViewport }
