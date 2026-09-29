import { CircleAlertIcon, ExternalLinkIcon, PencilIcon, RotateCwIcon, Trash2Icon } from "lucide-react"
import { useEffect, useState } from "react"
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
import { hasStravaActivityScope } from "@/lib/stravaAuth"
import {
  importStravaActivity,
  importStravaRoute,
  listStravaActivities,
  listStravaRoutes,
  stravaRouteUrl,
  stravaSportLabel,
  type StravaActivity,
} from "@/lib/stravaApi"
import { getValidStravaTokens, loadStravaTokens } from "@/lib/stravaSettings"
import { toast, updateToast } from "@/lib/toast"
import { deleteWahooRoute, listWahooRoutes, updateWahooRouteName, type WahooRoute } from "@/lib/wahooApi"
import { getValidWahooAccessToken } from "@/lib/wahooSettings"
import { Callout } from "@/components/ui/callout"

// Which connected app a route lives in.
export type RouteSource = "wahoo" | "strava"

const SOURCE_NAMES: Record<RouteSource, string> = { wahoo: "Wahoo", strava: "Strava" }

// One route from any connected app, as the dialog lists it - a saved
// route, or (Strava only) a recorded activity whose track can be followed
// again. Only Wahoo's API can rename or delete a route - Strava's is
// read-only - so a Wahoo route keeps what those calls need.
interface RemoteRoute {
  source: RouteSource
  kind: "route" | "activity"
  // Unique across sources and kinds - two apps can hand out the same id.
  key: string
  id: string
  name: string
  // What the row says it is: "Route", or the activity's sport.
  label: string
  distanceM: number
  // Total climb, as the app reports it.
  ascentM: number
  // When it was created, or for an activity, when it was recorded.
  createdAt: string
  wahoo?: WahooRoute
}

