import { PencilIcon, Trash2Icon } from "lucide-react"
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
import { RouteNameDialog } from "@/components/RouteNameDialog"
import { importWahooRoute } from "@/lib/api"
import { toast, updateToast } from "@/lib/toast"
import { deleteWahooRoute, listWahooRoutes, updateWahooRouteName, type WahooRoute } from "@/lib/wahooApi"
import { getValidWahooAccessToken } from "@/lib/wahooSettings"

export type WahooRoutesDialogProps =
  | { open: boolean; onOpenChange: (open: boolean) => void; mode: "import"; onImport: (file: File) => void }
  | { open: boolean; onOpenChange: (open: boolean) => void; mode: "manage" }

export function WahooRoutesDialog(props: WahooRoutesDialogProps) {
  const { open, onOpenChange, mode } = props
  const [routes, setRoutes] = useState<WahooRoute[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [importingId, setImportingId] = useState<number | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [renameTarget, setRenameTarget] = useState<WahooRoute | null>(null)
  const [pendingRename, setPendingRename] = useState<{ route: WahooRoute; newName: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WahooRoute | null>(null)

  // Kept in a ref so the fetch effect below can depend on `open` alone -
  // onOpenChange is recreated on every parent render, and including it as a
  // dep would re-run the effect (re-fetching the list) on every unrelated
  // re-render while the dialog is open. toast() itself is a stable
  // module-level import, so it doesn't need the same treatment.
  const onOpenChangeRef = useRef(onOpenChange)
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
        toast(err instanceof Error ? err.message : "Failed to load Wahoo routes.", "error")
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
    if (mode !== "import") return
    setImportingId(route.id)
    try {
      const { blob } = await importWahooRoute(route.fileUrl)
      const file = new File([blob], `${route.name || "wahoo-route"}.gpx`, { type: "application/gpx+xml" })
      props.onImport(file)
      onOpenChange(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to import the Wahoo route.", "error")
    } finally {
      setImportingId(null)
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
      setRoutes((prev) => (prev ? prev.map((r) => (r.id === route.id ? { ...r, name: newName } : r)) : prev))
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
      setRoutes((prev) => (prev ? prev.filter((r) => r.id !== route.id) : prev))
      updateToast(toastId, `Deleted "${route.name}".`, "success")
    } catch (err) {
      updateToast(toastId, err instanceof Error ? err.message : "Failed to delete the route.", "error")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="top-0 left-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-0">
          <DialogHeader>
            <DialogTitle>{mode === "import" ? "Import from Wahoo" : "Manage Wahoo routes"}</DialogTitle>
            <DialogDescription>
              {mode === "import"
                ? "Pick a route from your Wahoo account to import."
                : "Rename or delete routes in your Wahoo account."}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading your routes…</p>
          ) : routes && routes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routes in your Wahoo account.</p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {routes?.map((route) => (
                <li key={route.id} className="flex items-center gap-2">
                  <span className="flex-1 text-sm">
                    {route.name} - {(route.distanceM / 1000).toFixed(1)}km
                  </span>
                  {mode === "import" ? (
                    <Button
                      onClick={() => handleImport(route)}
                      loading={importingId === route.id}
                      disabled={importingId !== null}
                      size="sm"
                    >
                      Import
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={() => setRenameTarget(route)}
                        loading={renamingId === route.id}
                        disabled={renamingId !== null || deletingId !== null}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Rename ${route.name}`}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        onClick={() => setPendingDelete(route)}
                        loading={deletingId === route.id}
                        disabled={renamingId !== null || deletingId !== null}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${route.name}`}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </>
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
