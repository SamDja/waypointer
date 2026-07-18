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
  Map,
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
}

export const POI_TYPES: PoiTypeConfig[] = [
  {
    key: "water",
    label: "Water Fountains",
    icon: Droplet,
    color: colors.sky[400],
    symHints: ["water", "fountain"],
    searchable: true,
    defaultMaxDistanceM: 10,
    minDistanceM: 1,
    maxDistanceM: 500,
    defaultGpxSymbol: "Water",
  },
  { key: "warning", label: "Warning", icon: TriangleAlert, color: colors.rose[700], symHints: ["warning", "hazard", "danger"], searchable: false },
  { key: "first_aid", label: "First Aid", icon: Cross, color: colors.rose[700], symHints: ["first aid", "first-aid", "medical"], searchable: false },
  { key: "hospital", label: "Hospital", icon: Hospital, color: colors.rose[700], symHints: ["hospital"], searchable: false },
  { key: "pharmacy", label: "Pharmacy", icon: Pill, color: colors.rose[700], symHints: ["pharmacy", "drug store", "drugstore"], searchable: false },
  { key: "bar", label: "Bar", icon: Beer, color: colors.amber[700], symHints: ["bar", "pub"], searchable: false },
  { key: "bike_shop", label: "Bike Shop", icon: Wrench, color: colors.amber[700], symHints: ["bike shop", "bicycle shop"], searchable: false },
  { key: "coffee", label: "Coffee", icon: Coffee, color: colors.amber[700], symHints: ["coffee", "cafe"], searchable: false },
  { key: "food", label: "Food", icon: Utensils, color: colors.amber[700], symHints: ["food", "restaurant", "dining"], searchable: false },
  { key: "gas_station", label: "Gas Station", icon: Fuel, color: colors.amber[700], symHints: ["gas station", "fuel", "petrol"], searchable: false },
  { key: "groceries", label: "Groceries", icon: ShoppingBasket, color: colors.amber[700], symHints: ["grocery", "groceries", "supermarket"], searchable: false },
  { key: "shopping", label: "Shopping", icon: ShoppingBag, color: colors.amber[700], symHints: ["shopping", "shop", "store"], searchable: false },
  { key: "winery", label: "Winery", icon: Wine, color: colors.amber[700], symHints: ["winery", "vineyard"], searchable: false },
  { key: "info", label: "Info Point", icon: Info, color: colors.violet[700], symHints: ["info", "information"], searchable: false },
  { key: "internet", label: "Internet", icon: Wifi, color: colors.violet[700], symHints: ["internet", "wifi"], searchable: false },
  { key: "library", label: "Library", icon: BookOpen, color: colors.violet[700], symHints: ["library"], searchable: false },
  { key: "lodging", label: "Lodging", icon: BedDouble, color: colors.violet[700], symHints: ["lodging", "hotel", "hostel", "motel"], searchable: false },
  { key: "shower", label: "Shower", icon: ShowerHead, color: colors.violet[700], symHints: ["shower"], searchable: false },
  { key: "toilet", label: "Toilet", icon: Toilet, color: colors.violet[700], symHints: ["toilet", "restroom", "wc"], searchable: false },
  { key: "bike_parking", label: "Bike Parking", icon: Bike, color: colors.cyan[700], symHints: ["bike parking", "bicycle parking"], searchable: false },
  { key: "bike_share", label: "Bike Share", icon: HeartHandshake, color: colors.cyan[700], symHints: ["bike share", "bike sharing"], searchable: false },
  { key: "chairlift", label: "Chairlift", icon: CableCar, color: colors.cyan[700], symHints: ["chairlift", "chair lift"], searchable: false },
  { key: "e_bike_charging", label: "E-Bike Charging", icon: BatteryCharging, color: colors.cyan[700], symHints: ["e-bike", "ebike charging", "charging"], searchable: false },
  { key: "ferry", label: "Ferry", icon: Ship, color: colors.cyan[700], symHints: ["ferry"], searchable: false },
  { key: "parking", label: "Parking", icon: ParkingCircle, color: colors.cyan[700], symHints: ["parking"], searchable: false },
  { key: "transit", label: "Transit", icon: Train, color: colors.cyan[700], symHints: ["transit", "bus stop", "train station", "station"], searchable: false },
  { key: "campsite", label: "Campsite", icon: Tent, color: colors.green[700], symHints: ["campsite", "camping", "camp ground", "campground"], searchable: false },
  { key: "dog_park", label: "Dog Park", icon: PawPrint, color: colors.green[700], symHints: ["dog park"], searchable: false },
  { key: "geocache", label: "Geocache", icon: Gem, color: colors.green[700], symHints: ["geocache"], searchable: false },
  { key: "park", label: "Park", icon: TreePine, color: colors.green[700], symHints: ["park"], searchable: false },
  { key: "rest_area", label: "Rest Area", icon: RockingChair, color: colors.green[700], symHints: ["rest area", "picnic"], searchable: false },
  { key: "swimming", label: "Swimming", icon: WavesLadder, color: colors.green[700], symHints: ["swimming", "swim", "pool"], searchable: false },
  { key: "trailhead", label: "Trailhead", icon: Map, color: colors.green[700], symHints: ["trailhead", "trail head"], searchable: false },
  { key: "summit", label: "Summit", icon: MountainSnow, color: colors.green[700], symHints: ["summit", "peak"], searchable: false },
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
  { key: "atm", label: "ATM", icon: Banknote, color: colors.violet[700], symHints: ["atm", "cash machine", "bank"], searchable: false },
  { key: "art", label: "Art", icon: Palette, color: colors.teal[600], symHints: ["art", "sculpture"], searchable: false },
  { key: "attraction", label: "Attraction", icon: FerrisWheel, color: colors.teal[600], symHints: ["attraction"], searchable: false },
  { key: "for_kids", label: "Kid Friendly", icon: Baby, color: colors.teal[600], symHints: ["for kids", "kid friendly"], searchable: false },
  { key: "monument", label: "Monument", icon: Landmark, color: colors.teal[600], symHints: ["monument", "memorial"], searchable: false },
  { key: "viewpoint", label: "Viewpoint", icon: Eye, color: colors.teal[600], symHints: ["viewpoint", "scenic view", "overlook"], searchable: false },
  { key: "generic", label: "Other", icon: MapPin, color: colors.pink[500], symHints: [], searchable: false },
]

