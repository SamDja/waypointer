import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, NETWORK_ERROR_MESSAGE, cooldownRemainingMs, request } from "./api"

const MESSAGES = { failed: "The search isn't working right now." }

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl)
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error("expected the request to fail")
}

// The cool-down map is module-level, so each test uses its own URL.
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("request", () => {
  it("returns the response when it's ok", async () => {
    stubFetch(async () => jsonResponse(200, { ok: true }))
    const response = await request("/api/ok", {}, MESSAGES)
    expect(await response.json()).toEqual({ ok: true })
  })

  it("turns an unreachable server into a readable message", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch")
    })
    const err = await caught(request("/api/offline", {}, MESSAGES))
    expect(err.message).toBe(NETWORK_ERROR_MESSAGE)
    expect(err.status).toBeUndefined()
  })

  it("rethrows an abort untouched", async () => {
    stubFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError")
    })
    await expect(request("/api/aborted", {}, MESSAGES)).rejects.toMatchObject({ name: "AbortError" })
  })

  it("shows the backend's own 4xx detail, written for the visitor", async () => {
    stubFetch(async () => jsonResponse(400, { detail: "This GPX file has no track or route to follow." }))
    const err = await caught(request("/api/bad-file", {}, MESSAGES))
    expect(err.message).toBe("This GPX file has no track or route to follow.")
    expect(err.status).toBe(400)
  })

  it("never shows a 5xx detail, which carries server internals", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    stubFetch(async () => jsonResponse(502, { detail: "Failed to query the POI database: PostGIS query failed: ..." }))
    const err = await caught(request("/api/db-down", {}, MESSAGES))
    expect(err.message).toBe(MESSAGES.failed)
    expect(err.status).toBe(502)
  })

  it("ignores a third party's detail when told not to trust it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    stubFetch(async () => jsonResponse(422, { detail: "route[name] is invalid" }))
    const err = await caught(request("https://api.example.com/routes", {}, { ...MESSAGES, trustDetail: false }))
    expect(err.message).toBe(MESSAGES.failed)
  })

  it("uses the unauthorized message for a 401 when there is one", async () => {
    stubFetch(async () => new Response("", { status: 401 }))
    const err = await caught(request("/api/needs-auth", {}, { ...MESSAGES, unauthorized: "Reconnect." }))
    expect(err.message).toBe("Reconnect.")
  })

  it("pauses an endpoint for its Retry-After after a 429, without calling it again", async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(async () =>
      jsonResponse(429, { detail: "Too many requests" }, { "Retry-After": "12" }),
    )

    const first = await caught(request("/api/throttled?q=a", {}, MESSAGES))
    expect(first.status).toBe(429)
    expect(first.message).toBe("Too many requests - please wait 12 seconds and try again.")
    // Keyed without the query string: another search is paused too.
    expect(cooldownRemainingMs("/api/throttled?q=b")).toBe(12_000)

    vi.advanceTimersByTime(5_000)
    const second = await caught(request("/api/throttled?q=b", {}, MESSAGES))
    expect(second.message).toBe("Too many requests - please wait 7 seconds and try again.")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(7_000)
    expect(cooldownRemainingMs("/api/throttled")).toBe(0)
    fetchMock.mockImplementation(async () => jsonResponse(200, []))
    await request("/api/throttled?q=c", {}, MESSAGES)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("falls back to a 30 second pause when a 429 has no Retry-After", async () => {
    vi.useFakeTimers()
    stubFetch(async () => new Response("", { status: 429 }))
    const err = await caught(request("/api/throttled-no-header", {}, MESSAGES))
    expect(err.message).toBe("Too many requests - please wait 30 seconds and try again.")
  })

  it("leaves other endpoints alone while one is paused", async () => {
    stubFetch(async () => new Response("", { status: 429, headers: { "Retry-After": "60" } }))
    await caught(request("/api/paused", {}, MESSAGES))
    expect(cooldownRemainingMs("/api/not-paused")).toBe(0)
  })
})
