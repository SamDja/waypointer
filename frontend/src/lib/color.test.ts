import { describe, expect, it } from "vitest"
import colors from "tailwindcss/colors"
import { tailwindHex } from "@/lib/color"

describe("tailwindHex", () => {
  it("converts Tailwind v4 palette colours to sRGB hex", () => {
    // Expected values are what Chromium paints for these colours on an sRGB
    // canvas (checked 2026-09-22), so they're independent of this conversion.
    expect(tailwindHex(colors.blue[500])).toBe("#2b7fff")
    expect(tailwindHex(colors.green[600])).toBe("#00a63e")
    expect(tailwindHex(colors.stone[500])).toBe("#79716b")
  })

  it("handles achromatic steps, whose hue is 'none'", () => {
    expect(colors.neutral[400]).toContain("none")
    expect(tailwindHex(colors.neutral[400])).toBe("#a1a1a1")
  })

  it("clips colours outside the sRGB gamut the way the browser paints them", () => {
    expect(tailwindHex(colors.violet[600])).toBe("#7f22fe")
  })

  it("returns anything that isn't an oklch() colour unchanged", () => {
    expect(tailwindHex("#123456")).toBe("#123456")
    expect(tailwindHex("transparent")).toBe("transparent")
  })
})
