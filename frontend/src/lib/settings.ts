const SETTINGS_KEY = "waypointer.settings"

export interface DeviceSettings {
  device: string
  waterSymbol: string
}

export const DEFAULT_SETTINGS: DeviceSettings = { device: "generic", waterSymbol: "Water" }

export function loadSettings(): DeviceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return {
      device: parsed.device || DEFAULT_SETTINGS.device,
      waterSymbol: parsed.waterSymbol || DEFAULT_SETTINGS.waterSymbol,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: DeviceSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}
