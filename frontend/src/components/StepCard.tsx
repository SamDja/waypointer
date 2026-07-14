import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Card, CardContent, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export interface StepCardProps {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  contentClassName?: string
}

export function StepCard({ title, open, onOpenChange, children, contentClassName }: StepCardProps) {
  return (
    <Card className="py-0">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-(--card-spacing) py-(--card-spacing) text-left">
          <CardTitle>{title}</CardTitle>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <CardContent className={cn("pb-(--card-spacing)", contentClassName)}>{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
