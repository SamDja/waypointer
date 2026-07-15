// Hand-mirrors src/waypointer/poi_types.py (repo convention: no shared
// codegen between backend and frontend, keep in sync manually). Only
// "water" is registered today; adding a POI type here plus in the backend
// registry is meant to be the whole change needed to support it.

import { Droplet, type LucideIcon } from "lucide-react"

export interface PoiTypeConfig {
  key: string
  label: string
  icon: LucideIcon
  color: string
  defaultMaxDistanceM: number
  minDistanceM: number
  maxDistanceM: number
}

export const POI_TYPES: PoiTypeConfig[] = [
  {
    key: "water",
    label: "Water Fountains",
    icon: Droplet,
    color: "#00a5ef",
    defaultMaxDistanceM: 10,
    minDistanceM: 1,
    maxDistanceM: 500,
  },
]
