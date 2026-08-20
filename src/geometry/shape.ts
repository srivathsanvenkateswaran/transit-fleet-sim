import { haversineMetres, initialBearingDegrees, type Coordinate } from './haversine.js'

export interface RawShapePoint extends Coordinate {
  readonly sequence: number
  readonly sourceDistanceMetres?: number
}

export interface ShapePoint extends Coordinate {
  readonly sequence: number
  readonly cumulativeDistanceMetres: number
}

export interface ShapeIndex {
  readonly id: string
  readonly points: readonly ShapePoint[]
  readonly lengthMetres: number
  readonly distanceSource: 'shape_dist_traveled' | 'haversine'
}

export interface InterpolatedPosition extends Coordinate {
  readonly bearing: number
}

export interface ShapeDistanceMeasurement {
  readonly monotonic: boolean
  readonly sourceLengthMetres: number | null
  readonly haversineLengthMetres: number
  readonly differencePercent: number | null
  readonly usable: boolean
}

export function measureShapeDistances(points: readonly RawShapePoint[]): ShapeDistanceMeasurement {
  assertEnoughPoints(points)
  const ordered = [...points].sort((a, b) => a.sequence - b.sequence)
  let haversineLengthMetres = 0
  let monotonic = true
  let allSourceDistancesPresent = true

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (previous === undefined || current === undefined) continue
    haversineLengthMetres += haversineMetres(previous, current)
    if (previous.sourceDistanceMetres === undefined || current.sourceDistanceMetres === undefined) {
      allSourceDistancesPresent = false
    } else if (current.sourceDistanceMetres < previous.sourceDistanceMetres) {
      monotonic = false
    }
  }

  const last = ordered.at(-1)
  const sourceLengthMetres = allSourceDistancesPresent ? (last?.sourceDistanceMetres ?? null) : null
  const differencePercent =
    sourceLengthMetres === null || haversineLengthMetres === 0
      ? null
      : (Math.abs(sourceLengthMetres - haversineLengthMetres) / haversineLengthMetres) * 100

  return {
    monotonic,
    sourceLengthMetres,
    haversineLengthMetres,
    differencePercent,
    usable: monotonic && differencePercent !== null && differencePercent <= 5,
  }
}

export function buildShapeIndex(id: string, points: readonly RawShapePoint[]): ShapeIndex {
  const ordered = [...points].sort((a, b) => a.sequence - b.sequence)
  const measurement = measureShapeDistances(ordered)
  let cumulative = 0
  const indexed = ordered.map((point, index): ShapePoint => {
    if (index > 0 && !measurement.usable) {
      const previous = ordered[index - 1]
      if (previous !== undefined) cumulative += haversineMetres(previous, point)
    }
    return {
      lat: point.lat,
      lon: point.lon,
      sequence: point.sequence,
      cumulativeDistanceMetres: measurement.usable ? (point.sourceDistanceMetres ?? 0) : cumulative,
    }
  })

  return {
    id,
    points: indexed,
    lengthMetres: indexed.at(-1)?.cumulativeDistanceMetres ?? 0,
    distanceSource: measurement.usable ? 'shape_dist_traveled' : 'haversine',
  }
}

export function positionAt(shape: ShapeIndex, distanceMetres: number): InterpolatedPosition {
  const distance = Math.max(0, Math.min(distanceMetres, shape.lengthMetres))
  let low = 0
  let high = shape.points.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const point = shape.points[middle]
    if (point !== undefined && point.cumulativeDistanceMetres < distance) low = middle + 1
    else high = middle
  }

  const endIndex = Math.max(1, low)
  const start = shape.points[endIndex - 1]
  const end = shape.points[endIndex]
  if (start === undefined || end === undefined) throw new Error(`Shape ${shape.id} has no usable segment`)
  const segmentLength = end.cumulativeDistanceMetres - start.cumulativeDistanceMetres
  const fraction = segmentLength <= 0 ? 0 : (distance - start.cumulativeDistanceMetres) / segmentLength
  return {
    lat: start.lat + (end.lat - start.lat) * fraction,
    lon: start.lon + (end.lon - start.lon) * fraction,
    bearing: initialBearingDegrees(start, end),
  }
}

function assertEnoughPoints(points: readonly RawShapePoint[]): void {
  if (points.length < 2) throw new Error('A shape needs at least two points')
}
