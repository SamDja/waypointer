/**
 * Google's encoded polyline format: each coordinate as the delta from the
 * previous one, in base-64-ish printable ASCII. Used to fit a planned route's
 * points into one analytics string (Umami caps strings at 500 characters):
 * at `precision` 2 a point costs about 6 characters, against 12+ as text.
 *
 * `precision` is the number of decimals kept (Google uses 5); decode with the
 * same precision, e.g. `polyline.decode(str, 2)` from @mapbox/polyline.
 */
export function encodePolyline(points: [number, number][], precision = 5): string {
  const factor = 10 ** precision
  let out = ""
  let prevLat = 0
  let prevLon = 0
  for (const [lat, lon] of points) {
    const latE = Math.round(lat * factor)
    const lonE = Math.round(lon * factor)
    out += encodeSigned(latE - prevLat) + encodeSigned(lonE - prevLon)
    prevLat = latE
    prevLon = lonE
  }
  return out
}

function encodeSigned(value: number): string {
  // Left-shift, and invert a negative value, so the sign ends up in the low bit.
  let v = value < 0 ? ~(value << 1) : value << 1
  let out = ""
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
    v >>= 5
  }
  return out + String.fromCharCode(v + 63)
}
