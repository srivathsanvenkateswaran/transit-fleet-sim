import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'
import type { DutyStatus, TrackingState } from '../../src/world/port.js'
import type { SimClock } from '../../src/sim/clock.js'
import { defaultBusDeviceProfile } from '../../src/sim/device.js'
import { defaultBusDutyProfile } from '../../src/sim/duty.js'
import { SimWorld } from '../../src/sim/world.js'

const START = new Date('2026-08-20T03:00:00Z')

class FixedClock implements SimClock {
  now(): Date {
    return new Date(START)
  }
}

describe('the four honesty cells', () => {
  it.each([
    ['A: known duty with lost sight', 'confirmed', 'dark'],
    ['B: known duty without a fitted device', 'confirmed', 'untracked'],
    ['C: visible vehicle with unknown duty', 'unknown', 'live'],
    ['D: registry facts and nothing else', 'unknown', 'untracked'],
    ['moving depot run is unsellable', 'out_of_service', 'live'],
  ] as const)('%s produces %s + %s', async (_name, duty, tracking) => {
    const observation = await produceCell(duty, tracking)
    expect(observation?.duty.status).toBe(duty)
    expect(observation?.tracking.state).toBe(tracking)
    if (duty === 'unknown' || duty === 'out_of_service') {
      expect(observation?.duty.route).toBeNull()
      expect(observation?.duty.trip).toBeNull()
      expect(observation?.duty.headsign).toBeNull()
      expect(observation?.duty.directionId).toBeNull()
    }
    if (tracking === 'untracked') {
      expect(observation?.tracking.position).toBeNull()
      expect(observation?.tracking.observedAt).toBeNull()
    }
  })

  it('changes duty on a mid-day swap without changing the retained tracking fix', async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 8, routes: ['500-D'], busesPerRoute: 1 })
    const world = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(),
      dutyProfile: {
        ...defaultBusDutyProfile,
        confirmedShare: 1,
        inferredShare: 0,
        unknownShare: 0,
        outOfServiceShare: 0,
        swapRatePerDay: 1_000_000,
      },
      deviceProfile: {
        ...defaultBusDeviceProfile,
        coverageShare: 1,
        fixIntervalSeconds: 1_000,
        fixJitterSeconds: 0,
        staleAfterSeconds: 100,
        darkAfterSeconds: 200,
        dropoutRatePerHour: 0,
        gpsNoiseMetres: 0,
      },
    })
    const bin = fleet[0]!.bin
    const before = world.observe(bin, START)
    const afterAt = new Date(START.getTime() + 60_000)
    world.tickAt(afterAt)
    const after = world.observe(bin, afterAt)
    expect(before?.duty.status).toBe('confirmed')
    expect(['inferred', 'unknown']).toContain(after?.duty.status)
    expect(after?.tracking).toEqual(before?.tracking)
  })
})

async function produceCell(duty: DutyStatus, tracking: TrackingState) {
  const gtfs = await loadGtfs()
  const fleet = generateFleet({ seed: 5, routes: ['500-D'], busesPerRoute: 1 })
  const tracked = tracking !== 'untracked'
  const world = new SimWorld(gtfs, fleet, {
    clock: new FixedClock(),
    dutyProfile: {
      ...defaultBusDutyProfile,
      confirmedShare: duty === 'confirmed' ? 1 : 0,
      inferredShare: duty === 'inferred' ? 1 : 0,
      unknownShare: duty === 'unknown' ? 1 : 0,
      outOfServiceShare: duty === 'out_of_service' ? 1 : 0,
      swapRatePerDay: 0,
    },
    deviceProfile: {
      ...defaultBusDeviceProfile,
      coverageShare: tracked ? 1 : 0,
      fixIntervalSeconds: 1_000,
      fixJitterSeconds: 0,
      staleAfterSeconds: 1,
      darkAfterSeconds: 2,
      dropoutRatePerHour: 0,
      gpsNoiseMetres: 0,
    },
  })
  const at = tracking === 'dark' ? new Date(START.getTime() + 3_000) : START
  if (tracking === 'dark') world.tickAt(at)
  return world.observe(fleet[0]!.bin, at)
}
