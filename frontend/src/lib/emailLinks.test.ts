import { describe, expect, it } from "vitest"
import { parseEmailLink, withoutEmailLinkParams } from "./emailLinks"

const TOKEN = "Abc_def-ghijklmnopqrstuvwxyz0123456789ABCD"

describe("parseEmailLink", () => {
  it("reads each kind of link", () => {
    expect(parseEmailLink(`?verify=${TOKEN}`)).toEqual({ kind: "verify", token: TOKEN })
    expect(parseEmailLink(`?reset=${TOKEN}`)).toEqual({ kind: "reset", token: TOKEN })
    expect(parseEmailLink(`?confirm-email=${TOKEN}`)).toEqual({ kind: "confirm-email", token: TOKEN })
    expect(parseEmailLink("?signin=forgot")).toEqual({ kind: "forgot" })
  })

  it("ignores anything else", () => {
    expect(parseEmailLink("")).toBeNull()
    expect(parseEmailLink("?foo=bar")).toBeNull()
    expect(parseEmailLink("?signin=elsewhere")).toBeNull()
    // Not shaped like one of our tokens: never sent to the server.
    expect(parseEmailLink("?verify=short")).toBeNull()
    expect(parseEmailLink("?reset=<script>alert(1)</script>xxxxxxxxxxxxxxx")).toBeNull()
  })
})

describe("withoutEmailLinkParams", () => {
  it("drops only the link parameters", () => {
    expect(withoutEmailLinkParams(`https://sullavia.example/?verify=${TOKEN}&debug=1#map`)).toBe(
      "https://sullavia.example/?debug=1#map",
    )
    expect(withoutEmailLinkParams("https://sullavia.example/?signin=forgot")).toBe("https://sullavia.example/")
  })
})
