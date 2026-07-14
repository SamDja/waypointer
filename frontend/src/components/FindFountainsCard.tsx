import { Button } from "@/components/ui/button"

export interface FindFountainsCardProps {
  onFind: () => void
  disabled: boolean
  isFinding: boolean
  routeSummary: string | null
}

export function FindFountainsCard({ onFind, disabled, isFinding, routeSummary }: FindFountainsCardProps) {
  return (
    <div className="flex flex-col gap-3">
      <Button onClick={onFind} disabled={disabled} loading={isFinding} className="w-fit">
        {isFinding ? "Finding Water Fountains…" : "Find Water Fountains"}
      </Button>
      {routeSummary && <p className="text-sm text-muted-foreground">{routeSummary}</p>}
    </div>
  )
}
