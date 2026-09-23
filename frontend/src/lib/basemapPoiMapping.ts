// Maps the basemap's own vector-tile POI icons (road-cycling.json's
// poi_r20/poi_r7/poi_r1 layers, source-layer "poi", OpenMapTiles schema -
// properties are only `class`/`subclass`/`name`, no OSM id or tags) to our
// own searchable poi_type registry (see poiTypes.ts). The two taxonomies
// don't line up 1:1, so this is a best-effort, hand-maintained table -
// verify each entry against live tiles (map.queryRenderedFeatures) rather
// than trusting it blindly, since OpenMapTiles' exact class/subclass values
// aren't guaranteed stable across schema versions.
//
// Used both to build the runtime map.setFilter expression that hides
// non-addable basemap POIs (see RouteMap.tsx's BasemapPoiFilter) and to
// resolve a clicked feature's properties back to a poi_type.
export interface BasemapPoiMapping {
  poiType: string
  classes?: string[]
  subclasses?: string[]
}

export const BASEMAP_POI_MAPPING: BasemapPoiMapping[] = [
  { poiType: "water", classes: ["drinking_water"], subclasses: ["drinking_water"] },
  { poiType: "hospital", classes: ["hospital"], subclasses: ["hospital"] },
  { poiType: "pharmacy", classes: ["pharmacy"], subclasses: ["pharmacy"] },
  { poiType: "bar", classes: ["bar"], subclasses: ["bar"] },
  { poiType: "bike_shop", classes: ["bicycle"], subclasses: ["bicycle"] },
  { poiType: "coffee", classes: ["cafe"], subclasses: ["cafe"] },
  { poiType: "food", classes: ["restaurant"], subclasses: ["restaurant"] },
  { poiType: "gas_station", classes: ["fuel"], subclasses: ["fuel"] },
  { poiType: "groceries", subclasses: ["supermarket", "convenience", "grocery"] },
  { poiType: "shopping", classes: ["shop"] },
  { poiType: "info", classes: ["information"], subclasses: ["information"] },
  {
    poiType: "lodging",
    subclasses: ["hotel", "motel", "guest_house", "hostel", "alpine_hut", "wilderness_hut"],
    classes: ["lodging"],
  },
  { poiType: "toilet", classes: ["toilets"], subclasses: ["toilets"] },
  { poiType: "bike_parking", classes: ["bicycle_parking"], subclasses: ["bicycle_parking"] },
  { poiType: "bike_share", classes: ["bicycle_rental"], subclasses: ["bicycle_rental"] },
  // OpenMapTiles doesn't distinguish bicycle=yes charging stations from
  // generic EV ones - this will also match car charging stations. Grouped
  // under class "fuel" alongside amenity=fuel, not its own "charging_station"
  // class - the subclass match (which is the raw tag value either way) is
  // what actually does the work here.
  { poiType: "e_bike_charging", classes: ["fuel"], subclasses: ["charging_station"] },
  { poiType: "ferry", classes: ["ferry_terminal"], subclasses: ["ferry_terminal"] },
  { poiType: "parking", classes: ["parking"], subclasses: ["parking"] },
  { poiType: "transit", classes: ["bus"], subclasses: ["bus_stop"] },
  { poiType: "campsite", classes: ["campsite"], subclasses: ["camp_site"] },
  { poiType: "dog_park", classes: ["dog_park"], subclasses: ["dog_park"] },
  { poiType: "park", classes: ["park"], subclasses: ["park"] },
  { poiType: "swimming", classes: ["swimming"], subclasses: ["swimming_pool", "swimming_area", "bathing_place"] },
  // natural=peak isn't part of OpenMapTiles' "poi" source-layer at all (it's
  // rendered via a separate mountain_peak layer, which road-cycling.json's
  // poi_r*/poi_transit layers don't reference) - this entry is a no-op until
  // that layer is wired up too, kept here as documentation of the gap rather
  // than a working mapping.
  { poiType: "summit", classes: ["peak"], subclasses: ["peak"] },
  { poiType: "atm", classes: ["atm"], subclasses: ["atm"] },
  { poiType: "art", classes: ["art_gallery"], subclasses: ["artwork"] },
  { poiType: "attraction", classes: ["attraction"], subclasses: ["attraction"] },
  { poiType: "monument", classes: ["monument"], subclasses: ["monument"] },
  { poiType: "viewpoint", classes: ["attraction"], subclasses: ["viewpoint"] },
  // Low confidence these render as OpenMapTiles poi *points* at all - worth
  // verifying against live tiles before relying on them: winery (shop=wine),
  // shower (amenity=shower), rest_area (highway=rest_area), chairlift
  // (aerialway=chair_lift is usually rendered as a line, not a point).
]

type MapLibreFilterExpression = unknown[]

function conditionFor(m: BasemapPoiMapping): MapLibreFilterExpression {
  const clauses: MapLibreFilterExpression[] = []
  if (m.subclasses) clauses.push(["match", ["get", "subclass"], m.subclasses, true, false])
  if (m.classes) clauses.push(["match", ["get", "class"], m.classes, true, false])
  return clauses.length === 1 ? clauses[0] : ["any", ...clauses]
}

// A MapLibre filter expression matching any basemap POI feature whose
// class/subclass corresponds to one of our addable poi_types.
export function buildAddablePoiFilter(): MapLibreFilterExpression {
  return ["any", ...BASEMAP_POI_MAPPING.map(conditionFor)]
}

// Mirrors the style's own icon-image selection logic (poi_r20/poi_r7 pick
// their sprite by matching subclass first, falling back to class), so a
// click resolves to the same poi_type the visible icon represents.
export function resolvePoiTypeFromFeatureProps(props: {
  class?: string
  subclass?: string
}): string | null {
  if (props.subclass) {
    const bySubclass = BASEMAP_POI_MAPPING.find((m) => m.subclasses?.includes(props.subclass!))
    if (bySubclass) return bySubclass.poiType
  }
  if (props.class) {
    const byClass = BASEMAP_POI_MAPPING.find((m) => m.classes?.includes(props.class!))
    if (byClass) return byClass.poiType
  }
  return null
}
