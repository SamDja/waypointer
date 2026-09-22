// Minimal imperative toast store - a module-level list + listener set, same
// plain-function style as wahooSettings.ts, no context provider needed.
// toast()/updateToast()/dismissToast() are called directly from wherever an
// action happens; components subscribe via useToasts().
import { useEffect, useState } from "react"

// "info" is a neutral message - e.g. a question offered with actions.
export type ToastVariant = "loading" | "success" | "error" | "info"

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastEntry {
  id: string
  message: string
  variant: ToastVariant
  // Buttons that act on the toast; clicking one also dismisses it.
  actions?: ToastAction[]
}

const AUTO_DISMISS_MS = 5000

let toasts: ToastEntry[] = []
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function notify() {
  for (const listener of listeners) listener()
}

function clearTimer(id: string) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

function scheduleAutoDismiss(id: string, variant: ToastVariant, hasActions = false) {
  clearTimer(id)
  // "loading" toasts persist until explicitly resolved via updateToast/
  // dismissToast, and a toast offering actions stays until one is chosen
  // (or it's closed) - a question shouldn't vanish before it's answered.
  if (variant === "loading" || hasActions) return
  timers.set(
    id,
    setTimeout(() => dismissToast(id), AUTO_DISMISS_MS),
  )
}

export function toast(message: string, variant: ToastVariant = "success", actions?: ToastAction[]): string {
  const id = crypto.randomUUID()
  toasts = [...toasts, { id, message, variant, actions }]
  scheduleAutoDismiss(id, variant, actions !== undefined && actions.length > 0)
  notify()
  return id
}

export function updateToast(id: string, message: string, variant: ToastVariant): void {
  toasts = toasts.map((t) => (t.id === id ? { ...t, message, variant } : t))
  scheduleAutoDismiss(id, variant)
  notify()
}

export function dismissToast(id: string): void {
  clearTimer(id)
  toasts = toasts.filter((t) => t.id !== id)
  notify()
}

export function useToasts(): ToastEntry[] {
  const [snapshot, setSnapshot] = useState(toasts)
  useEffect(() => {
    const listener = () => setSnapshot(toasts)
    listeners.add(listener)
    listener()
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return snapshot
}
