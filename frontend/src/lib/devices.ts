/**
 * The devices a route can be saved for - a hand mirror of the backend's
 * `device_profiles.py` (same convention as poiTypes.ts mirrors
 * poi_types.py). A device is only ever a choice of output format: the GPX
 * <sym> value is resolved per POI type, and a Wahoo's icons come from a FIT
 * developer field, not from the device entry.
 *
 * Kept as a registry rather than literal <SelectItem>s so an activity's
 * default device (mapStyles.ts's ActivityDefaults.device) can be checked
 * against something. There's no default key here on purpose: which device
 * an activity starts on is the activity's answer, not this module's.
 */
export interface DeviceConfig {
  key: string
  label: string
}

export const DEVICES: DeviceConfig[] = [
  { key: "generic", label: "Generic (GPX)" },
  { key: "wahoo_elemnt_roam_v3", label: "Wahoo ELEMNT ROAM v3 (.fit)" },
]

export function isKnownDevice(key: unknown): key is string {
  return typeof key === "string" && DEVICES.some((d) => d.key === key)
}
