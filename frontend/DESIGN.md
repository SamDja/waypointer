# Sulla Via design system

The rules for how the frontend looks. It is built on shadcn/ui and Tailwind v4, and all of it lives in the repo:

- **Tokens** live in `src/index.css`.
- **Primitives** are in `src/components/ui/`.
- **Shared app-level pieces** are in `src/components/`.
- **The style guide** at `/styleguide.html` shows every component in use and says when to use each one.
- **`src/designSystem.test.ts`** fails the build when code drifts from these rules.

Read this before you add or change a component.

## Running the style guide

```bash
cd frontend
npm run dev    # then open https://localhost:5173/styleguide.html (?dark opens it in dark mode)
```

`styleguide.html` is a second Vite entry. Vite serves any root HTML file in dev, but `vite build` only builds `index.html`, so the guide never ships. It renders every primitive and every shared piece in its states, next to a note on what it is for and what not to do with it. It has a light/dark switch in its header.

## Tokens

### Colour roles

Components use **roles**, never palette steps: `bg-muted`, `text-warning-foreground`, `ring-ring/50`, and not `bg-olive-200`. Each role is defined in `index.css`, in `:root` and again in `.dark`, as a Tailwind palette step, with the step's name in a comment beside it.

| Role | Light | Use |
|---|---|---|
| `background` / `foreground` | olive-100 / stone-800 | Page, dialogs; body text |
| `card`, `popover` (+ `-foreground`) | olive-100 | Cards and floating pills; menus, popovers, map popups |
| `primary` / `primary-strong` | emerald-600 / emerald-700 | The main action and the selected state; its hover |
| `secondary` | olive-200 | The secondary button |
| `muted` / `muted-foreground` | olive-200 / stone-500 | Quiet fills (hover on controls, placeholders); secondary text and icons |
| `accent` | olive-300 | **The row you're on** (see below) |
| `border`, `input` / `input-hover` | olive-300 / olive-400 | Borders and dividers; field borders, and a field's border under the pointer (input, textarea, input group, unchecked checkbox) |
| `ring` | emerald-600 | The focus ring, always at `/50` |
| `destructive` / `-strong` | red-600 / red-700 | Destructive actions; the solid variant's hover |
| `destructive`, `warning`, `success` + `-foreground` / `-surface` / `-border` | red / amber / green | Status text and icons, and the fills and borders of callouts and toasts |

**`--accent` is the only "row you're on" highlight.** It covers `hover`, `focus`, Radix's `data-highlighted` and cmdk's `data-selected`, in select, command and dropdown-menu items, list rows (`PoiListItem`, planner points) and tab hover. Those states overlap: Radix focuses an item on hover, and cmdk selects one on pointer-move. When they had different colours, which one showed depended on the order Tailwind emitted the rules. Upstream shadcn's grey accent was also invisible against our popover colour.

**Dark mode** is fully themed in olive/stone in `.dark`. The header's `ThemeToggle` cycles light → dark → auto (auto follows the system, live), via `lib/theme.ts`, saved under `"waypointer.theme"`; `index.html` applies it before the first paint. The map follows the theme too - see the map bullet under data colours. The header logo is `components/Logo.tsx` (the favicon inlined, so its magnifier turns `foreground` under `.dark`); the tab icon, `public/favicon.svg`, follows the system through its own media query instead, since the browser's tab bar does - keep their paths in step. Check new tokens in the style guide's dark view.

**Data colours are a separate thing.** Map styling, route markers and the elevation profile's gradient and surface bands encode meaning, not UI chrome. They come from `tailwindcss/colors` steps (e.g. `colors.zinc[600]`), never from plain hex in `.tsx`.

