import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ArrowRight, Flag, GripVertical, Play, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PLANNER_POINT_COLOR, ROUTE_END_COLOR, ROUTE_START_COLOR, START_FINISH_BACKGROUND } from "@/lib/mapColors"
import { cn } from "@/lib/utils"

export interface PlannerPoint {
  // Stable across re-renders of the same route, so dnd-kit can track a row
  // mid-drag. Positional, like the map's anchor markers: after a reorder the
  // list is rebuilt from the new order anyway.
  id: string
  label: string
  // "start-finish" is a loop's or out-and-back's start, which is its finish too.
  kind: "start" | "start-finish" | "point" | "end"
  // The number shown on the map's marker for interior points.
  number: number
  // Distance along the route from the previous point; null for the start.
  legDistanceM: number | null
  // The leg to this point is still being routed, so its distance is the
  // straight-line placeholder.
  legPending: boolean
}

// The way back to the start a loop or out-and-back adds after the last point.
// Derived from the points, so it's shown after the list but isn't a row you
// can drag or delete.
export interface PlannerReturnLeg {
  label: string
  distanceM: number
  pending: boolean
}

export interface PlannerPointListProps {
  points: PlannerPoint[]
  returnLeg: PlannerReturnLeg | null
  onReorder: (from: number, to: number) => void
  onDelete: (index: number) => void
  // Index of the point hovered here or on the map - shared so each view
  // highlights what the other is pointing at.
  hoveredIndex: number | null
  onHover: (index: number | null) => void
}

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

// The route's points in ride order, reorderable by dragging a row's handle
// (or with the keyboard: focus the handle, Space to pick up, arrows, Space).
export function PlannerPointList({
  points,
  returnLeg,
  onReorder,
  onDelete,
  hoveredIndex,
  onHover,
}: PlannerPointListProps) {
  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a plain click on the
    // handle doesn't count as one.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const from = points.findIndex((p) => p.id === active.id)
    const to = points.findIndex((p) => p.id === over.id)
    if (from !== -1 && to !== -1) onReorder(from, to)
  }

  if (points.length === 0) return null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={points.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        <ol className="flex flex-col rounded-md border py-1" onMouseLeave={() => onHover(null)}>
          {points.map((point, index) => (
            <PointRow
              key={point.id}
              point={point}
              canReorder={points.length > 1}
              highlighted={hoveredIndex === index}
              onDelete={() => onDelete(index)}
              onHover={() => onHover(index)}
            />
          ))}
          {returnLeg && (
            <li className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
              <span className="flex size-7 shrink-0 items-center justify-center">
                <ArrowRight className="size-4" />
              </span>
              <PointBadge point={{ kind: "start-finish", number: 0 }} />
              <span className="flex-1 truncate">{returnLeg.label}</span>
              <LegDistance distanceM={returnLeg.distanceM} pending={returnLeg.pending} />
              {/* Keeps the distance column aligned with the rows' delete buttons. */}
              <span className="size-8 shrink-0" />
            </li>
          )}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function PointRow({
  point,
  canReorder,
  highlighted,
  onDelete,
  onHover,
}: {
  point: PlannerPoint
  canReorder: boolean
  highlighted: boolean
  onDelete: () => void
  onHover: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: point.id,
    disabled: !canReorder,
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onMouseEnter={onHover}
      className={cn(
        "relative flex items-center gap-2 px-1 py-1 text-sm",
        highlighted && "bg-accent",
        isDragging && "z-10 rounded-md bg-card shadow-md ring-1 ring-foreground/10"
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${point.label}`}
        disabled={!canReorder}
        // touch-none: without it a touch drag on the handle scrolls the
        // sidebar instead of moving the row.
        className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical className="size-4" />
      </button>
      <PointBadge point={point} />
      <span className="flex-1 truncate">{point.label}</span>
      {point.legDistanceM !== null && <LegDistance distanceM={point.legDistanceM} pending={point.legPending} />}
      <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${point.label}`}>
        <X className="size-4" />
      </Button>
    </li>
  )
}

function LegDistance({ distanceM, pending }: { distanceM: number; pending: boolean }) {
  return (
    <span
      className="shrink-0 text-xs text-muted-foreground tabular-nums"
      title={pending ? "Straight-line distance while this leg is being routed" : undefined}
    >
      +{pending ? "~" : ""}
      {formatDistance(distanceM)}
    </span>
  )
}

// The same marker the map shows for this point, shrunk to list size.
function PointBadge({ point }: { point: Pick<PlannerPoint, "kind" | "number"> }) {
  const background =
    point.kind === "start"
      ? ROUTE_START_COLOR
      : point.kind === "end"
        ? ROUTE_END_COLOR
        : point.kind === "start-finish"
          ? START_FINISH_BACKGROUND
          : PLANNER_POINT_COLOR
  const Icon = point.kind === "start" ? Play : point.kind === "end" ? Square : point.kind === "start-finish" ? Flag : null
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none text-white"
      style={{ background }}
    >
      {Icon ? <Icon className="size-3" strokeWidth={2.5} /> : point.number}
    </span>
  )
}
