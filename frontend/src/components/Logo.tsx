import type { CSSProperties } from "react"
import colors from "tailwindcss/colors"

// Sulla Via's mark, inlined rather than an <img src="favicon.svg"> so it
// follows the app's own theme: the pin keeps its green, the magnifier is
// dark ink in light mode and the foreground colour in dark mode.
// public/favicon.svg (the browser-tab icon) draws the same paths - keep
// the two in step.
export function Logo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg"
      viewBox="9.5 1.5 88 88"
      aria-hidden
      className={className}
      style={{ "--logo-ink": colors.lime[950] } as CSSProperties}
    >
      <g className="route stroke-(--logo-ink) dark:stroke-foreground">
        <path d="M22 82H56A16 16 0 0 0 56 50H44A16 16 0 0 1 44 18H62" fill="none" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" />
      </g>
      <path d="M80 2C80 2 68 16 68 23a12 12 0 0 0 24 0C92 16 80 2 80 2Z" fill={colors.lime[600]} />
    </svg>

  )
}
