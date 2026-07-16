// Minimal imperative toast store - a module-level list + listener set, same
// plain-function style as wahooSettings.ts, no context provider needed.
// toast()/updateToast()/dismissToast() are called directly from wherever an
// action happens; components subscribe via useToasts().
import { useEffect, useState } from "react"

export type ToastVariant = "loading" | "success" | "error"

export interface ToastEntry {
  id: string
  message: string
  variant: ToastVariant
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

function scheduleAutoDismiss(id: string, variant: ToastVariant) {
  clearTimer(id)
  // "loading" toasts persist until explicitly resolved via updateToast/
  // dismissToast - only success/error auto-dismiss.
  if (variant === "loading") return
  timers.set(
    id,
    setTimeout(() => dismissToast(id), AUTO_DISMISS_MS),
  )
}

export function toast(message: string, variant: ToastVariant = "success"): string {
  const id = crypto.randomUUID()
  toasts = [...toasts, { id, message, variant }]
  scheduleAutoDismiss(id, variant)
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
