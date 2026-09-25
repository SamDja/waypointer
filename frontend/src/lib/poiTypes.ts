// Hand-mirrors src/waypointer/poi_types.py (repo convention: no shared
// codegen between backend and frontend, keep in sync manually) - same
// ~55-key set as dev_tools/wahoo_poi_mapping.json. Only "water" is
// searchable (see `searchable` below); the rest exist for classifying
// pre-existing waypoints (ImportCard's "Waypoints" tab) and for map/checklist
// icons. Colors are a small thematic palette reused across related
// categories rather than one bespoke hue per key.

import {
  ArrowLeftRight,
  Baby,
  Banknote,
  BatteryCharging,
  BedDouble,
  Beer,
  Bike,
  BookOpen,
  CableCar,
  Coffee,
  Cross,
  Droplet,
  Eye,
  FerrisWheel,
  Fuel,
  Gem,
  HeartHandshake,
  Hospital,
  Info,
  Landmark,
  type LucideIcon,
  // Aliased: an unaliased `Map` shadows the global inside this module.
  Map as MapIcon,
  MapPin,
  MapPinCheckInside,
  Mountain,
  MountainSnow,
  Palette,
  ParkingCircle,
  PawPrint,
  Pill,
  Pin,
  Play,
  RockingChair,
  Ship,
  ShoppingBag,
  ShoppingBasket,
  ShowerHead,
  Square,
  Tent,
  Toilet,
  Train,
  TreePine,
  TrendingUp,
  TriangleAlert,
  Users,
  Utensils,
  WavesLadder,
  Wifi,
  Wine,
  Wrench,
  Zap,
} from "lucide-react"
import colors from "tailwindcss/colors"

export interface PoiTypeConfig {
  key: string
  label: string
  icon: LucideIcon
  color: string
  // Lowercase substrings matched against a pre-existing waypoint's <sym>/
  // <type> text to best-effort infer its POI type - mirrors the backend's
  // poi_types.py sym_hints, see lib/gpx.ts's parseExistingWaypointsFromGpx.
  symHints: string[]
  // Only "water" is searchable today - Find POIs / Overpass search is
  // limited to types that set this, mirroring the backend's tag_filter.
  searchable: boolean
  defaultMaxDistanceM?: number
  minDistanceM?: number
  maxDistanceM?: number
  // Suggested default for the GPX <sym> tag when exporting this POI type
  // to a generic (non-Wahoo) device - mirrors the backend's
  // poi_types.py PoiTypeConfig.default_gpx_symbol. Undefined means "fall
  // back to label" (see SaveCard.tsx).
  defaultGpxSymbol?: string
  // Tie-break when one OSM element matches several searched types at once -
  // mirrors poi_types.py's PoiTypeConfig.specificity, where the reasoning
  // lives. The higher value wins and the element is listed once, under that
  // type; undefined means 0. Only ever compared between types the visitor
  // actually searched for, so searching the broader type alone still finds
  // it. See App.tsx's allCandidates.
  specificity?: number
}

