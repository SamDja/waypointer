import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { importWahooRoute } from "@/lib/api"
import { listWahooRoutes, type WahooRoute } from "@/lib/wahooApi"
import { getValidWahooAccessToken } from "@/lib/wahooSettings"

export interface WahooImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (file: File) => void
  onError: (message: string) => void
}

export function WahooImportDialog({ open, onOpenChange, onImport, onError }: WahooImportDialogProps) {
  const [routes, setRoutes] = useState<WahooRoute[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [importingId, setImportingId] = useState<number | null>(null)

  // Kept in refs so the fetch effect below can depend on `open` alone -
  // these callbacks are recreated on every parent render, and including
  // them as deps would re-run the effect (re-fetching the list) on every
  // unrelated re-render while the dialog is open.
  const onErrorRef = useRef(onError)
  const onOpenChangeRef = useRef(onOpenChange)
  onErrorRef.current = onError
  onOpenChangeRef.current = onOpenChange

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoading(true)
    setRoutes(null)
    ;(async () => {
      try {
        const accessToken = await getValidWahooAccessToken()
        const result = await listWahooRoutes(accessToken)
        if (!cancelled) setRoutes(result)
      } catch (err) {
        if (cancelled) return
        onErrorRef.current(err instanceof Error ? err.message : "Failed to load Wahoo routes.")
        onOpenChangeRef.current(false)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  async function handleImport(route: WahooRoute) {
    setImportingId(route.id)
    try {
      const { blob } = await importWahooRoute(route.fileUrl)
      const file = new File([blob], `${route.name || "wahoo-route"}.gpx`, { type: "application/gpx+xml" })
      onImport(file)
      onOpenChange(false)
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to import the Wahoo route.")
    } finally {
      setImportingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import from Wahoo</DialogTitle>
          <DialogDescription>Pick a route from your Wahoo account to import.</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your routes…</p>
        ) : routes && routes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No routes in your Wahoo account.</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {routes?.map((route) => (
              <li key={route.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm">
                  {route.name} - {(route.distanceM / 1000).toFixed(1)}km
                </span>
                <Button
                  onClick={() => handleImport(route)}
                  loading={importingId === route.id}
                  disabled={importingId !== null}
                  size="sm"
                  variant="secondary"
                >
                  Import
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
