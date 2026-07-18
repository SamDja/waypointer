import type { ReactNode } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { formatDistanceM } from "@/lib/geometry"

export interface PoiListItemProps {
  id: string
  title: ReactNode
  checked: boolean
  onCheckedChange: () => void
  distanceFromStartM: number
  distanceFromRouteM: number
  trailing?: ReactNode
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function PoiListItem({
  id,
  title,
  checked,
  onCheckedChange,
  distanceFromStartM,
  distanceFromRouteM,
  trailing,
  onMouseEnter,
  onMouseLeave,
}: PoiListItemProps) {
  return (
  <li
    className="flex items-center gap-2 rounded-xl hover:bg-olive-200 p-2"
    onMouseEnter={onMouseEnter}
    onMouseLeave={onMouseLeave}
  >
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={id} className="flex w-full min-w-0 flex-col items-start gap-0">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="flex w-full gap-2 text-xs">
          <span>
            {formatDistanceM(distanceFromStartM)} <span className="text-muted-foreground">from start</span>
          </span>
          <span>
            {formatDistanceM(distanceFromRouteM)} <span className="text-muted-foreground">off track</span>
          </span>
        </span>
      </Label>
      {trailing}
    </li>
  )
}
