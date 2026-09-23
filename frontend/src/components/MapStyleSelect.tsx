import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MAP_STYLES } from "@/lib/mapStyles"

export interface MapStyleSelectProps {
  value: string
  onChange: (key: string) => void
}

// The activity picker: choosing a style picks both the map's cartography and
// the route planner's routing profile (see lib/mapStyles.ts). It's the whole
// content of the sidebar's first step, not a control on the map, because it
// shapes the entire session rather than just the map's look.
export function MapStyleSelect({ value, onChange }: MapStyleSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      {/*
        A plain field, like the device select in SaveCard: it used to be
        styled as a floating card of its own, from when it sat above the
        step cards rather than inside one.
      */}
      <SelectTrigger aria-label="Activity" className="w-full">
        <SelectValue />
      </SelectTrigger>
      {/*
        Positioned like the sidebar's other two pickers - the POI type
        combobox and the place search - rather than with Radix's default
        item-aligned placement, which overlays the menu on the trigger and
        reads as a different kind of control. `popper` drops it below
        instead; sideOffset plus the component's own translate leaves the
        same 8px gap the search results use, the trigger's width keeps the
        edges flush, and shadow-lg is what lifts it clear of the cards it
        opens over (they carry shadow-lg themselves).
      */}
      <SelectContent
        position="popper"
        align="start"
        sideOffset={4}
        className="w-(--radix-select-trigger-width) rounded-xl p-1 shadow-lg"
      >
        {MAP_STYLES.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            <s.icon className="size-4" />
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
