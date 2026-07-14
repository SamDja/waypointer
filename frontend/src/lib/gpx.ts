// Best-effort client-side parse for an instant map preview right after
// import, before the backend has computed the authoritative route_coords.
// Mirrors gpx_io.route_coordinates() in the backend: all track points,
// then all route points. Returns [] on any parse failure - this is not
// validation, the backend still validates the file on "Find Water Fountains".
export function parseRouteCoordsFromGpx(xmlText: string): [number, number][] {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml")
    if (doc.getElementsByTagName("parsererror").length > 0) return []

    const coords: [number, number][] = []
    const pointEls = [...doc.getElementsByTagName("trkpt"), ...doc.getElementsByTagName("rtept")]
    for (const el of pointEls) {
      const lat = parseFloat(el.getAttribute("lat") ?? "")
      const lon = parseFloat(el.getAttribute("lon") ?? "")
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        coords.push([lat, lon])
      }
    }
    return coords
  } catch {
    return []
  }
}
