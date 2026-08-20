const EARTH_RADIUS_METRES = 6_371_008.8

export interface Coordinate {
  readonly lat: number
  readonly lon: number
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
const toDegrees = (radians: number): number => (radians * 180) / Math.PI

export function haversineMetres(a: Coordinate, b: Coordinate): number {
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const deltaLat = lat2 - lat1
  const deltaLon = toRadians(b.lon - a.lon)
  const sinLat = Math.sin(deltaLat / 2)
  const sinLon = Math.sin(deltaLon / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function initialBearingDegrees(a: Coordinate, b: Coordinate): number {
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const deltaLon = toRadians(b.lon - a.lon)
  const y = Math.sin(deltaLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)
  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}
