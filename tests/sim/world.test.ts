import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'
import type { SimClock } from '../../src/sim/clock.js'
import { defaultBusMotionProfile } from '../../src/sim/profile.js'
import { SimWorld } from '../../src/sim/world.js'

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
    const world = new SimWorld(gtfs, fleet, { clock: new FixedClock(START) })
    const bin = fleet[0]!.bin
    const before = world.observe(bin, START)
    expect(world.observe(bin, START)).toEqual(before)
    const later = new Date(START.getTime() + 5_000)
    world.tickAt(later)
    expect(world.observe(bin, later)?.tracking.position).not.toEqual(before?.tracking.position)
    expect(world.status().lastTickAt).toBe(later.toISOString())
  })
})
