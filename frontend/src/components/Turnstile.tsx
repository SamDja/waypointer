import { useEffect, useRef } from "react"
import { useResolvedTheme } from "@/lib/theme"

// Cloudflare Turnstile site key - public, baked in at build time like
// VITE_WAHOO_CLIENT_ID. Unset (local dev, a deployment without captcha):
// no script is loaded and nothing renders. The backend's own
// TURNSTILE_SECRET_KEY decides whether a token is actually required.
export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      theme: "light" | "dark"
      callback: (token: string) => void
      "expired-callback": () => void
      "error-callback": () => void
    },
  ) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptLoading: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  scriptLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile missing")))
    script.onerror = () => {
      scriptLoading = null
      reject(new Error("Couldn't load the captcha"))
    }
    document.head.appendChild(script)
  })
  return scriptLoading
}

// A token is single use: after a refused submit, remount this (change its
// `key`) to get a fresh challenge.
export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null)
  const theme = useResolvedTheme()
  // The widget is rendered once per theme; a ref keeps its callbacks
  // pointing at the latest onToken without re-rendering it.
  const onTokenRef = useRef(onToken)
  useEffect(() => {
    onTokenRef.current = onToken
  }, [onToken])

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !container.current) return
    const element = container.current
    let widgetId: string | null = null
    let cancelled = false
    loadTurnstile()
      .then((api) => {
        if (cancelled) return
        widgetId = api.render(element, {
          sitekey: TURNSTILE_SITE_KEY,
          theme,
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        })
      })
      .catch(() => onTokenRef.current(null))
    return () => {
      cancelled = true
      if (widgetId !== null) window.turnstile?.remove(widgetId)
    }
  }, [theme])

  if (!TURNSTILE_SITE_KEY) return null
  return <div ref={container} className="min-h-16" />
}
