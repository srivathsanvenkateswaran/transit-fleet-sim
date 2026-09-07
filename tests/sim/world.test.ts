import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'
import type { SimClock } from '../../src/sim/clock.js'
import { defaultBusDeviceProfile } from '../../src/sim/device.js'
import { dispatchInitialFleet } from '../../src/sim/dispatch.js'
import { defaultBusDutyProfile } from '../../src/sim/duty.js'
import { defaultBusMotionProfile } from '../../src/sim/profile.js'
import { rand } from '../../src/sim/rand.js'
import { serviceDate } from '../../src/sim/serviceDate.js'
import { SimWorld, createWorld, type DispatchFleet } from '../../src/sim/world.js'

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

  // docs/intercity-coaches.md §14.1: "no new field appears on any response"
  // while `INTERCITY_CORRIDORS` is unset - the migration guarantee, at the
  // level `WorldStatus` is built rather than at the HTTP layer that reads it.
  it('omits `corridors` from status entirely when the intercity feature is off (the default)', async () => {
    const fleet = generateFleet({ seed: 7, routes: ['500-D'], busesPerRoute: 1 })
    const world = await createWorld(fleet)
    expect(Object.keys(world.status(world.now()))).not.toContain('corridors')
    await world.stop()
  })

  it('publishes `corridors` on status once a corridor count is configured', async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 7, routes: ['500-D'], busesPerRoute: 1 })
    const world = new SimWorld(gtfs, fleet, { clock: new FixedClock(START), corridorCount: 1 })
    expect(world.status().corridors).toBe(1)
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

  // docs/intercity-coaches.md §3.1: `createDutyState` used to be keyed on
  // `serviceDate(this.#lastTickAt, ...)` - the calendar date the *world*
  // happened to boot on - rather than on the service date of the duty being
  // drawn. For a city bus the two instants are always the same value, because
  // `dispatchInitialFleet` sets every bus's `tripStartedAt` to the world's own
  // construction instant; that coincidence is exactly why the bug has never
  // bitten a city bus and exactly why it cannot be reproduced without a seam
  // that lets a test pull the two instants apart. A corridor duty is where
  // they genuinely diverge on their own - dispatched at 22:59 on one calendar
  // day, observed after a process restart on the next - which is what makes
  // this "a live bug today, independent of intercity": the wiring was already
  // wrong, only the roster is what makes the wrongness reachable.
  it("keys a duty draw on the duty's own start instant, not on the instant the world booted", async () => {
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 41, routes: ['500-D'], busesPerRoute: 1 })
    const bin = fleet[0]!.bin

    // 2026-09-05T16:00:00Z is 2026-09-05 21:30 IST; 2026-09-06T10:00:00Z is
    // 2026-09-06 15:30 IST. Two different IST calendar dates, deliberately -
    // see the assertion below that the two candidate rand() keys actually
    // disagree, without which this test could pass by accident.
    const dutyStartedAt = new Date('2026-09-05T16:00:00Z')
    const restartedNextCalendarDay = new Date('2026-09-06T10:00:00Z')
    const pinTripStart: DispatchFleet = (members, gtfsArg, profile, at) =>
      dispatchInitialFleet(members, gtfsArg, profile, at).map((bus) => ({
        ...bus,
        tripStartedAt: dutyStartedAt,
      }))

    const bootOnStartDay = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(dutyStartedAt),
      dispatch: pinTripStart,
    })
    const bootAfterRestart = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(restartedNextCalendarDay),
      dispatch: pinTripStart,
    })

    const observedAt = new Date(restartedNextCalendarDay.getTime() + 60_000)
    const first = bootOnStartDay.observe(bin, observedAt)
    const second = bootAfterRestart.observe(bin, observedAt)
    expect(second?.duty.status).toBe(first?.duty.status)
    expect(second?.duty.confidence).toBe(first?.duty.confidence)
    expect(second?.duty.reason).toBe(first?.duty.reason)

    const correctKeyDraw = rand(
      defaultBusDutyProfile.seed,
      bin,
      'duty',
      serviceDate(dutyStartedAt, 'Asia/Kolkata'),
    )
    const boottimeKeyDraw = rand(
      defaultBusDutyProfile.seed,
      bin,
      'duty',
      serviceDate(restartedNextCalendarDay, 'Asia/Kolkata'),
    )
    expect(correctKeyDraw).not.toBe(boottimeKeyDraw)
  })
})
