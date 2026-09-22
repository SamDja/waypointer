import { useEffect, useRef, useState } from "react"
import { Loader2, MapPin, Plus, Search } from "lucide-react"
import { Command as CommandPrimitive } from "cmdk"
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { searchPlaces } from "@/lib/api"
import type { PlaceResult } from "@/types/candidate"

// Wait this long after the last keystroke before searching, and don't search
// fewer characters than the backend accepts (geocode.MIN_QUERY_LENGTH).
const SEARCH_DEBOUNCE_MS = 300
const MIN_QUERY_LENGTH = 3

// Cmd+K on Apple platforms, Ctrl+K elsewhere, as in most apps with a search box.
// Both platform sources are checked: userAgentData can be present with an
// empty platform (headless Chromium), and navigator.platform is deprecated.
const IS_APPLE = /Mac|iPhone|iPad/.test(
  `${(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ""} ${navigator.platform}`
)
const SHORTCUT_LABEL = IS_APPLE ? "\u2318K" : "Ctrl K"

export interface PlaceSearchProps {
  // Where the map is looking, to bias results towards it (read when a search runs).
  getNear: () => [number, number] | null
  onSelect: (place: PlaceResult) => void
  // Present while planning: each result can also be added to the route.
  onAddPoint?: (place: PlaceResult) => void
}

// The map's search box: type a town, peak or pass, jump the map there. A cmdk
// Command so the result list gets keyboard navigation for free, with
// filtering off - the results come from the server (/api/geocode, Photon)
// already ranked.
export function PlaceSearch({ getNear, onSelect, onAddPoint }: PlaceSearchProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<PlaceResult[]>([])
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "error">("idle")
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  // Cmd/Ctrl+K from anywhere focuses the box, with its text selected so
  // typing replaces the last search. Not inside a dialog, which owns its keys.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(IS_APPLE ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.target instanceof Element && e.target.closest("[role=dialog], [role=alertdialog]")) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Debounced search; a search typed past is aborted so a late answer can't
  // replace a newer one.
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < MIN_QUERY_LENGTH) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setStatus("searching")
      searchPlaces(trimmed, getNear(), controller.signal)
        .then((places) => {
          setResults(places)
          setStatus("done")
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setResults([])
          setStatus("error")
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, getNear])

  // Close the list on a click anywhere else.
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [open])

  const tooShort = query.trim().length < MIN_QUERY_LENGTH
  const pick = (place: PlaceResult, addPoint: boolean) => {
    if (addPoint) onAddPoint?.(place)
    else onSelect(place)
    setOpen(false)
  }

  return (
    <TooltipProvider>
    <div ref={containerRef} className="relative">
      <Command shouldFilter={false} className="h-auto overflow-visible rounded-xl bg-card shadow-lg ring-1 ring-foreground/10">
        <div className="flex items-center">
          <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
          {/* cmdk's raw input: the shadcn CommandInput wrapper is styled for use
              inside a popover (its own icon, border and height). */}
          <CommandPrimitive.Input
            ref={inputRef}
            value={query}
            onValueChange={(value) => {
              setQuery(value)
              setOpen(true)
              if (value.trim().length < MIN_QUERY_LENGTH) {
                setResults([])
                setStatus("idle")
              }
            }}
            onFocus={() => {
              setOpen(true)
              setFocused(true)
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false)
            }}
            placeholder="Search a town, peak or pass…"
            aria-label="Search places"
            className="h-11 min-w-0 flex-1 bg-transparent px-2 text-sm outline-hidden placeholder:text-muted-foreground"
          />
          {status === "searching" ? (
            <Loader2 className="mr-3 size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            !focused &&
            !query && (
              // Desktop only: phones have no keyboard shortcut to hint at.
              <kbd className="mr-3 hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground md:inline-block">
                {SHORTCUT_LABEL}
              </kbd>
            )
          )}
        </div>
        {open && !tooShort && (
          <CommandList className="absolute top-full right-0 left-0 z-10 mt-2 max-h-80 overflow-y-auto rounded-xl bg-popover p-1 shadow-lg ring-1 ring-foreground/10">
            {status === "done" && <CommandEmpty>No places found.</CommandEmpty>}
            {status === "error" && (
              <div className="px-3 py-2 text-sm text-muted-foreground">Place search isn't available right now.</div>
            )}
            {results.map((place, i) => (
              <CommandItem
                key={`${place.lat},${place.lon},${i}`}
                value={`${place.name}-${i}`}
                onSelect={() => pick(place, false)}
                className="flex items-center gap-2 py-2"
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{place.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {kindLabel(place.kind)}
                    {place.context && ` · ${place.context}`}
                  </span>
                </span>
                {onAddPoint && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Add ${place.name} as a route point`}
                        // Not the item's own select (which frames the place).
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          pick(place, true)
                        }}
                      >
                        <Plus className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Add as a route point</TooltipContent>
                  </Tooltip>
                )}
              </CommandItem>
            ))}
          </CommandList>
        )}
      </Command>
    </div>
    </TooltipProvider>
  )
}

/** An OSM tag value as a readable label: "isolated_dwelling" -> "Isolated dwelling". */
function kindLabel(kind: string): string {
  const words = kind.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
