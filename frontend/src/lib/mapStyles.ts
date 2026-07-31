export interface MapStyleConfig {
  key: string
  label: string
  styleUrl: string
}

// OpenFreeMap (openfreemap.org) only ships 4 generic base styles today -
// no activity-specific cartography exists yet. These are provisional
// placeholders; swap styleUrl for a self-hosted, custom-authored style per
// activity later without touching any callers of this file.
export const MAP_STYLES: MapStyleConfig[] = [
  { key: "road_cycling", label: "Road Cycling", styleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  { key: "gravel", label: "Gravel", styleUrl: "https://tiles.openfreemap.org/styles/bright" },
  { key: "mtb", label: "Mountain Biking", styleUrl: "https://tiles.openfreemap.org/styles/bright" },
  { key: "cycloturism", label: "Cycloturism", styleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  { key: "hiking", label: "Hiking", styleUrl: "https://tiles.openfreemap.org/styles/positron" },
  { key: "multiday", label: "Multi-day (Pedestrian)", styleUrl: "https://tiles.openfreemap.org/styles/positron" },
]

export const DEFAULT_MAP_STYLE_KEY = "road_cycling"