function fromWahoo(route: WahooRoute): RemoteRoute {
  return {
    source: "wahoo",
    kind: "route",
    key: `wahoo:${route.id}`,
    id: String(route.id),
    name: route.name,
    label: "Route",
    distanceM: route.distanceM,
    ascentM: route.ascentM,
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

function fromStravaActivity(activity: StravaActivity): RemoteRoute {
  return {
    source: "strava",
    kind: "activity",
    key: `strava-activity:${activity.id}`,
    id: activity.id,
    name: activity.name,
    label: stravaSportLabel(activity.sportType),
    distanceM: activity.distanceM,
    ascentM: activity.ascentM,
    createdAt: activity.startDate,
  }
}

// One page of Strava activities, as dialog rows - they come a page at a
// time (the backend's strava.ACTIVITIES_PER_PAGE, 20), since an athlete
// can have thousands.
async function loadActivityPage(page: number): Promise<{ routes: RemoteRoute[]; hasMore: boolean }> {
  const tokens = await getValidStravaTokens()
  const { activities, hasMore } = await listStravaActivities(tokens.accessToken, page)
  return { routes: activities.map(fromStravaActivity), hasMore }
}

// One thing the dialog lists on its own, so one failing still shows the rest.
interface Listing {
  source: RouteSource
  // What the dialog says when this one couldn't be loaded.
  failed: string
  // `hasMore` is only set by a paged listing (activities).
  load: () => Promise<{ routes: RemoteRoute[]; hasMore?: boolean }>
}

function listings(wahooConnected: boolean, stravaConnected: boolean, withActivities: boolean): Listing[] {
  const result: Listing[] = []
  if (wahooConnected) {
    result.push({
      source: "wahoo",
      failed: "Couldn't load your Wahoo routes.",
      load: async () => ({ routes: (await listWahooRoutes(await getValidWahooAccessToken())).map(fromWahoo) }),
    })
  }
  if (stravaConnected) {
    result.push({
      source: "strava",
      failed: "Couldn't load your Strava routes.",
      load: async () => {
        const tokens = await getValidStravaTokens()
        const routes = await listStravaRoutes(tokens.accessToken, tokens.athleteId)
        return {
          routes: routes.map((route) => ({
            source: "strava",
            kind: "route",
            key: `strava:${route.id}`,
            id: route.id,
            name: route.name,
            label: "Route",
            distanceM: route.distanceM,
            ascentM: route.ascentM,
            createdAt: route.createdAt,
          })),
        }
      },
    })
    // A connection made before activity import can't list activities: the
    // routes still show, and the dialog says how to get the rest.
    if (withActivities && hasStravaActivityScope(loadStravaTokens()?.scope)) {
      result.push({
        source: "strava",
        failed: "Couldn't load your Strava activities.",
        // Just the first page; "Load more activities" fetches the rest.
        load: () => loadActivityPage(1),
      })
    }
  }
  return result
}

async function downloadAsGpx(route: RemoteRoute): Promise<Blob> {
  if (route.source === "wahoo" && route.wahoo) {
    return (await importWahooRoute(route.wahoo.fileUrl)).blob
  }
  const tokens = await getValidStravaTokens()
  return route.kind === "activity"
    ? importStravaActivity(route.id, route.name, tokens.accessToken)
    : importStravaRoute(route.id, tokens.accessToken)
}

// A listing that couldn't be loaded, and why - kept on screen rather than
// toasted, since toasts sit under this full-screen dialog.
interface ListingFailure {
  source: RouteSource
  failed: string
  // The request's own message (already fit to show), when it adds something
  // - a wait time, or "disconnect and reconnect".
  reason: string | null
}

function SourceBadge({ source }: { source: RouteSource }) {
  return (
    <span className="flex items-center" title={SOURCE_NAMES[source]}>
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
  const [failures, setFailures] = useState<ListingFailure[]>([])
  const [importError, setImportError] = useState<string | null>(null)
  // Bumped by "Try again" to re-run the load below.
  const [reloadCount, setReloadCount] = useState(0)
  // Activities come a page at a time: the last page loaded, whether Strava
  // may have more, and the "Load more activities" request in flight.
  const [activityPage, setActivityPage] = useState(0)
  const [activitiesHaveMore, setActivitiesHaveMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    // Activities are only offered to import - there's nothing to manage on
    // one, and "Manage routes" is about routes.
    const toLoad = listings(wahooConnected, stravaConnected, mode === "import")
    let cancelled = false
    setIsLoading(true)
    setRoutes(null)
    setFailures([])
    setImportError(null)
    setActivityPage(0)
    setActivitiesHaveMore(false)
    setLoadMoreError(null)
    ;(async () => {
      const results = await Promise.allSettled(toLoad.map((listing) => listing.load()))
      if (cancelled) return
      const loaded: RemoteRoute[] = []
      const failed: ListingFailure[] = []
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          loaded.push(...result.value.routes)
          if (result.value.hasMore !== undefined) {
            setActivityPage(1)
            setActivitiesHaveMore(result.value.hasMore)
          }
        } else {
          const { source, failed: message } = toLoad[i]
          const reason = result.reason instanceof Error ? result.reason.message : null
          // A server error's message only restates the headline, so it's
          // dropped; a wait time or "reconnect" is kept.
          const restates = reason !== null && reason.startsWith(message.replace(/\.$/, ""))
          failed.push({ source, failed: message, reason: restates ? null : reason })
        }
      })
      setIsLoading(false)
      setFailures(failed)
      setRoutes(loaded.sort(byNewest))
    })()
    return () => {
      cancelled = true
    }
  }, [open, mode, wahooConnected, stravaConnected, reloadCount])

  async function handleLoadMoreActivities() {
    const next = activityPage + 1
    setIsLoadingMore(true)
    setLoadMoreError(null)
    try {
      const { routes: more, hasMore } = await loadActivityPage(next)
      setRoutes((prev) => {
        const known = new Set(prev?.map((r) => r.key))
        // A new activity recorded meanwhile shifts Strava's pages by one, so
        // the next page can repeat the last one's final activity.
        return [...(prev ?? []), ...more.filter((r) => !known.has(r.key))].sort(byNewest)
      })
      setActivityPage(next)
      setActivitiesHaveMore(hasMore)
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : "Couldn't load more Strava activities.")
    } finally {
      setIsLoadingMore(false)
    }
  }

  async function handleImport(route: RemoteRoute) {
    if (mode !== "import") return
    setImportingKey(route.key)
    setImportError(null)
    try {
      const blob = await downloadAsGpx(route)
      const file = new File([blob], `${route.name || `${route.source}-route`}.gpx`, { type: "application/gpx+xml" })
      props.onImport(file, route.source)
      onOpenChange(false)
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : `Couldn't import "${route.name}" from ${SOURCE_NAMES[route.source]}.`,
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

  // Read when the dialog renders: connecting again (from the fitness-apps
  // dialog) updates the stored scope, and the dialog is closed meanwhile.
  const activitiesNeedReconnect =
    mode === "import" && stravaConnected && !hasStravaActivityScope(loadStravaTokens()?.scope)

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
              {mode === "import"
                ? stravaConnected
                  ? "Pick a route, or an activity to ride again, from your fitness apps."
                  : "Pick a route from your fitness apps to import."
                : manageDescription}
            </DialogDescription>
          </DialogHeader>

          {/* Inline rather than a toast: toasts sit under this full-screen
              dialog. */}
          {activitiesNeedReconnect && (
            <p className="text-sm text-muted-foreground">
              To import your Strava activities too, disconnect and reconnect Strava from "Manage fitness apps" -
              it needs your permission to read them.
            </p>
          )}

          {!isLoading && failures.length > 0 && (
            <Callout variant="destructive" role="alert" className="flex-col gap-2 p-3">
              {failures.map((failure) => (
                <div key={failure.failed} className="flex items-start gap-2">
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="flex flex-col">
                    <span className="font-medium">{failure.failed}</span>
                    {failure.reason && <span className="text-muted-foreground">{failure.reason}</span>}
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setReloadCount((count) => count + 1)}
              >
                <RotateCwIcon className="size-4" />
                Try again
              </Button>
            </Callout>
          )}

          {importError && (
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <CircleAlertIcon className="size-4 shrink-0" />
              {importError}
            </p>
          )}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading your routes…</p>
          ) : routes && routes.length === 0 ? (
            // Only claim there's nothing when every app actually answered -
            // a failed one is shown above instead.
            failures.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {mode === "import" && stravaConnected
                  ? "No routes or activities in your connected apps."
                  : "No routes in your connected apps."}
              </p>
            )
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              {/* Scrolls sideways too: six columns don't fit a phone's width. */}
              <table className="w-full min-w-[40rem] text-sm">
                {/* Sticky so the columns stay labelled while a long list scrolls. */}
                <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th scope="col" className="py-2 pr-3 font-medium sm:pr-4">
                      Name
                    </th>
                    <th scope="col" className="w-24 py-2 pr-3 font-medium sm:w-32 sm:pr-4">
                      Type
                    </th>
                    <th scope="col" className="w-20 py-2 pr-3 font-medium sm:w-28 sm:pr-4">
                      Provenance
                    </th>
                    <th scope="col" className="w-24 py-2 pr-3 text-right font-medium sm:pr-4">
                      Distance
                    </th>
                    <th scope="col" className="w-24 py-2 pr-3 text-right font-medium sm:pr-4">
                      <span title="Total climb">Elevation</span>
                    </th>
                    {/* Pinned right, so the row's action stays in reach while a
                        phone scrolls the other columns sideways. */}
                    <th scope="col" className="sticky right-0 w-px bg-background py-2 pl-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {routes?.map((route) => (
                    <tr key={route.key} className="border-b last:border-b-0">
                      <td className="py-2 pr-3 sm:pr-4">
                        {route.name || "(unnamed)"}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground sm:pr-4">{route.label}</td>
                      <td className="py-2 pr-3 sm:pr-4">
                        <SourceBadge source={route.source} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap sm:pr-4">
                        {(route.distanceM / 1000).toFixed(1)} km
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap sm:pr-4">
                        {Math.round(route.ascentM).toLocaleString()} m
                      </td>
                      <td className="sticky right-0 bg-background py-2 pl-2">
                        <div className="flex items-center justify-end gap-1">
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {mode === "import" && activitiesHaveMore && (
                <div className="flex flex-col items-center gap-2 py-4">
                  <Button variant="outline" size="sm" loading={isLoadingMore} onClick={handleLoadMoreActivities}>
                    Load more activities
                  </Button>
                  {loadMoreError && (
                    <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                      <CircleAlertIcon className="size-4 shrink-0" />
                      {loadMoreError}
                    </p>
                  )}
                </div>
              )}
            </div>
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
                <AlertDialogAction variant="destructive-solid" onClick={handleConfirmDelete}>
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
