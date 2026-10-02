// What a signed-in account brings with it: its connected apps, its settings
// (riding/walking speed per activity), and - once, on sign-in - an offer to
// move what this browser held from before accounts existed into it.
//
// The account is the source of truth for a signed-in visitor. Its speeds are
// copied into the browser's usual localStorage keys on sign-in, so the rest
// of the app keeps reading them through settings.ts unchanged, and a change
// is written to both. Anonymous visitors keep using localStorage alone.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchProfileSettings, saveProfileSettings, type ProfileSettings } from "@/lib/accountApi"
import {
  fetchConnections,
  findConnection,
  importConnection,
  withConnection,
  type Connection,
  type Provider,
} from "@/lib/connections"
import { clearLegacyConnection, loadLegacyConnections, localAvgSpeeds, type LegacyConnection } from "@/lib/localData"
import { loadAvgSpeedKmh, saveAvgSpeedKmh } from "@/lib/settings"
import { toast } from "@/lib/toast"
import type { Account } from "@/types/account"

const NO_CONNECTIONS: Connection[] = []

// Typing a speed fires a change per keystroke; one save after a pause.
const SETTINGS_SAVE_DEBOUNCE_MS = 800

export interface LocalDataOffer {
  connections: LegacyConnection[]
  // Speeds for activities the account has no value for yet.
  avgSpeedKmh: Record<string, number>
}

export interface ImportOutcome {
  // Apps whose connection had expired and must be connected again.
  failed: Provider[]
}

export function useAccountData(
  account: Account | null,
  mapStyleKey: string,
  onAvgSpeedLoaded: (speedKmh: number) => void,
) {
  // Held with the account they belong to, so signing out (or in as someone
  // else) shows none of it without a reset.
  const [loaded, setLoaded] = useState<{ accountId: string; connections: Connection[] } | null>(null)
  const [pendingOffer, setPendingOffer] = useState<{ accountId: string; offer: LocalDataOffer } | null>(null)
  const serverSettings = useRef<ProfileSettings>({ avg_speed_kmh: {} })
  const saveTimer = useRef<number | null>(null)
  // Read inside the sign-in effect without re-running it on every switch.
  const styleRef = useRef(mapStyleKey)
  const onLoadedRef = useRef(onAvgSpeedLoaded)
  useEffect(() => {
    styleRef.current = mapStyleKey
    onLoadedRef.current = onAvgSpeedLoaded
  }, [mapStyleKey, onAvgSpeedLoaded])

  const accountId = account?.id ?? null
  const verified = account?.email_verified ?? false
  const connections = useMemo(
    () => (loaded && loaded.accountId === accountId ? loaded.connections : NO_CONNECTIONS),
    [loaded, accountId],
  )
  const offer = pendingOffer && pendingOffer.accountId === accountId ? pendingOffer.offer : null

  const setConnections = useCallback(
    (next: Connection[]) => {
      if (accountId !== null) setLoaded({ accountId, connections: next })
    },
    [accountId],
  )

  useEffect(() => {
    serverSettings.current = { avg_speed_kmh: {} }
    if (accountId === null) return
    let cancelled = false
    void (async () => {
      const [fetchedConnections, settings] = await Promise.all([
        fetchConnections().catch(() => [] as Connection[]),
        fetchProfileSettings().catch(() => null),
      ])
      if (cancelled) return
      setLoaded({ accountId, connections: fetchedConnections })
      if (settings) {
        serverSettings.current = settings
        for (const [style, speed] of Object.entries(settings.avg_speed_kmh)) saveAvgSpeedKmh(style, speed)
        onLoadedRef.current(loadAvgSpeedKmh(styleRef.current))
      }

      // Only a verified account can hold connections, so wait for that
      // before offering to move them in.
      if (!verified) return
      const legacy = loadLegacyConnections().filter((c) => {
        // The account already has this app: it wins, the old copy goes.
        if (findConnection(fetchedConnections, c.provider)) {
          clearLegacyConnection(c.provider)
          return false
        }
        return true
      })
      const known = settings?.avg_speed_kmh ?? {}
      const speeds = Object.fromEntries(Object.entries(localAvgSpeeds()).filter(([style]) => !(style in known)))
      if (legacy.length > 0 || (settings && Object.keys(speeds).length > 0)) {
        setPendingOffer({ accountId, offer: { connections: legacy, avgSpeedKmh: speeds } })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, verified])

  const saveSettings = useCallback(async (settings: ProfileSettings) => {
    await saveProfileSettings(settings)
    serverSettings.current = settings
  }, [])

  // A speed edit: kept in the browser as always, and in the account too.
  const handleAvgSpeedSaved = useCallback(
    (style: string, speedKmh: number) => {
      if (accountId === null) return
      const next = { ...serverSettings.current, avg_speed_kmh: { ...serverSettings.current.avg_speed_kmh, [style]: speedKmh } }
      serverSettings.current = next
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null
        saveSettings(next).catch((err) =>
          toast(err instanceof Error ? err.message : "Couldn't save your settings to your account.", "error"),
        )
      }, SETTINGS_SAVE_DEBOUNCE_MS)
    },
    [accountId, saveSettings],
  )

  // Moves what the offer listed into the account. A connection that has
  // expired can't be moved; it's dropped from the browser either way, since
  // the server never uses a browser-held token again.
  const acceptOffer = useCallback(async (): Promise<ImportOutcome> => {
    if (!offer) return { failed: [] }
    const failed: Provider[] = []
    let next = connections
    for (const legacy of offer.connections) {
      try {
        next = withConnection(next, await importConnection(legacy.provider, legacy.refreshToken, legacy.scope))
      } catch {
        failed.push(legacy.provider)
      }
      clearLegacyConnection(legacy.provider)
    }
    setConnections(next)
    if (Object.keys(offer.avgSpeedKmh).length > 0) {
      await saveSettings({
        ...serverSettings.current,
        avg_speed_kmh: { ...serverSettings.current.avg_speed_kmh, ...offer.avgSpeedKmh },
      })
    }
    setPendingOffer(null)
    return { failed }
  }, [offer, connections, setConnections, saveSettings])

  // "Not now": the browser's own copy stays as it is, and is offered again
  // next time this account signs in here.
  const dismissOffer = useCallback(() => setPendingOffer(null), [])

  return { connections, setConnections, offer, acceptOffer, dismissOffer, handleAvgSpeedSaved }
}
