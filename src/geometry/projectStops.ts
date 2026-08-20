import { haversineMetres, type Coordinate } from './haversine.js'
import type { ShapeIndex } from './shape.js'

export interface StopCoordinate extends Coordinate {
  readonly id: string
}

export interface ProjectedStop {
  readonly stopId: string
  readonly stopDistanceMetres: number
  readonly offsetMetres: number
}

export function projectStop(shape: ShapeIndex, stop: StopCoordinate): ProjectedStop {
  let bestOffset = Number.POSITIVE_INFINITY
  let bestDistance = 0
  const cosLatitude = Math.cos((stop.lat * Math.PI) / 180)

  for (let index = 1; index < shape.points.length; index += 1) {
    const start = shape.points[index - 1]
    const end = shape.points[index]
    if (start === undefined || end === undefined) continue
    const startX = (start.lon - stop.lon) * cosLatitude
    const startY = start.lat - stop.lat
    const endX = (end.lon - stop.lon) * cosLatitude
    const endY = end.lat - stop.lat
    const deltaX = endX - startX
    const deltaY = endY - startY
    const denominator = deltaX * deltaX + deltaY * deltaY
    const fraction = denominator === 0 ? 0 : clamp(-(startX * deltaX + startY * deltaY) / denominator)
    const projected = {
      lat: start.lat + (end.lat - start.lat) * fraction,
      lon: start.lon + (end.lon - start.lon) * fraction,
    }
    const offset = haversineMetres(stop, projected)
    if (offset < bestOffset) {
      bestOffset = offset
      bestDistance =
        start.cumulativeDistanceMetres +
        (end.cumulativeDistanceMetres - start.cumulativeDistanceMetres) * fraction
    }
  }

  return { stopId: stop.id, stopDistanceMetres: bestDistance, offsetMetres: bestOffset }
}

export function projectStops(
  shape: ShapeIndex,
  stops: readonly StopCoordinate[],
): readonly ProjectedStop[] {
  return stops.map((stop) => projectStop(shape, stop))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}