export const POI_TYPES: PoiTypeConfig[] = [
  {
    key: "water",
    label: "Water Fountains",
    icon: Droplet,
    color: colors.sky[400],
    symHints: ["water", "fountain"],
    searchable: true,
    defaultMaxDistanceM: 50,
    minDistanceM: 1,
    maxDistanceM: 200,
    defaultGpxSymbol: "Water",
  },
  { key: "warning", label: "Warning", icon: TriangleAlert, color: colors.rose[700], symHints: ["warning", "hazard", "danger"], searchable: false },
  { key: "first_aid", label: "First Aid", icon: Cross, color: colors.rose[700], symHints: ["first aid", "first-aid", "medical"], searchable: false },
  { key: "hospital", label: "Hospital", icon: Hospital, color: colors.rose[700], symHints: ["hospital"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "pharmacy", label: "Pharmacy", icon: Pill, color: colors.rose[700], symHints: ["pharmacy", "drug store", "drugstore"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "bar", label: "Bar", icon: Beer, color: colors.amber[700], symHints: ["bar", "pub"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "bike_shop", label: "Bike Shop", icon: Wrench, color: colors.amber[700], symHints: ["bike shop", "bicycle shop"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "coffee", label: "Coffee", icon: Coffee, color: colors.amber[700], symHints: ["coffee", "cafe"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "food", label: "Food", icon: Utensils, color: colors.amber[700], symHints: ["food", "restaurant", "dining"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "gas_station", label: "Gas Station", icon: Fuel, color: colors.amber[700], symHints: ["gas station", "fuel", "petrol"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "groceries", label: "Groceries", icon: ShoppingBasket, color: colors.amber[700], symHints: ["grocery", "groceries", "supermarket"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "shopping", label: "Shopping", icon: ShoppingBag, color: colors.amber[700], symHints: ["shopping", "shop", "store"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200, specificity: -1 },
  { key: "winery", label: "Winery", icon: Wine, color: colors.amber[700], symHints: ["winery", "vineyard"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "info", label: "Info Point", icon: Info, color: colors.violet[700], symHints: ["info", "information"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "internet", label: "Internet", icon: Wifi, color: colors.violet[700], symHints: ["internet", "wifi"], searchable: false },
  { key: "library", label: "Library", icon: BookOpen, color: colors.violet[700], symHints: ["library"], searchable: false },
  { key: "lodging", label: "Lodging", icon: BedDouble, color: colors.violet[700], symHints: ["lodging", "hotel", "hostel", "motel", "alpine hut"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "shower", label: "Shower", icon: ShowerHead, color: colors.violet[700], symHints: ["shower"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "toilet", label: "Toilet", icon: Toilet, color: colors.violet[700], symHints: ["toilet", "restroom", "wc"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "bike_parking", label: "Bike Parking", icon: Bike, color: colors.cyan[700], symHints: ["bike parking", "bicycle parking"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "bike_share", label: "Bike Share", icon: HeartHandshake, color: colors.cyan[700], symHints: ["bike share", "bike sharing"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "chairlift", label: "Chairlift", icon: CableCar, color: colors.cyan[700], symHints: ["chairlift", "chair lift"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "e_bike_charging", label: "E-Bike Charging", icon: BatteryCharging, color: colors.cyan[700], symHints: ["e-bike", "ebike charging", "charging"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "ferry", label: "Ferry", icon: Ship, color: colors.cyan[700], symHints: ["ferry"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "parking", label: "Parking", icon: ParkingCircle, color: colors.cyan[700], symHints: ["parking"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "transit", label: "Transit", icon: Train, color: colors.cyan[700], symHints: ["transit", "bus stop", "train station", "station"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "campsite", label: "Campsite", icon: Tent, color: colors.green[700], symHints: ["campsite", "camping", "camp ground", "campground"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "dog_park", label: "Dog Park", icon: PawPrint, color: colors.green[700], symHints: ["dog park"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "geocache", label: "Geocache", icon: Gem, color: colors.green[700], symHints: ["geocache"], searchable: false },
  { key: "park", label: "Park", icon: TreePine, color: colors.green[700], symHints: ["park"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "rest_area", label: "Rest Area", icon: RockingChair, color: colors.green[700], symHints: ["rest area", "picnic"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "swimming", label: "Swimming", icon: WavesLadder, color: colors.green[700], symHints: ["swimming", "swim", "pool"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "trailhead", label: "Trailhead", icon: MapIcon, color: colors.green[700], symHints: ["trailhead", "trail head"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200, specificity: 1 },
  { key: "summit", label: "Summit", icon: MountainSnow, color: colors.green[700], symHints: ["summit", "peak"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "valley", label: "Valley", icon: Mountain, color: colors.green[700], symHints: ["valley"], searchable: false },
  { key: "checkpoint", label: "Checkpoint", icon: MapPinCheckInside, color: colors.pink[500], symHints: ["checkpoint"], searchable: false },
  { key: "climb_4th_cat", label: "Climb (Cat. 4)", icon: TrendingUp, color: colors.pink[500], symHints: [], searchable: false },
  { key: "climb_3rd_cat", label: "Climb (Cat. 3)", icon: TrendingUp, color: colors.pink[500], symHints: [], searchable: false },
  { key: "climb_2nd_cat", label: "Climb (Cat. 2)", icon: TrendingUp, color: colors.pink[500], symHints: [], searchable: false },
  { key: "climb_1st_cat", label: "Climb (Cat. 1)", icon: TrendingUp, color: colors.pink[500], symHints: [], searchable: false },
  { key: "climb_hors_cat", label: "Climb (HC)", icon: TrendingUp, color: colors.pink[500], symHints: ["hors categorie", "hc climb"], searchable: false },
  { key: "distance_marker", label: "Distance Marker", icon: Pin, color: colors.pink[500], symHints: ["distance marker", "mile marker", "km marker"], searchable: false },
  { key: "meeting_spot", label: "Meeting Spot", icon: Users, color: colors.pink[500], symHints: ["meeting spot", "meeting point"], searchable: false },
  { key: "segment_start", label: "Segment Start", icon: Play, color: colors.pink[500], symHints: ["segment start"], searchable: false },
  { key: "segment_end", label: "Segment End", icon: Square, color: colors.pink[500], symHints: ["segment end"], searchable: false },
  { key: "sprint", label: "Sprint", icon: Zap, color: colors.pink[500], symHints: ["sprint"], searchable: false },
  { key: "transition", label: "Transition", icon: ArrowLeftRight, color: colors.pink[500], symHints: ["transition"], searchable: false },
  { key: "atm", label: "ATM", icon: Banknote, color: colors.violet[700], symHints: ["atm", "cash machine", "bank"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "art", label: "Art", icon: Palette, color: colors.teal[600], symHints: ["art", "sculpture"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "attraction", label: "Attraction", icon: FerrisWheel, color: colors.teal[600], symHints: ["attraction"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "for_kids", label: "Kid Friendly", icon: Baby, color: colors.teal[600], symHints: ["for kids", "kid friendly"], searchable: false },
  { key: "monument", label: "Monument", icon: Landmark, color: colors.teal[600], symHints: ["monument", "memorial"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "viewpoint", label: "Viewpoint", icon: Eye, color: colors.teal[600], symHints: ["viewpoint", "scenic view", "overlook"], searchable: true, defaultMaxDistanceM: 100, minDistanceM: 1, maxDistanceM: 200 },
  { key: "generic", label: "Other", icon: MapPin, color: colors.pink[500], symHints: [], searchable: false },
]

// What a fresh browser starts with is no longer one list: it's per
// activity, declared as `visiblePoiTypes` on each entry in mapStyles.ts,
// since a walk and a ride don't look for the same things. The backend's own
// poi_types.py DEFAULT_VISIBLE_POI_TYPES still exists as the fallback for a
// request that omits poi_config entirely - which this frontend never does.


const SPECIFICITY_BY_KEY: Record<string, number> = Object.fromEntries(
  POI_TYPES.map((type) => [type.key, type.specificity ?? 0])
)

export function poiSpecificity(poiType: string): number {
  return SPECIFICITY_BY_KEY[poiType] ?? 0
}

/**
 * One entry per OSM element, keeping its most specific type.
 *
 * An element can honestly match several types at once - a trailhead that is
 * also an info board, or any shop, which the catch-all `shopping` matches
 * alongside its own shop type - and the search runs one request per type, so
 * both come back and the same thing would otherwise be listed twice.
 *
 * Only the types actually searched are in `candidates`, which is what makes
 * this respect "the broader type alone still finds it": searching Info on its
 * own leaves nothing more specific here to beat it. Ties keep the earlier
 * entry. Returns the input unchanged when there was nothing to resolve, so an
 * uncontested list keeps its identity.
 */
export function mostSpecificPerElement<T extends { osm_id: number; poi_type: string }>(
  candidates: T[]
): T[] {
  const best = new Map<number, T>()
  for (const candidate of candidates) {
    const previous = best.get(candidate.osm_id)
    if (previous === undefined || poiSpecificity(candidate.poi_type) > poiSpecificity(previous.poi_type)) {
      best.set(candidate.osm_id, candidate)
    }
  }
  return best.size === candidates.length ? candidates : [...best.values()]
}
