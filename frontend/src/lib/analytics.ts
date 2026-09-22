import { UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from "@/lib/analyticsConfig"

declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void }
  }
}

// Injected imperatively (not a static <script> in index.html like Tally's)
// specifically so an unset website id means zero network calls to Umami at
// all - the supported way to ship analytics-free local dev and opt-out
// self-hosted/RPi deployments, rather than a tag that always loads and
// errors out with an empty data-website-id.
export function initAnalytics() {
  if (!UMAMI_WEBSITE_ID) return

  const script = document.createElement("script")
  script.async = true
  script.src = UMAMI_SCRIPT_URL
  script.dataset.websiteId = UMAMI_WEBSITE_ID
  document.head.appendChild(script)
}

export type AnalyticsEvent =
  | "route_imported"
  | "gpx_parse_failed"
  | "find_pois_run"
  | "find_pois_failed"
  | "route_saved"
  | "route_save_failed"
  | "route_sent_to_wahoo"
  | "route_send_to_wahoo_failed"
  | "wahoo_connect_initiated"
  | "wahoo_connect_succeeded"
  | "wahoo_connect_failed"
  | "route_planning_started"
  | "route_shape_changed"
  | "routing_options_changed"
  | "route_planning_done"
  | "place_search_picked"
  | "place_added_to_route"

// Never throws and never assumes window.umami is present - it may be
// missing from an ad-blocker, an unset website id, or the script still
// loading, none of which should ever be able to break a caller's flow.
export function track(event: AnalyticsEvent, properties?: Record<string, string | number | boolean>) {
  try {
    window.umami?.track(event, properties)
  } catch {
    // best-effort
  }
}
