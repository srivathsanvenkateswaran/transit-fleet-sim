import { describe, expect, it } from 'vitest'
import { projectStop } from '../../src/geometry/projectStops.js'
import { buildShapeIndex } from '../../src/geometry/shape.js'

describe('stop projection', () => {
  it('projects onto the closest segment and reports the offset', () => {
    const shape = buildShapeIndex('straight', [
      { lat: 12.97, lon: 77.59, sequence: 0 },
      { lat: 12.97, lon: 77.61, sequence: 1 },
    ])
    const projected = projectStop(shape, { id: 'stop', lat: 12.971, lon: 77.6 })
    expect(projected.stopDistanceMetres).toBeCloseTo(shape.lengthMetres / 2, -1)
    expect(projected.offsetMetres).toBeCloseTo(111, -1)
  })
})
