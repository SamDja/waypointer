// The fitness apps connected to the signed-in account (backend
// connections.py). Connecting needs a verified account; the tokens are kept
// on the server, encrypted, and never reach the browser - all it ever knows
// is which apps are connected and under what name.
import { request } from "@/lib/api"
import type { ConnectionResponse } from "@/types/candidate"

export type Provider = ConnectionResponse["provider"]

export const PROVIDER_NAMES: Record<Provider, string> = { strava: "Strava", wahoo: "Wahoo" }

export interface Connection {
  provider: Provider
  label: string | null
  scope: string | null
}

export function fromConnectionResponse(data: ConnectionResponse): Connection {
  return { provider: data.provider, label: data.label, scope: data.scope }
}

export function findConnection(connections: Connection[], provider: Provider): Connection | null {
  return connections.find((c) => c.provider === provider) ?? null
}

export async function fetchConnections(): Promise<Connection[]> {
  const response = await request(
    "/api/connections",
    {},
    { failed: "Couldn't load your connected apps - please try again in a moment." },
  )
  return ((await response.json()) as ConnectionResponse[]).map(fromConnectionResponse)
}

// Revokes the app's access at its end, then forgets the connection - the
// server forgets it even if the app couldn't be reached.
export async function disconnectApp(provider: Provider): Promise<void> {
  await request(
    `/api/connections/${provider}/disconnect`,
    { method: "POST" },
    { failed: `Couldn't disconnect from ${PROVIDER_NAMES[provider]} - please try again in a moment.` },
  )
}

// Moves a connection this browser held before accounts existed into the
// account (see lib/localData.ts). Only the refresh token is sent: the server
// spends it at once, which proves it's still live and leaves the browser's
// copy worthless.
export async function importConnection(
  provider: Provider,
  refreshToken: string,
  scope: string | undefined,
): Promise<Connection> {
  const form = new FormData()
  form.append("provider", provider)
  form.append("refresh_token", refreshToken)
  if (scope) form.append("scope", scope)
  const response = await request(
    "/api/connections/import",
    { method: "POST", body: form },
    { failed: `Couldn't move your ${PROVIDER_NAMES[provider]} connection - please try again in a moment.` },
  )
  return fromConnectionResponse((await response.json()) as ConnectionResponse)
}

// `connections` with `next` added, replacing any earlier one for its app.
export function withConnection(connections: Connection[], next: Connection): Connection[] {
  return [...connections.filter((c) => c.provider !== next.provider), next]
}

export function withoutConnection(connections: Connection[], provider: Provider): Connection[] {
  return connections.filter((c) => c.provider !== provider)
}
