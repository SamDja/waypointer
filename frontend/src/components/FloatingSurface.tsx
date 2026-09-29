import * as React from "react"

import { floatingSurfaceClass } from "@/components/ui/surface"
import { cn } from "@/lib/utils"

// A panel floating over the map (see floatingSurfaceClass).
export function FloatingSurface({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="floating-surface" className={cn(floatingSurfaceClass, className)} {...props} />
}
