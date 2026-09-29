import type { CSSProperties } from "react"
import colors from "tailwindcss/colors"

// Sulla Via's mark, inlined rather than an <img src="favicon.svg"> so it
// follows the app's own theme: the pin keeps its green, the magnifier is
// dark ink in light mode and the foreground colour in dark mode.
// public/favicon.svg (the browser-tab icon) draws the same paths - keep
// the two in step.
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      className={className}
      style={{ "--logo-ink": colors.lime[950] } as CSSProperties}
      fillRule="evenodd"
      clipRule="evenodd"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M86.729,40.818c-0,17.809 -27.186,47.588 -34.021,54.17c-0.897,0.864 -2.604,0.922 -2.646,0.923c-1.006,0.013 -2.001,-0.306 -2.821,-0.923c-8.54,-7.373 -33.97,-31.247 -33.97,-54.17c0,-20.149 16.58,-36.729 36.729,-36.729c20.149,0 36.729,16.58 36.729,36.729Zm-36.729,-13.773c7.602,-0 13.773,6.171 13.773,13.773c0,7.601 -6.171,13.773 -13.773,13.773c-7.602,0 -13.773,-6.172 -13.773,-13.773c-0,-7.602 6.171,-13.773 13.773,-13.773Z"
        fill={colors.lime[600]}
      />
      <g fill="none" strokeWidth={9.95} className="stroke-(--logo-ink) dark:stroke-foreground">
        <path d="M91.667,91.667l-9.352,-9.352" />
        <circle cx="71.77" cy="71.77" r="14.923" />
      </g>
    </svg>
  )
}