- Tailwind v4's values are `oklch()` strings, which CSS and SVG accept directly.
- MapLibre paint properties reject them, so those colours go through `lib/color.ts`'s `tailwindHex`.
- Colours shared between map markers and the planner UI live in `lib/mapColors.ts`, not `mapIcons.tsx`, since a module that mixes components with computed constants breaks Vite's fast refresh.
- If a colour you need isn't in Tailwind's palette, flag it rather than inventing one.
- **The map has a light and a dark version of every colour.** Each map style module (`lib/mapStyle/houseStyle.ts`, `roadCycling.ts`, `hiking.ts`, `contours.ts`) keeps a `LIGHT` palette and a `DARK` twin with the same keys, and the lines we draw at runtime take theirs from `lib/mapColors.ts` (`ROUTE_LINE_COLORS`, `MAP_LABEL_COLORS`). On a dark ground the roles turn round: what should stand out gets *lighter* (trails, roads, the route line), what should recede sinks toward the background, and label halos go dark. `RouteMap` and `MapLegend` pick the style with `useResolvedTheme()`. The one exception to "palette steps only" is `lib/mapStyle/darkBase.ts`, which derives dark versions of the vendored liberty base's own colours (the ones no patch sets) by an OKLCH lightness flip; anything we set ourselves is still a chosen step. OpenFreeMap's sprite icons have no dark version and stay as they are.

### Radius: three tiers

A surface holds controls, and a control holds items. The tier is in the class name, so a reviewer can see the choice.

| Class | Size | For |
|---|---|---|
| `rounded-surface` | xl | Cards, dialogs, alert dialogs, popovers, select/dropdown/command menus, toasts, map popups, floating pills |
| `rounded-control` | lg | Buttons, inputs, textareas, select triggers, tab lists, callouts, and **bordered panels inset in a card** |
| `rounded-item` | md | Menu and list rows, tab triggers, tooltips, photos, `kbd`, small icon buttons inside a field |
| `rounded-indicator` | 4px | Small form indicators: the checkbox. An item radius on 16px makes a circle, which reads as a radio button |
| `rounded-full` | | Pills, avatars, map markers, carousel arrows |
| `rounded-swatch` | 2px | Only tiny data marks: legend swatches, a tooltip's arrow |

Side variants work as usual (`rounded-t-surface`), and so does `rounded-none`. Size-named radii (`rounded-md`, `rounded-xl`) and `rounded-[…]` are not allowed.

### Elevation

- `shadow-raised` is for things that sit on the page or the map: map buttons, menus, popovers, a dragged row.
- `shadow-floating` is for things that hover over the map: sidebar cards, header pills, dialogs, toasts, map popups. The cards' background is too close in tone to the basemap to stand out without it.
- Surfaces also carry `ring-1 ring-foreground/10` as their outline instead of a `border`.
- Dark mode deepens both shadows.
- `shadow-none` is allowed. `shadow-sm`/`md`/`lg` and `shadow-[…]` are not.

### Type

Geist Variable.

- `text-sm` is the default UI size.
- `text-xs` is for secondary lines and captions.
- `text-base` is for step titles, and `text-lg` for dialog titles and the logo.
- `text-2xs` (11px) and `text-3xs` (10px) are only for dense charts, legends and the numbers on map markers.

`text-[Npx]` is not allowed.

## Shared pieces

- **`FloatingSurface`** (`components/FloatingSurface.tsx`) is anything that floats over the map and isn't a `Card`. When the root has to be another primitive (cmdk's `Command`, a `Collapsible`), apply `floatingSurfaceClass` from `components/ui/surface.ts` instead.
- **`Button` variants**:
  - `default` is the one main action of a step.
  - `outline` is for other actions.
  - `secondary` is for toggles and less important actions.
  - `ghost` is for icon actions in rows.
  - `destructive` (soft) is for a removal that is easy to undo.
  - **`destructive-solid`** is only for confirming an irreversible action, via `<AlertDialogAction variant="destructive-solid">`.
  - `link` is for links inline in text.
  - **`map`** is for any control floating over the map or a photo: every map button, the legend button, and the carousel arrows.

  Add a variant rather than restyling a `Button` with `bg-*`/`shadow-*` classes.
- **`Callout`** (`components/ui/callout.tsx`, `warning` / `destructive` / `success`) is an inline message the visitor should read before carrying on. Use it where a toast won't do. For example, toasts sit *under* the full-screen routes dialog, so a failure there must be shown inline.
- **`closeButtonClass`** (`components/ui/close-button.ts`) is the one look for every X. `dialog.tsx` and `toast.tsx` use it, and `index.css` gives MapLibre's popup close button the same colour, hover, pointer and focus ring.
- **MapLibre popups** are the one surface not built from `ui/`. `index.css` restyles `.maplibregl-popup-*` to match: popover colour, `--radius-surface`, the floating elevation plus the outline, and a matching tip colour. It uses doubled selectors, because `maplibre-gl.css` is imported after `index.css`.

