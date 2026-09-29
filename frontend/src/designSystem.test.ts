/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Guards the design system (frontend/DESIGN.md) by reading the source as
// text: the drift it catches - a radius picked by hand, a shadow or palette
// step used directly, a clickable primitive without a pointer, a ui/
// component missing from the style guide - is invisible to the type checker
// and easy to miss in review. Each failure names file:line.

const SRC = import.meta.dirname
const UI_DIR = path.join(SRC, "components", "ui")
const STYLE_GUIDE = path.join(SRC, "styleguide", "StyleGuide.tsx")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

// Everything that renders UI. The style guide is left out: its prose names
// the very classes these rules forbid.
const FILES = [path.join(SRC, "App.tsx"), ...walk(path.join(SRC, "components")), ...walk(path.join(SRC, "lib"))].filter(
  (file) => file.endsWith(".tsx") || file.startsWith(UI_DIR),
)

const rel = (file: string) => path.relative(SRC, file)

// Blank out comments (keeping line breaks, so line numbers still hold):
// prose like "rounded to 2 decimals" or "shadow-lg lifts it" isn't a class.
function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ")
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, blank)
}

const SOURCES = FILES.map((file) => ({ file, text: stripComments(readFileSync(file, "utf8")) }))

interface Exception {
  file: string
  match: string
  reason: string
}

// A match is allowed only if listed here, with why.
const EXCEPTIONS: Exception[] = [
  {
    file: "components/ui/button.tsx",
    match: "text-[0.8rem]",
    reason: "shadcn's sm button text, deliberately between text-xs and text-sm",
  },
]

function violations(pattern: RegExp, isAllowed: (match: string) => boolean = () => false): string[] {
  const found: string[] = []
  for (const { file, text } of SOURCES) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(pattern)) {
        const match = m[1] ?? m[0]
        if (isAllowed(match)) continue
        if (EXCEPTIONS.some((e) => e.file === rel(file) && e.match === match)) continue
        found.push(`${rel(file)}:${i + 1}  ${match}`)
      }
    })
  }
  return found
}

describe("design system", () => {
  it("uses only the radius tiers", () => {
    const allowed =
      /^rounded(-(t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?-(surface|control|item|indicator|swatch|full|none)$/
    const found = violations(/(?<![\w-])(rounded(?:-[\w[\]().,%*/+-]+)?)(?![\w])/g, (m) => allowed.test(m))
    expect(found, "use rounded-surface / -control / -item (or -indicator, -full, -swatch) - see DESIGN.md").toEqual([])
  })

  it("uses only the elevation tokens", () => {
    const found = violations(/(?<![\w-])(shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl)|-\[[^\]]*\])?)(?![\w-])/g)
    expect(found, "use shadow-raised / shadow-floating (or shadow-none)").toEqual([])
  })

  it("uses the type scale, not arbitrary font sizes", () => {
    const found = violations(/(?<![\w-])(text-\[\d[^\]]*\])/g)
    expect(found, "use text-3xs / text-2xs / text-xs ...").toEqual([])
  })

  it("uses colour roles, not palette steps", () => {
    const palette =
      "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|olive|mist|taupe|mauve"
    const found = violations(
      new RegExp(`(?<![\\w-])((?:bg|text|border|ring|fill|stroke|outline|divide)-(?:${palette})-\\d{2,3})(?![\\w])`, "g"),
    )
    expect(found, "use a colour role (bg-muted, text-warning, ...) - data colours go through tailwindcss/colors").toEqual(
      [],
    )
  })

  it("gives every hoverable ui/ class string a pointer (or other) cursor", () => {
    const found: string[] = []
    for (const file of walk(UI_DIR)) {
      for (const group of classGroups(stripComments(readFileSync(file, "utf8")))) {
        const classes = group.strings.join(" ")
        if (/(^|\s|:)hover:/.test(classes) && !/(^|\s)(hover:)?cursor-(pointer|grab|text)(\s|$)/.test(classes)) {
          found.push(`${rel(file)}:${group.line}`)
        }
      }
    }
    expect(found, "add cursor-pointer: Tailwind v4 resets buttons to cursor: default").toEqual([])
  })

  it("closes every ui/ dialog and toast with the shared close button", () => {
    const found: string[] = []
    for (const file of walk(UI_DIR)) {
      const text = readFileSync(file, "utf8")
      for (const m of text.matchAll(/<(\w+Primitive\.Close)\b[^>]*>/g)) {
        const tag = m[0]
        // A bare <X.Close {...props} /> is the headless DialogClose wrapper,
        // styled by whatever it's used on.
        if (!/className/.test(tag)) continue
        const next = text.slice(m.index, m.index + 400)
        if (!next.includes("closeButtonClass")) {
          found.push(`${rel(file)}:${text.slice(0, m.index).split("\n").length}`)
        }
      }
    }
    expect(found, "style a Close with closeButtonClass from ui/close-button.ts").toEqual([])
  })

  it("documents every ui/ file and shared piece in the style guide", () => {
    const guide = readFileSync(STYLE_GUIDE, "utf8")
    // Imported, or named in an entry's source (toast.tsx is shown through
    // Toaster, never imported directly).
    const required = [
      ...walk(UI_DIR).map((file) => `components/ui/${path.basename(file).replace(/\.tsx?$/, "")}`),
      ...["FloatingSurface", "StepCard", "PoiListItem", "PoiTypeCombobox"].map((name) => `components/${name}`),
    ]
    expect(
      required.filter((spec) => !guide.includes(spec)),
      "add it to src/styleguide/StyleGuide.tsx",
    ).toEqual([])
  })
})

interface ClassGroup {
  line: number
  strings: string[]
}

// Groups string literals that end up in one element's class list: all the
// literals inside one cn(...) call count together (a later argument may add
// the hover to a base that already has the cursor), and so does a cva(...)
// base with its variants. Any other literal stands on its own.
function classGroups(text: string): ClassGroup[] {
  const groups: ClassGroup[] = []
  const lineAt = (index: number) => text.slice(0, index).split("\n").length
  let i = 0
  const readString = (start: number): [string, number] => {
    const quote = text[start]
    let j = start + 1
    while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1
    return [text.slice(start + 1, j), j + 1]
  }
  while (i < text.length) {
    const call = /^(cn|cva)\(/.exec(text.slice(i, i + 4))
    if (call && !/[\w.]/.test(text[i - 1] ?? "")) {
      const start = i
      let depth = 0
      const strings: string[] = []
      let j = i + call[1].length
      for (; j < text.length; j++) {
        const c = text[j]
        if (c === '"' || c === "'" || c === "`") {
          const [value, end] = readString(j)
          strings.push(value)
          j = end - 1
        } else if (c === "(") depth++
        else if (c === ")" && --depth === 0) break
      }
      groups.push({ line: lineAt(start), strings })
      i = j + 1
      continue
    }
    const c = text[i]
    if (c === '"' || c === "'" || c === "`") {
      const [value, end] = readString(i)
      groups.push({ line: lineAt(i), strings: [value] })
      i = end
      continue
    }
    i++
  }
  return groups
}
