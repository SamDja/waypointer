// The one look for every "close this" X - dialog.tsx, toast.tsx, and (via
// index.css) MapLibre's popup close button - so they all hover, point and
// focus alike. Not a component: each Radix primitive renders its own Close.
export const closeButtonClass =
  "cursor-pointer rounded-item p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none"