## Hover on rows

A checkbox's border darkens on hover (`--input-hover`). Inside a list row that highlights as a whole, mark the row `group/row`: the checkbox then darkens whenever the row is hovered, so the row and its checkbox react together. Give the row `transition-colors` too, so its highlight fades at the same pace as the checkbox's border. `PoiListItem` does both.

## Cursors

Tailwind v4 resets `<button>` to `cursor: default`, and `<label>` never had a pointer. So every clickable primitive sets `cursor-pointer` itself, plus `disabled:cursor-not-allowed` (or the `data-disabled:` / `data-[disabled=true]:` form for Radix and cmdk items). This covers composed triggers in `components/*.tsx` too, such as `StepCard`'s `CollapsibleTrigger`. The cursor lives at the call site there, not in a shared component.

## Local edits in `components/ui/`

These files are generated by the shadcn CLI (`npx shadcn@latest add <name>` from `frontend/`), then edited here. **A regeneration silently undoes these edits.** After running the CLI over an existing component, diff it and re-apply them, then run `npm test`: the guard test catches most of what a regeneration reintroduces.

- **Tokens everywhere.** Radii are the three tiers. Colours are roles (upstream's `bg-muted`/`bg-accent` rows become `bg-accent`, and `hover:bg-emerald-700` becomes `hover:bg-primary-strong`). Shadows are `shadow-raised`/`shadow-floating`.
- **One surface style.** `dialog`, `alert-dialog` and `toast` came from an older shadcn generation (`border` + `shadow-lg` + `rounded-lg`). They now use the same `rounded-surface` + ring + `shadow-floating` as the rest.
- **Close buttons** use `closeButtonClass`.
- **`button.tsx`**:
  - adds the `map` and `destructive-solid` variants;
  - drops upstream's per-size `rounded-[min(var(--radius-md),…)]`, so every size is `rounded-control`;
  - keeps `sm`'s `text-[0.8rem]`, the one listed exception in the guard test.
- **`alert-dialog.tsx`**: `AlertDialogAction` takes a `variant`.
- **`command.tsx`**: drops upstream's `rounded-xl!` / `rounded-lg!` overrides.
- **z-index tiers.** Portalled content has to out-rank the map's markers and popups, and each dialog tier has to out-rank the one below it:

  | Component | z-index |
  |---|---|
  | dialog | `z-[1100]` / `z-[1101]` |
  | dropdown-menu, toast | `z-[1100]` |
  | alert-dialog | `z-[1200]` / `z-[1201]` |
  | select, popover | `z-[1210]` |

  The reason for each is commented in each file.
- **`select.tsx` in popper mode** drops upstream's `h-(--radix-select-trigger-height)` from the viewport. That class clips a popper-positioned menu to the height of one trigger. The popper-mode padding also sits on the viewport, not the content: padding on a trigger-width content pushes the trigger-width viewport past its right edge.

## Adding or changing a component

1. Generate it with the shadcn CLI if it is a primitive, then apply the rules above: tier radius, roles, elevation tokens and cursors.
2. Add it to `src/styleguide/StyleGuide.tsx` as an `Entry`: what it's for, when not to use it, and live examples in each state. The guard test fails for any `ui/` file (or listed shared piece) that the guide doesn't import or name in an entry's `source`.
3. Run `npm test`.

## What the guard test checks

`src/designSystem.test.ts` reads the source as text, with comments stripped, and reports each failure as `file:line`. It checks that:

- every radius is one of the tiers (or `-indicator`, `-full`, `-none`, `-swatch`);
- every shadow is `shadow-raised`, `shadow-floating` or `shadow-none`;
- no `text-[N…]` arbitrary font sizes are used;
- no palette colour utilities (`bg-olive-300`, `text-green-700`, …) are used;
- in `ui/`, every class group with a `hover:` style also has a pointer (or grab/text) cursor;
- in `ui/`, every styled `*Primitive.Close` uses `closeButtonClass`;
- every `ui/` file and shared piece appears in the style guide.

An intended exception goes in the test's `EXCEPTIONS` list, with a reason.
