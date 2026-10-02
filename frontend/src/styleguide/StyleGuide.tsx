import { useState, type ReactNode } from "react"
import {
  ChevronDown,
  Crosshair,
  Layers,
  LocateFixed,
  Minus,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Sun,
  Trash2,
  TriangleAlert,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { Checkbox } from "@/components/ui/checkbox"
import { closeButtonClass } from "@/components/ui/close-button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { floatingSurfaceClass } from "@/components/ui/surface"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { FloatingSurface } from "@/components/FloatingSurface"
import { PoiListItem } from "@/components/PoiListItem"
import { PoiTypeCombobox } from "@/components/PoiTypeCombobox"
import { StepCard } from "@/components/StepCard"
import { Toaster } from "@/components/Toaster"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { Logo } from "@/components/Logo"

// The living style guide: every primitive in components/ui/ and every shared
// app-level piece, in each of its states, next to what it's for. The rules
// behind it are in frontend/DESIGN.md; designSystem.test.ts fails if a ui/
// file isn't imported here, so nothing can skip being documented.

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-6">
      <h2 className="border-b pb-2 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  )
}

// One entry: the component's name and source, what it's for, when (not) to
// use it, and live examples.
function Entry({
  name,
  source,
  use,
  avoid,
  children,
}: {
  name: string
  source: string
  use: ReactNode
  avoid?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
      <div className="flex flex-col gap-1.5 text-sm">
        <h3 className="text-base font-medium">{name}</h3>
        <code className="text-xs text-muted-foreground">{source}</code>
        <p>{use}</p>
        {avoid && (
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Don't: </span>
            {avoid}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-3 rounded-surface border border-dashed p-4">{children}</div>
    </div>
  )
}

const COLOR_ROLES: { role: string; note: string }[] = [
  { role: "background", note: "Page and dialog background" },
  { role: "foreground", note: "Body text" },
  { role: "card", note: "Cards, floating pills" },
  { role: "popover", note: "Menus, popovers, map popups" },
  { role: "primary", note: "The main action, selected state" },
  { role: "primary-strong", note: "Primary's hover" },
  { role: "secondary", note: "Secondary button" },
  { role: "muted", note: "Quiet fills: hover on controls, placeholders" },
  { role: "muted-foreground", note: "Secondary text, icons" },
  { role: "accent", note: "The row you're on (menus, lists)" },
  { role: "border", note: "Borders and dividers" },
  { role: "input", note: "Field borders" },
  { role: "input-hover", note: "Field border on hover" },
  { role: "ring", note: "Focus ring (at /50)" },
  { role: "destructive", note: "Destructive actions" },
  { role: "destructive-surface", note: "Error callout/toast fill" },
  { role: "warning", note: "Warning icon" },
  { role: "warning-surface", note: "Warning callout fill" },
  { role: "success", note: "Success icon" },
  { role: "success-surface", note: "Success callout/toast fill" },
]

// Values are read back from the live CSS on each render, so the page can
// never disagree with index.css. The parent re-renders it on a theme switch.
function ColorSwatches() {
  const style = getComputedStyle(document.documentElement)
  return (
    <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
      {COLOR_ROLES.map(({ role, note }) => (
        <div key={role} className="flex items-center gap-2">
          <span
            className="size-9 shrink-0 rounded-item ring-1 ring-foreground/10"
            style={{ background: `var(--${role})` }}
          />
          <span className="flex min-w-0 flex-col text-xs">
            <span className="font-medium">{role}</span>
            <span className="text-muted-foreground">{note}</span>
            <span className="truncate text-3xs text-muted-foreground">{style.getPropertyValue(`--${role}`).trim()}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function StyleGuide() {
  // ?dark opens the page in dark mode (handy for a headless screenshot).
  const [dark, setDark] = useState(() => {
    const initial = new URLSearchParams(window.location.search).has("dark")
    document.documentElement.classList.toggle("dark", initial)
    return initial
  })
  const toggleDark = () => {
    document.documentElement.classList.toggle("dark", !dark)
    setDark(!dark)
  }
  const [stepOpen, setStepOpen] = useState(true)
  const [poiChecked, setPoiChecked] = useState(true)
  const [poiType, setPoiType] = useState("water")

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b bg-background/90 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <Logo className="w-6" />
            <h1 className="text-lg font-semibold">Sulla Via style guide</h1>
          </div>
          <nav className="hidden gap-4 text-sm md:flex">
            {["foundations", "controls", "surfaces", "patterns"].map((id) => (
              <a key={id} href={`#${id}`} className="capitalize text-muted-foreground hover:text-foreground">
                {id}
              </a>
            ))}
          </nav>
          <Button variant="outline" size="sm" onClick={toggleDark}>
            {dark ? <Sun /> : <Moon />}
            {dark ? "Light" : "Dark"}
          </Button>
        </header>

        <main className="mx-auto flex max-w-6xl flex-col gap-14 px-6 py-10">
          <p className="max-w-3xl text-sm text-muted-foreground">
            Every component in <code>components/ui/</code> and every shared piece of the app, in its states, with
            what it's for. The rules behind it live in <code>frontend/DESIGN.md</code>. Hover the examples: every
            clickable thing should show a pointer.
          </p>

          <Section id="foundations" title="Foundations">
            <Entry
              name="Colour roles"
              source="index.css :root / .dark"
              use="Components use roles (bg-muted, text-warning), never palette steps. Each role is a Tailwind palette step, named beside it in index.css."
              avoid="write bg-olive-300 or text-stone-800 in a component. Data colours (map, elevation bands) come from tailwindcss/colors instead, via lib/color.ts."
            >
              <ColorSwatches key={dark ? "dark" : "light"} />
            </Entry>

            <Entry
              name="Radius tiers"
              source="rounded-surface / rounded-control / rounded-item"
              use={
                <>
                  A <b>surface</b> holds controls, a <b>control</b> holds items. Surfaces: cards, dialogs, menus,
                  popovers, toasts, map popups, floating pills. Controls: buttons, fields, select triggers, tab lists,
                  and bordered panels inset in a card. Items: menu and list rows, tab triggers, tooltips, photos, kbd.
                  rounded-indicator for the checkbox; rounded-full for pills and markers; rounded-swatch only for
                  tiny data marks.
                </>
              }
              avoid="use size-named radii (rounded-md, rounded-xl) or rounded-[…]."
            >
              <div className="flex flex-col gap-2 rounded-surface bg-card p-3 ring-1 ring-foreground/10">
                <span className="text-xs text-muted-foreground">surface</span>
                <div className="flex flex-col gap-2 rounded-control border p-2">
                  <span className="text-xs text-muted-foreground">control</span>
                  <div className="rounded-item bg-accent px-2 py-1 text-sm">item</div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-2 w-3 rounded-swatch bg-primary" /> swatch
              </div>
              <div className="rounded-full bg-secondary px-3 py-1 text-xs">full</div>
            </Entry>

            <Entry
              name="Elevation"
              source="shadow-raised / shadow-floating"
              use="Raised: sits on the page or map (map buttons, menus, popovers). Floating: hovers over the map (sidebar cards, header pills, dialogs, toasts, map popups). Surfaces also carry ring-1 ring-foreground/10 as their outline."
              avoid="use shadow-sm/md/lg or a custom shadow-[…]."
            >
              <div className="rounded-surface bg-card px-4 py-3 text-sm shadow-raised ring-1 ring-foreground/10">
                raised
              </div>
              <div className="rounded-surface bg-card px-4 py-3 text-sm shadow-floating ring-1 ring-foreground/10">
                floating
              </div>
            </Entry>

            <Entry
              name="Type scale"
              source="Geist; text-3xs … text-lg"
              use="text-sm is the default UI size; text-xs for secondary lines. text-2xs (11px) and text-3xs (10px) are only for dense charts, legends and marker numbers."
              avoid="use text-[Npx]."
            >
              <div className="flex flex-col gap-1">
                <span className="text-lg font-semibold">text-lg: card and dialog titles</span>
                <span className="text-base">text-base: step card titles</span>
                <span className="text-sm">text-sm: default UI text</span>
                <span className="text-xs">text-xs: secondary lines, captions</span>
                <span className="text-2xs">text-2xs: chart labels, marker numbers</span>
                <span className="text-3xs">text-3xs: axis ticks, legend edges</span>
              </div>
            </Entry>
          </Section>

          <Section id="controls" title="Controls">
            <Entry
              name="Button"
              source="components/ui/button.tsx"
              use={
                <>
                  <b>default</b> for the one main action of a step; <b>outline</b> for other actions; <b>secondary</b>{" "}
                  for toggles and less important actions; <b>ghost</b> for icon actions in rows; <b>destructive</b>{" "}
                  (soft) for a remove that's easy to undo; <b>destructive-solid</b> only for confirming an irreversible
                  action; <b>link</b> inline in text; <b>map</b> for controls floating over the map or a photo.
                </>
              }
              avoid="restyle a Button with bg-*/shadow-* classes: add or use a variant."
            >
              <div className="flex w-full flex-wrap gap-2">
                <Button>Default</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="destructive-solid">Destructive solid</Button>
                <Button variant="link">Link</Button>
                <Button variant="map" size="icon-sm" aria-label="Map control">
                  <Layers />
                </Button>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2">
                <Button size="xs">xs</Button>
                <Button size="sm">sm</Button>
                <Button>default</Button>
                <Button size="lg">lg</Button>
                <Button size="icon-xs" variant="outline" aria-label="Add">
                  <Plus />
                </Button>
                <Button size="icon-sm" variant="outline" aria-label="Add">
                  <Plus />
                </Button>
                <Button size="icon" variant="outline" aria-label="Add">
                  <Plus />
                </Button>
                <Button loading>Loading</Button>
                <Button disabled>Disabled</Button>
              </div>
            </Entry>

            <Entry
              name="Input, Textarea, InputGroup"
              source="components/ui/input.tsx, textarea.tsx, input-group.tsx"
              use="Text entry. InputGroup when the field carries an icon or button inside its border."
            >
              <Input placeholder="Route name" className="w-56" />
              <Input placeholder="Disabled" disabled className="w-56" />
              <InputGroup className="w-56">
                <InputGroupInput placeholder="Search" />
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
              </InputGroup>
              <Textarea placeholder="Notes" className="w-full" />
            </Entry>

            <Entry
              name="Select"
              source="components/ui/select.tsx"
              use='A short, fixed list of options. In the sidebar use position="popper" so the menu drops below its trigger at the trigger&apos;s width, like the other pickers.'
              avoid="use it for long lists: the POI registry uses PoiTypeCombobox."
            >
              <Select defaultValue="road_cycling">
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="road_cycling">Road cycling</SelectItem>
                  <SelectItem value="hiking">Hiking</SelectItem>
                  <SelectItem value="disabled" disabled>
                    Disabled option
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select defaultValue="a">
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="a">Small trigger</SelectItem>
                  <SelectItem value="b">Other</SelectItem>
                </SelectContent>
              </Select>
            </Entry>

            <Entry
              name="Checkbox + Label"
              source="components/ui/checkbox.tsx, label.tsx"
              use="Include/exclude choices (POIs, waypoints, routing toggles). Always paired with a Label, which is clickable too."
            >
              <div className="flex items-center gap-2">
                <Checkbox id="sg-check-1" defaultChecked />
                <Label htmlFor="sg-check-1">Checked</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="sg-check-2" />
                <Label htmlFor="sg-check-2">Unchecked</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="sg-check-3" disabled />
                <Label htmlFor="sg-check-3">Disabled</Label>
              </div>
            </Entry>

            <Entry
              name="Tabs"
              source="components/ui/tabs.tsx"
              use="Switching between two or three views of the same step (Import / Waypoints, Download / Wahoo)."
              avoid="render a TabsList with a single trigger: drop the Tabs chrome instead."
            >
              <Tabs defaultValue="a" className="w-72">
                <TabsList className="w-full">
                  <TabsTrigger value="a">Route</TabsTrigger>
                  <TabsTrigger value="b">Waypoints</TabsTrigger>
                </TabsList>
                <TabsContent value="a" className="text-muted-foreground">
                  First tab
                </TabsContent>
                <TabsContent value="b" className="text-muted-foreground">
                  Second tab
                </TabsContent>
              </Tabs>
            </Entry>
          </Section>

          <Section id="surfaces" title="Surfaces">
            <Entry
              name="Card"
              source="components/ui/card.tsx"
              use="A block of the sidebar. The steps use it through StepCard."
            >
              <Card className="w-72">
                <CardHeader>
                  <CardTitle>Card title</CardTitle>
                  <CardDescription>Supporting description</CardDescription>
                </CardHeader>
                <CardContent>Content</CardContent>
                <CardFooter>Footer</CardFooter>
              </Card>
            </Entry>

            <Entry
              name="FloatingSurface"
              source="components/FloatingSurface.tsx, components/ui/surface.ts"
              use="Anything floating over the map that isn't a Card: the header pills, the place search, the elevation profile. Use floatingSurfaceClass when the root must be another primitive (cmdk's Command, a Collapsible)."
              avoid="rebuild it from rounded/bg/shadow/ring classes."
            >
              <FloatingSurface className="flex h-11 items-center gap-1.5 px-3">
                <Logo className="w-6" />
                <span className="text-lg font-semibold">Sulla Via</span>
              </FloatingSurface>
              <div className={cn(floatingSurfaceClass, "px-4 py-3 text-sm")}>floatingSurfaceClass</div>
            </Entry>

            <Entry
              name="Callout"
              source="components/ui/callout.tsx"
              use="An inline message the visitor should read before carrying on, when a toast won't do (inside a full-screen dialog toasts are hidden, and a warning about the results should stay with them)."
            >
              <Callout variant="warning" className="w-full">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Couldn't search Water - other results below are unaffected.
              </Callout>
              <Callout variant="destructive" className="w-full">
                Couldn't load your Strava routes.
              </Callout>
              <Callout variant="success" className="w-full">
                Connected.
              </Callout>
            </Entry>

            <Entry
              name="Dialog"
              source="components/ui/dialog.tsx"
              use="A task that needs focus: naming a route, managing fitness apps, the routes table."
              avoid="use it for progress: prefer a toast or spinner (non-blocking)."
            >
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Name your route</DialogTitle>
                    <DialogDescription>Shown on your device and in your fitness apps.</DialogDescription>
                  </DialogHeader>
                  <Input placeholder="Route name" />
                </DialogContent>
              </Dialog>
            </Entry>

            <Entry
              name="AlertDialog"
              source="components/ui/alert-dialog.tsx"
              use='Confirming something that would lose work. The confirm is AlertDialogAction variant="destructive-solid" when it cannot be undone. It stacks above an open Dialog.'
            >
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 />
                    Remove route
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove this route?</AlertDialogTitle>
                    <AlertDialogDescription>The route and the POIs found on it will be cleared.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive-solid">Remove</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </Entry>

            <Entry
              name="Close button"
              source="components/ui/close-button.ts"
              use="The one look for every X: dialogs, toasts and (via index.css) map popups all use closeButtonClass."
              avoid="hand-style an X button."
            >
              <button className={closeButtonClass} aria-label="Close">
                <span className="block size-4 text-center leading-4">✕</span>
              </button>
            </Entry>

            <Entry
              name="Popover"
              source="components/ui/popover.tsx"
              use="Extra detail or a small form anchored to a control."
            >
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">Open popover</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <PopoverHeader>
                    <PopoverTitle>Popover title</PopoverTitle>
                    <PopoverDescription>Anchored detail.</PopoverDescription>
                  </PopoverHeader>
                </PopoverContent>
              </Popover>
            </Entry>

            <Entry
              name="DropdownMenu"
              source="components/ui/dropdown-menu.tsx"
              use="A list of actions behind one control (the fitness-apps menu)."
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label="More">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Account</DropdownMenuLabel>
                  <DropdownMenuItem>Manage routes</DropdownMenuItem>
                  <DropdownMenuItem>Account settings</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled>Disabled</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Entry>

            <Entry
              name="Command"
              source="components/ui/command.tsx"
              use="A searchable list: the place search, PoiTypeCombobox. Rows highlight with --accent, like every menu."
            >
              <Command className="w-72 ring-1 ring-foreground/10">
                <CommandInput placeholder="Search a type…" />
                <CommandList>
                  <CommandEmpty>Nothing found.</CommandEmpty>
                  <CommandGroup heading="Types">
                    <CommandItem>Water</CommandItem>
                    <CommandItem>Toilets</CommandItem>
                    <CommandItem>Bike shop</CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </Entry>

            <Entry
              name="Tooltip"
              source="components/ui/tooltip.tsx"
              use="Naming an icon-only control, or a short explanation on hover."
              avoid="put anything the visitor needs on a phone only in a tooltip."
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="map" size="icon-sm" aria-label="Center on route">
                    <Crosshair />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Center on route</TooltipContent>
              </Tooltip>
            </Entry>

            <Entry
              name="Toast"
              source="components/ui/toast.tsx, components/Toaster.tsx, lib/toast.ts"
              use="Non-blocking feedback: a search finished, a save failed, a draft to restore. Call toast() from lib/toast.ts."
              avoid="use a toast while a full-screen dialog is open (it's hidden underneath): use a Callout."
            >
              <Button variant="outline" onClick={() => toast("Route saved", "success")}>
                Success
              </Button>
              <Button variant="outline" onClick={() => toast("Couldn't reach the server", "error")}>
                Error
              </Button>
              <Button variant="outline" onClick={() => toast("Searching…", "loading")}>
                Loading
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  toast("You have an unsaved plan", "info", [
                    { label: "Restore", onClick: () => {} },
                    { label: "Discard", onClick: () => {} },
                  ])
                }
              >
                With actions
              </Button>
            </Entry>

            <Entry
              name="Map popup"
              source="index.css (.maplibregl-popup-*)"
              use="MapLibre draws its own popups; index.css gives them the popover surface and the shared close button. This is a static copy of that markup."
            >
              <div className="maplibregl-popup-content relative w-64">
                <button className="maplibregl-popup-close-button" aria-label="Close popup">
                  ×
                </button>
                <div className="flex flex-col gap-1 pr-4 text-sm">
                  <span className="font-medium">Drinking water</span>
                  <span className="text-xs text-muted-foreground">Water · 120 m off track</span>
                </div>
              </div>
            </Entry>

            <Entry
              name="Collapsible"
              source="components/ui/collapsible.tsx"
              use="Showing and hiding a section in place (routing preferences, the elevation profile, step cards)."
            >
              <Collapsible className="w-72 rounded-control border">
                <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between px-3 py-2 text-sm">
                  Routing preferences
                  <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pb-3 text-sm text-muted-foreground">Hidden content</CollapsibleContent>
              </Collapsible>
            </Entry>

            <Entry
              name="Carousel"
              source="components/ui/carousel.tsx"
              use='Paging through photos (a POI popup). Its arrows use Button variant="map", since they float over imagery.'
            >
              <Carousel className="w-64">
                <CarouselContent>
                  {["bg-primary", "bg-secondary", "bg-accent"].map((bg, i) => (
                    <CarouselItem key={bg}>
                      <div className={cn("flex aspect-4/3 items-center justify-center rounded-item", bg)}>{i + 1}</div>
                    </CarouselItem>
                  ))}
                </CarouselContent>
                <CarouselPrevious variant="map" className="left-2" />
                <CarouselNext variant="map" className="right-2" />
              </Carousel>
            </Entry>
          </Section>

          <Section id="patterns" title="App patterns">
            <Entry
              name="StepCard"
              source="components/StepCard.tsx"
              use="One numbered step of the sidebar, collapsible. `summary` shows the step's answer while it's closed."
            >
              <div className="w-96">
                <StepCard
                  title="1. Pick the activity you love"
                  open={stepOpen}
                  onOpenChange={setStepOpen}
                  summary="Road cycling"
                >
                  <p className="text-sm text-muted-foreground">Step content</p>
                </StepCard>
              </div>
            </Entry>

            <Entry
              name="PoiListItem"
              source="components/PoiListItem.tsx"
              use="A POI or waypoint row in the checklist: checkbox, name, distances. Hover highlights with --accent."
            >
              <ul className="w-96">
                <PoiListItem
                  id="sg-poi"
                  title="Fontanella"
                  checked={poiChecked}
                  onCheckedChange={() => setPoiChecked((c) => !c)}
                  distanceFromStartM={12400}
                  distanceFromRouteM={80}
                />
              </ul>
            </Entry>

            <Entry
              name="PoiTypeCombobox"
              source="components/PoiTypeCombobox.tsx"
              use="Picking a POI type from the ~55-entry registry, too many for a Select."
            >
              <PoiTypeCombobox value={poiType} onChange={setPoiType} className="w-64" />
            </Entry>

            <Entry
              name="Map controls"
              source='Button variant="map" size="icon-sm"'
              use="Every control on the map, grouped bottom-left, clear of the sidebar."
            >
              <div className="flex flex-col gap-1">
                <Button variant="map" size="icon-sm" aria-label="Zoom in">
                  <Plus />
                </Button>
                <Button variant="map" size="icon-sm" aria-label="Zoom out">
                  <Minus />
                </Button>
                <Button variant="map" size="icon-sm" aria-label="Locate me">
                  <LocateFixed />
                </Button>
              </div>
            </Entry>
          </Section>
        </main>
        <Toaster />
      </div>
    </TooltipProvider>
  )
}
