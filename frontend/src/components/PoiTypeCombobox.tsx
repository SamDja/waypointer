import { useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { POI_TYPES } from "@/lib/poiTypes"

export interface PoiTypeComboboxProps {
  value: string
  onChange: (poiType: string) => void
  className?: string
}

// A searchable POI-type picker - the registry has ~55 entries, too many
// for a plain <Select> to browse comfortably (radix-ui has no built-in
// autocomplete/combobox primitive, so this follows the standard shadcn
// combobox recipe: a Popover housing a Command list, which gets free
// type-to-filter and keyboard navigation from cmdk).
export function PoiTypeCombobox({ value, onChange, className }: PoiTypeComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = POI_TYPES.find((cfg) => cfg.key === value)
  const SelectedIcon = selected?.icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-48 justify-between font-normal", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            {SelectedIcon && <SelectedIcon className="size-4 shrink-0" style={{ color: selected?.color }} />}
            <span className="truncate">{selected?.label ?? "Select type…"}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search type…" />
          <CommandList>
            <CommandEmpty>No type found.</CommandEmpty>
            <CommandGroup>
              {POI_TYPES.map((cfg) => {
                const Icon = cfg.icon
                return (
                  <CommandItem
                    key={cfg.key}
                    value={cfg.label}
                    data-checked={cfg.key === value}
                    onSelect={() => {
                      onChange(cfg.key)
                      setOpen(false)
                    }}
                  >
                    <Icon className="size-4 shrink-0" style={{ color: cfg.color }} />
                    {cfg.label}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
