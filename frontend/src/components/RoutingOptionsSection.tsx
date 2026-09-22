import { useId } from "react"
import { ChevronDown, SlidersHorizontal } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { RoutingOptionSpec, RoutingOptions } from "@/lib/mapStyles"

export interface RoutingOptionsSectionProps {
  specs: RoutingOptionSpec[]
  values: RoutingOptions
  onChange: (options: RoutingOptions) => void
}

// The planner's BRouter options, collapsed by default: most visitors never
// need them, and the header says how many differ from the defaults.
export function RoutingOptionsSection({ specs, values, onChange }: RoutingOptionsSectionProps) {
  if (specs.length === 0) return null
  const changed = specs.filter((spec) => values[spec.key] !== spec.default).length
  const set = (key: string, value: boolean | number) => onChange({ ...values, [key]: value })

  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm">
        <SlidersHorizontal className="size-4 text-muted-foreground" />
        <span className="flex-1 font-medium">Routing preferences</span>
        {changed > 0 && <span className="text-xs text-muted-foreground">{changed} changed</span>}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          {specs
            .filter((spec) => spec.kind === "choice")
            .map((spec) => (
              <ChoiceOption
                key={spec.key}
                spec={spec}
                value={values[spec.key] as number}
                onChange={(value) => set(spec.key, value)}
              />
            ))}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {specs
              .filter((spec) => spec.kind === "toggle")
              .map((spec) => (
                <ToggleOption
                  key={spec.key}
                  label={spec.label}
                  checked={values[spec.key] === true}
                  onChange={(checked) => set(spec.key, checked)}
                />
              ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ChoiceOption({
  spec,
  value,
  onChange,
}: {
  spec: Extract<RoutingOptionSpec, { kind: "choice" }>
  value: number
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {spec.label}
      </Label>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {spec.choices.map((choice) => (
            <SelectItem key={choice.value} value={String(choice.value)}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ToggleOption({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}
