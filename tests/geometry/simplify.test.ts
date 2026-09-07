import { describe, expect, it } from 'vitest'
import type { Coordinate } from '../../src/geometry/haversine.js'
import { simplify } from '../../src/geometry/simplify.js'

describe('Douglas-Peucker simplification', () => {
  it('collapses a straight line to its two endpoints', () => {
    const points: Coordinate[] = Array.from({ length: 50 }, (_, index) => ({
      lat: 13 + index * 0.001,
      lon: 77,
    }))
    const result = simplify(points, 15)
    expect(result).toEqual([points[0], points.at(-1)])
  })

  it('always keeps the first and last point, even at a huge tolerance', () => {
    const points: Coordinate[] = Array.from({ length: 20 }, (_, index) => ({
      lat: 13 + index * 0.01,
      lon: 77 + Math.sin(index) * 0.01,
    }))
    const result = simplify(points, 1_000_000)
    expect(result[0]).toEqual(points[0])
    expect(result.at(-1)).toEqual(points.at(-1))
  })

  it('keeps a point that sits far off the chord between its neighbours', () => {
    const points: Coordinate[] = [
      { lat: 13, lon: 77 },
      { lat: 13.05, lon: 77.5 }, // well off the KBS-Hampi-style straight line
      { lat: 14, lon: 78 },
    ]
    const result = simplify(points, 15)
    expect(result).toHaveLength(3)
  })

  it('is a no-op below two points and at a non-positive tolerance', () => {
    const points: Coordinate[] = [{ lat: 13, lon: 77 }]
    expect(simplify(points, 15)).toEqual(points)
    const twoPointsAndMore: Coordinate[] = [
      { lat: 13, lon: 77 },
      { lat: 13.01, lon: 77.2 },
      { lat: 13.02, lon: 77.4 },
    ]
    expect(simplify(twoPointsAndMore, 0)).toEqual(twoPointsAndMore)
  })

  it('never leaves a dropped point farther than the tolerance from the simplified line', () => {
    // A gently wiggling path - the case simplification is actually for.
    const points: Coordinate[] = Array.from({ length: 400 }, (_, index) => ({
      lat: 13 + index * 0.001,
      lon: 77 + Math.sin(index / 30) * 0.0005,
    }))
    const tolerance = 15
    const result = simplify(points, tolerance)
    expect(result.length).toBeLessThan(points.length)
    // Every original point must lie within tolerance of *some* segment of
    // the simplified line - a coarse but real fidelity bound.
    for (const point of points) {
      let nearest = Number.POSITIVE_INFINITY
      for (let index = 1; index < result.length; index += 1) {
        nearest = Math.min(nearest, segmentDistanceMetres(point, result[index - 1]!, result[index]!))
      }
      expect(nearest).toBeLessThanOrEqual(tolerance + 1) // +1m for the planar approximation
    }
  })
})

function segmentDistanceMetres(point: Coordinate, start: Coordinate, end: Coordinate): number {
  const cosLatitude = Math.cos((point.lat * Math.PI) / 180)
  const toMetresX = (value: number) => value * 111_320 * cosLatitude
  const toMetresY = (value: number) => value * 111_320
  const startX = toMetresX(start.lon - point.lon)
  const startY = toMetresY(start.lat - point.lat)
  const endX = toMetresX(end.lon - point.lon)
  const endY = toMetresY(end.lat - point.lat)
  const deltaX = endX - startX
  const deltaY = endY - startY
  const denominator = deltaX * deltaX + deltaY * deltaY
  const fraction = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / denominator))
  const projectedX = startX + deltaX * fraction
  const projectedY = startY + deltaY * fraction
  return Math.hypot(projectedX, projectedY)
}
