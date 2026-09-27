import { ExternalLinkIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { StravaLogo, WahooLogo } from "@/components/FitnessAppLogos"
import { RouteNameDialog } from "@/components/RouteNameDialog"
import { importWahooRoute } from "@/lib/api"
import { importStravaRoute, listStravaRoutes, stravaRouteUrl } from "@/lib/stravaApi"
import { getValidStravaTokens } from "@/lib/stravaSettings"
import { toast, updateToast } from "@/lib/toast"
import { deleteWahooRoute, listWahooRoutes, updateWahooRouteName, type WahooRoute } from "@/lib/wahooApi"
import { getValidWahooAccessToken } from "@/lib/wahooSettings"

// Which connected app a route lives in.
export type RouteSource = "wahoo" | "strava"

const SOURCE_NAMES: Record<RouteSource, string> = { wahoo: "Wahoo", strava: "Strava" }

// One route from any connected app, as the dialog lists it. Only Wahoo's
// API can rename or delete a route - Strava's is read-only - so a Wahoo
// route keeps what those calls need.
interface RemoteRoute {
  source: RouteSource
  // Unique across sources - two apps can hand out the same id.
  key: string
  id: string
  name: string
  distanceM: number
  createdAt: string
  wahoo?: WahooRoute
}

function fromWahoo(route: WahooRoute): RemoteRoute {
  return {
    source: "wahoo",
    key: `wahoo:${route.id}`,
    id: String(route.id),
    name: route.name,
    distanceM: route.distanceM,
    createdAt: route.createdAt,
    wahoo: route,
  }
}

// Newest first across every app, undated last.
function byNewest(a: RemoteRoute, b: RemoteRoute): number {
  const ta = Date.parse(a.createdAt)
  const tb = Date.parse(b.createdAt)
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? 0 : 1
  if (Number.isNaN(tb)) return -1
  return tb - ta
}

async function fetchSource(source: RouteSource): Promise<RemoteRoute[]> {
  if (source === "wahoo") {
    const accessToken = await getValidWahooAccessToken()
    return (await listWahooRoutes(accessToken)).map(fromWahoo)
  }
  const tokens = await getValidStravaTokens()
  const routes = await listStravaRoutes(tokens.accessToken, tokens.athleteId)
  return routes.map((route) => ({
    source: "strava",
    key: `strava:${route.id}`,
    id: route.id,
    name: route.name,
    distanceM: route.distanceM,
    createdAt: route.createdAt,
  }))
}

async function downloadAsGpx(route: RemoteRoute): Promise<Blob> {
  if (route.source === "wahoo" && route.wahoo) {
    return (await importWahooRoute(route.wahoo.fileUrl)).blob
  }
  const tokens = await getValidStravaTokens()
  return importStravaRoute(route.id, tokens.accessToken)
}

function SourceBadge({ source }: { source: RouteSource }) {
  return (
    <span className="flex w-14 shrink-0 items-center" title={SOURCE_NAMES[source]}>
      {source === "wahoo" ? <WahooLogo className="h-3 w-auto" /> : <StravaLogo className="size-4" />}
    </span>
  )
}

interface CommonProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  wahooConnected: boolean
  stravaConnected: boolean
}

export type FitnessAppRoutesDialogProps =
  | (CommonProps & { mode: "import"; onImport: (file: File, source: RouteSource) => void })
  | (CommonProps & { mode: "manage" })

