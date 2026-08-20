import { describe, expect, it } from 'vitest'
import { buildShapeIndex, measureShapeDistances, positionAt } from '../../src/geometry/shape.js'

const points = [
  { lat: 12.97, lon: 77.59, sequence: 0, sourceDistanceMetres: 0 },
  { lat: 12.98, lon: 77.6, sequence: 1, sourceDistanceMetres: 1553 },
  { lat: 12.99, lon: 77.61, sequence: 2, sourceDistanceMetres: 3106 },
]

describe('shape distance index', () => {
  it('uses a monotonic source distance consistent with haversine', () => {
    const measurement = measureShapeDistances(points)
    expect(measurement.monotonic).toBe(true)
    expect(measurement.differencePercent).toBeLessThan(5)
    expect(buildShapeIndex('test', points).distanceSource).toBe('shape_dist_traveled')
  })

  it('recomputes cumulative distance when the source is inconsistent', () => {
    const shape = buildShapeIndex('test', [points[0]!, { ...points[1]!, sourceDistanceMetres: 20 }])
    expect(shape.distanceSource).toBe('haversine')
    expect(shape.lengthMetres).toBeGreaterThan(1_000)
  })

  it('interpolates a position and bearing along a segment', () => {
    const shape = buildShapeIndex('test', points)
    const position = positionAt(shape, 1553 / 2)
    expect(position.lat).toBeCloseTo(12.975)
    expect(position.lon).toBeCloseTo(77.595)
    expect(position.bearing).toBeGreaterThan(0)
  })
})
