import { describe, expect, it } from 'vitest'
import { rand, randInt } from '../../src/sim/rand.js'

describe('keyed seeded random draws', () => {
  it('returns the same value for the same complete key', () => {
    expect(rand(1, 'BLR-04126', 'coverage', 0)).toBe(
      rand(1, 'BLR-04126', 'coverage', 0),
    )
  })

  it('changes when any key dimension changes', () => {
    const base = rand(1, 'BLR-04126', 'dropout', 10)
    expect(rand(2, 'BLR-04126', 'dropout', 10)).not.toBe(base)
    expect(rand(1, 'BLR-04139', 'dropout', 10)).not.toBe(base)
    expect(rand(1, 'BLR-04126', 'coverage', 10)).not.toBe(base)
    expect(rand(1, 'BLR-04126', 'dropout', 11)).not.toBe(base)
  })

  it('draws integers inside the requested half-open range', () => {
    for (let bucket = 0; bucket < 100; bucket += 1) {
      const value = randInt(1, 'BLR-04126', 'test', bucket, 4, 9)
      expect(value).toBeGreaterThanOrEqual(4)
      expect(value).toBeLessThan(9)
    }
  })
})
