import * as React from "react"
import { Toast as ToastPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

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
        "pointer-events-auto flex items-center gap-2 rounded-lg border bg-background p-4 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-full data-[swipe=end]:animate-out",
        variant === "destructive" && "border-destructive/40 bg-destructive/10 text-destructive",
        variant === "success" &&
          "border-green-600/40 bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400",
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

function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        "rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      <XIcon className="size-4" />
      <span className="sr-only">Dismiss</span>
    </ToastPrimitive.Close>
  )
}

export { ToastClose, ToastProvider, ToastRoot, ToastTitle, ToastViewport }
