import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import { FleetRegistry } from '../../src/fleet/registry.js'

describe('seeded fleet generation', () => {
  it('starts with the canonical BIN and generates only non-real ZZ plates', () => {
    const fleet = generateFleet({ seed: 7, routes: ['500-D'], busesPerRoute: 3, hub: 'BLR' })
    expect(fleet[0]?.bin).toBe('BLR-04126')
    expect(fleet.every((vehicle) => vehicle.plates.every((plate) => /^KA\d{2}ZZ\d{4}$/.test(plate.normalised)))).toBe(true)
    expect(() => new FleetRegistry(fleet)).not.toThrow()
  })

  it('is byte-identical for a seed and changes identity fixtures with a different seed', () => {
    const options = { routes: ['500-D', 'G-4'], busesPerRoute: 2, hub: 'BLR' } as const
    expect(JSON.stringify(generateFleet({ ...options, seed: 9 }))).toBe(
      JSON.stringify(generateFleet({ ...options, seed: 9 })),
    )
    expect(JSON.stringify(generateFleet({ ...options, seed: 9 }))).not.toBe(
      JSON.stringify(generateFleet({ ...options, seed: 10 })),
    )
  })
})
