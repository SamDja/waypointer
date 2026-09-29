import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// An inline message inside a card or dialog that the visitor should read
// before carrying on: a warning about the results, a failure that didn't
// warrant a toast (e.g. under a full-screen dialog, where toasts are hidden).
const calloutVariants = cva("flex items-start gap-1.5 rounded-control border px-3 py-2 text-sm", {
  variants: {
    variant: {
      warning: "border-warning-border bg-warning-surface text-warning-foreground",
      destructive: "border-destructive-border bg-destructive-surface text-destructive-foreground",
      success: "border-success-border bg-success-surface text-success-foreground",
    },
  },
  defaultVariants: {
    variant: "warning",
  },
})

function Callout({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof calloutVariants>) {
  return <div data-slot="callout" className={cn(calloutVariants({ variant }), className)} {...props} />
}

export { Callout }
