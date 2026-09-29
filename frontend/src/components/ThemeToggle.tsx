import { Moon, Sun, SunMoon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { nextTheme, useTheme, type ThemePreference } from "@/lib/theme"

const THEME_ICON = { light: Sun, dark: Moon, auto: SunMoon } as const

const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Light theme",
  dark: "Dark theme",
  auto: "Theme follows your system",
}

// The header's theme button: each click steps light -> dark -> auto.
export function ThemeToggle() {
  const [theme, cycleTheme] = useTheme()
  const Icon = THEME_ICON[theme]
  const label = `${THEME_LABEL[theme]} - click for ${nextTheme(theme)}`

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={cycleTheme}>
            <Icon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
