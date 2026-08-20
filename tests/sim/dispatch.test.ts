import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'
import { dispatchInitialFleet } from '../../src/sim/dispatch.js'
import { defaultBusMotionProfile } from '../../src/sim/profile.js'

describe('bus dispatch', () => {
  it('spreads each route fleet across both directions at startup', async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 1, routes: ['500-D'], busesPerRoute: 6 })
    const active = dispatchInitialFleet(
      fleet,
      gtfs,
      defaultBusMotionProfile,
      new Date('2026-08-20T03:00:00Z'),
    )
    expect(active.filter((bus) => bus.trip.directionId === 0)).toHaveLength(3)
    expect(active.filter((bus) => bus.trip.directionId === 1)).toHaveLength(3)
    expect(new Set(active.map((bus) => Math.round(bus.cursor.distanceMetres))).size).toBeGreaterThan(3)
  })
})
