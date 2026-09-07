import { haversineMetres, type Coordinate } from './haversine.js'

/**
 * Douglas-Peucker simplification, at a metres tolerance rather than a point
 * count. docs/intercity-coaches.md §11.2: a routed highway polyline at an
 * engine's full precision runs to one point every 10-30 m, and a 340 km
 * corridor at that density is the single largest new memory cost this
 * document adds. `INTERCITY_GEOMETRY_SIMPLIFY_METRES` (default 15) is chosen
 * against a fix's own GPS noise (`BUS_GPS_NOISE_METRES` is 12): a
 * simplification smaller than the noise a consumer already tolerates is
 * invisible in the published position, and it is on the long straight
 * stretches of a divided highway - where most of the points are - that this
 * removes the most.
 *
 * The perpendicular-distance test below is the same small-planar-patch
 * approximation `projectStops.ts` already uses (`cosLatitude` scaling rather
 * than a true geodesic cross-track distance): correct to well under a metre
 * over the few-kilometre span between two consecutive raw points, which is
 * all this function is ever asked to measure over.
 */
export function simplify(points: readonly Coordinate[], toleranceMetres: number): readonly Coordinate[] {
  if (points.length <= 2 || toleranceMetres <= 0) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  simplifySpan(points, 0, points.length - 1, toleranceMetres, keep)
  return points.filter((_, index) => keep[index] === 1)
}

function simplifySpan(
  points: readonly Coordinate[],
  startIndex: number,
  endIndex: number,
  toleranceMetres: number,
  keep: Uint8Array,
): void {
  if (endIndex <= startIndex + 1) return
  const start = points[startIndex]!
  const end = points[endIndex]!
  let farthestIndex = -1
  let farthestDistance = 0
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const distance = perpendicularDistanceMetres(points[index]!, start, end)
    if (distance > farthestDistance) {
      farthestDistance = distance
      farthestIndex = index
    }
  }
  if (farthestDistance <= toleranceMetres || farthestIndex === -1) return
  keep[farthestIndex] = 1
  simplifySpan(points, startIndex, farthestIndex, toleranceMetres, keep)
  simplifySpan(points, farthestIndex, endIndex, toleranceMetres, keep)
}

/** Perpendicular distance from `point` to the line segment `start`-`end`, in metres. */
function perpendicularDistanceMetres(point: Coordinate, start: Coordinate, end: Coordinate): number {
  if (start.lat === end.lat && start.lon === end.lon) return haversineMetres(point, start)
  const cosLatitude = Math.cos((point.lat * Math.PI) / 180)
  const startX = (start.lon - point.lon) * cosLatitude
  const startY = start.lat - point.lat
  const endX = (end.lon - point.lon) * cosLatitude
  const endY = end.lat - point.lat
  const deltaX = endX - startX
  const deltaY = endY - startY
  const denominator = deltaX * deltaX + deltaY * deltaY
  const fraction = denominator === 0 ? 0 : clamp01(-(startX * deltaX + startY * deltaY) / denominator)
  const projected: Coordinate = {
    lat: start.lat + (end.lat - start.lat) * fraction,
    lon: start.lon + (end.lon - start.lon) * fraction,
  }
  return haversineMetres(point, projected)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
