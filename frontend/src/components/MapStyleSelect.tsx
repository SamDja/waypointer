import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MAP_STYLES } from "@/lib/mapStyles"

export interface MapStyleSelectProps {
  value: string
  onChange: (key: string) => void
}

// The activity picker: choosing a style picks both the map's cartography and
// the route planner's routing profile (see lib/mapStyles.ts). It sits above
// the sidebar's first card, not on the map, because it shapes the whole
// session rather than just the map's look.
export function MapStyleSelect({ value, onChange }: MapStyleSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Activity"
        // Styled like the sidebar cards it sits above rather than like a
        // form field.
        className="w-full rounded-xl border-0 bg-card px-4 shadow-lg ring-1 ring-foreground/10 data-[size=default]:h-11"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
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