// Every route in every connected app, in one list: pick one to import, or
// (mode "manage") rename or delete it where its app allows that.
export function FitnessAppRoutesDialog(props: FitnessAppRoutesDialogProps) {
  const { open, onOpenChange, mode, wahooConnected, stravaConnected } = props
  const [routes, setRoutes] = useState<RemoteRoute[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [importingKey, setImportingKey] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [renameTarget, setRenameTarget] = useState<WahooRoute | null>(null)
  const [pendingRename, setPendingRename] = useState<{ route: WahooRoute; newName: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WahooRoute | null>(null)

  // Kept in a ref so the fetch effect below doesn't depend on it -
  // onOpenChange is recreated on every parent render, and including it as a
  // dep would re-run the effect (re-fetching the list) on every unrelated
  // re-render while the dialog is open. toast() itself is a stable
  // module-level import, so it doesn't need the same treatment.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  useEffect(() => {
    if (!open) return
    const sources: RouteSource[] = []
    if (wahooConnected) sources.push("wahoo")
    if (stravaConnected) sources.push("strava")
    let cancelled = false
    setIsLoading(true)
    setRoutes(null)
    ;(async () => {
      // Each app is listed on its own, so one failing still shows the others.
      const results = await Promise.allSettled(sources.map(fetchSource))
      if (cancelled) return
      const loaded: RemoteRoute[] = []
      let failures = 0
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          loaded.push(...result.value)
        } else {
          failures += 1
          const fallback = `Couldn't load your ${SOURCE_NAMES[sources[i]]} routes.`
          toast(result.reason instanceof Error ? result.reason.message : fallback, "error")
        }
      })
      setIsLoading(false)
      if (sources.length > 0 && failures === sources.length) {
        onOpenChangeRef.current(false)
        return
      }
      setRoutes(loaded.sort(byNewest))
    })()
    return () => {
      cancelled = true
    }
  }, [open, wahooConnected, stravaConnected])

  async function handleImport(route: RemoteRoute) {
    if (mode !== "import") return
    setImportingKey(route.key)
    try {
      const blob = await downloadAsGpx(route)
      const file = new File([blob], `${route.name || `${route.source}-route`}.gpx`, { type: "application/gpx+xml" })
      props.onImport(file, route.source)
      onOpenChange(false)
    } catch (err) {
      toast(
        err instanceof Error ? err.message : `Failed to import the ${SOURCE_NAMES[route.source]} route.`,
        "error",
      )
    } finally {
      setImportingKey(null)
    }
  }

  async function handleConfirmRename() {
    if (!pendingRename) return
    const { route, newName } = pendingRename
    setPendingRename(null)
    setRenamingId(route.id)
    const toastId = toast("Renaming route...", "loading")
    try {
      const accessToken = await getValidWahooAccessToken()
      await updateWahooRouteName(route, newName, accessToken)
      setRoutes((prev) =>
        prev
          ? prev.map((r) =>
              r.wahoo?.id === route.id ? { ...r, name: newName, wahoo: { ...route, name: newName } } : r,
            )
          : prev,
      )
      updateToast(toastId, `Renamed to "${newName}".`, "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to rename the route.", "error")
    } finally {
      setRenamingId(null)
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return
    const route = pendingDelete
    setPendingDelete(null)
    setDeletingId(route.id)
    const toastId = toast("Deleting route...", "loading")
    try {
      const accessToken = await getValidWahooAccessToken()
      await deleteWahooRoute(route.id, accessToken)
      setRoutes((prev) => (prev ? prev.filter((r) => r.wahoo?.id !== route.id) : prev))
      updateToast(toastId, `Deleted "${route.name}".`, "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to delete the route.", "error")
    } finally {
      setDeletingId(null)
    }
  }

  const manageDescription = stravaConnected
    ? wahooConnected
      ? "Rename or delete your Wahoo routes. Strava routes can only be changed on Strava."
      : "Strava routes can only be changed on Strava - open one there to rename or delete it."
    : "Rename or delete routes in your Wahoo account."

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="top-0 left-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-0">
          <DialogHeader>
            <DialogTitle>{mode === "import" ? "Import a route" : "Manage your routes"}</DialogTitle>
            <DialogDescription>
              {mode === "import" ? "Pick a route from your fitness apps to import." : manageDescription}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading your routes…</p>
          ) : routes && routes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routes in your connected apps.</p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {routes?.map((route) => (
                <li key={route.key} className="flex items-center gap-2">
                  <SourceBadge source={route.source} />
                  <span className="flex-1 text-sm">
                    {route.name} - {(route.distanceM / 1000).toFixed(1)}km
                  </span>
                  {mode === "import" ? (
                    <Button
                      onClick={() => handleImport(route)}
                      loading={importingKey === route.key}
                      disabled={importingKey !== null}
                      size="sm"
                    >
                      Import
                    </Button>
                  ) : route.wahoo ? (
                    <>
                      <Button
                        onClick={() => setRenameTarget(route.wahoo ?? null)}
                        loading={renamingId === route.wahoo.id}
                        disabled={renamingId !== null || deletingId !== null}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Rename ${route.name}`}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        onClick={() => setPendingDelete(route.wahoo ?? null)}
                        loading={deletingId === route.wahoo.id}
                        disabled={renamingId !== null || deletingId !== null}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${route.name}`}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <Button asChild size="icon-sm" variant="ghost">
                      <a
                        href={stravaRouteUrl(route.id)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${route.name} on Strava`}
                        title="Open on Strava"
                      >
                        <ExternalLinkIcon className="size-4" />
                      </a>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      {mode === "manage" && (
        <>
          <RouteNameDialog
            open={renameTarget !== null}
            onOpenChange={(next) => {
              if (!next) setRenameTarget(null)
            }}
            defaultName={renameTarget?.name ?? ""}
            confirmLabel="Rename"
            onConfirm={(newName) => {
              if (renameTarget) setPendingRename({ route: renameTarget, newName })
              setRenameTarget(null)
            }}
          />

          <AlertDialog open={pendingRename !== null} onOpenChange={(next) => !next && setPendingRename(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Rename route?</AlertDialogTitle>
                <AlertDialogDescription>
                  Rename "{pendingRename?.route.name}" to "{pendingRename?.newName}" on Wahoo?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleConfirmRename}>Rename</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete route?</AlertDialogTitle>
                <AlertDialogDescription>
                  Delete "{pendingDelete?.name}" from Wahoo? This can't be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleConfirmDelete} className="bg-red-600 text-white hover:bg-red-700">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </>
  )
}
