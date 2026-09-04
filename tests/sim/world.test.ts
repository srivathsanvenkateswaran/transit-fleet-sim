import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'
import type { SimClock } from '../../src/sim/clock.js'
import { defaultBusDeviceProfile } from '../../src/sim/device.js'
import { defaultBusMotionProfile } from '../../src/sim/profile.js'
import { SimWorld, createWorld } from '../../src/sim/world.js'

const START = new Date('2026-08-20T03:00:00Z')

class FixedClock implements SimClock {
  constructor(private readonly value: Date) {}
  now(): Date {
    return new Date(this.value)
  }
}

describe('simulation world', () => {
  it('produces byte-identical output for the same seed and clock', async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 23, routes: ['500-D'], busesPerRoute: 4 })
    const profile = { ...defaultBusMotionProfile, seed: 23 }
    const first = new SimWorld(gtfs, fleet, { clock: new FixedClock(START), profile })
    const second = new SimWorld(gtfs, fleet, { clock: new FixedClock(START), profile })
    for (const seconds of [1, 2, 10, 60, 300]) {
      const at = new Date(START.getTime() + seconds * 1000)
      first.tickAt(at)
      second.tickAt(at)
    }
    expect(JSON.stringify(first.snapshot())).toBe(JSON.stringify(second.snapshot()))
  })

  it('moves independently of requests and reports a completed tick', async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 3, routes: ['G-4'], busesPerRoute: 1 })
    const world = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(START),
      deviceProfile: {
        ...defaultBusDeviceProfile,
        seed: 3,
        coverageShare: 1,
        fixIntervalSeconds: 1,
        fixJitterSeconds: 0,
        dropoutRatePerHour: 0,
      },
    })
    const bin = fleet[0]!.bin
    const before = world.observe(bin, START)
    expect(world.observe(bin, START)).toEqual(before)
    const later = new Date(START.getTime() + 5_000)
    world.tickAt(later)
    expect(world.observe(bin, later)?.tracking.position).not.toEqual(before?.tracking.position)
    expect(world.status().lastTickAt).toBe(later.toISOString())
  })

  it('loads the bundled metro topology into readiness status', async () => {
    const fleet = generateFleet({ seed: 7, routes: ['500-D'], busesPerRoute: 1 })
    const world = await createWorld(fleet)
    expect(world.status(world.now()).metroLines).toBe(3)
    await world.stop()
  })

  it('reports live occupancy but withholds it once the vehicle goes dark', async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 11, routes: ['500-D'], busesPerRoute: 1 })
    const world = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(START),
      deviceProfile: {
        ...defaultBusDeviceProfile,
        seed: 11,
        coverageShare: 1,
        fixIntervalSeconds: 100_000,
        fixJitterSeconds: 0,
        staleAfterSeconds: 60,
        darkAfterSeconds: 120,
        dropoutRatePerHour: 0,
      },
    })
    const bin = fleet[0]!.bin
    const live = world.observe(bin, START)
    expect(live?.tracking.state).toBe('live')
    expect(live?.occupancy?.status).not.toBe('NO_DATA_AVAILABLE')
    expect(live?.occupancy?.percentage).toBeGreaterThanOrEqual(0)

    const dark = new Date(START.getTime() + 130_000)
    world.tickAt(dark)
    const observedDark = world.observe(bin, dark)
    expect(observedDark?.tracking.state).toBe('dark')
    expect(observedDark?.occupancy).toEqual({ status: 'NO_DATA_AVAILABLE' })
  })

  it("freezes a stale vehicle's occupancy at the last fix instead of drifting with the clock", async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 13, routes: ['500-D'], busesPerRoute: 1 })
    const world = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(START),
      deviceProfile: {
        ...defaultBusDeviceProfile,
        seed: 13,
        coverageShare: 1,
        fixIntervalSeconds: 100_000,
        fixJitterSeconds: 0,
        staleAfterSeconds: 5,
        darkAfterSeconds: 100_000,
        dropoutRatePerHour: 0,
      },
    })
    const bin = fleet[0]!.bin
    const firstStale = new Date(START.getTime() + 30_000)
    world.tickAt(firstStale)
    const firstObservation = world.observe(bin, firstStale)
    expect(firstObservation?.tracking.state).toBe('stale')

    const laterStale = new Date(START.getTime() + 400_000)
    world.tickAt(laterStale)
    const laterObservation = world.observe(bin, laterStale)
    expect(laterObservation?.tracking.state).toBe('stale')
    // The bus's simulated cursor has moved a long way in those six minutes,
    // but the reported fix - and its occupancy - has not.
    expect(laterObservation?.occupancy).toEqual(firstObservation?.occupancy)
    expect(laterObservation?.tracking.position).toEqual(firstObservation?.tracking.position)
  })
})
