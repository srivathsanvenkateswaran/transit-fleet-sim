import { describe, expect, it } from 'vitest'
import type { GtfsTrip } from '../../src/geometry/loadGtfs.js'
import type { ShapeIndex } from '../../src/geometry/shape.js'
import { advanceCursor, advanceOneWay, createCursor } from '../../src/sim/cursor.js'
import type { BusMotionProfile } from '../../src/sim/profile.js'

/**
 * docs/intercity-coaches.md §3.4: "A run has no end, only a layover... A
 * coach that reaches Hampi at 06:30 does not turn round and drive to
 * Bengaluru at 06:35." `SimWorld.advanceBus` (tested in tests/sim/world.test.ts)
 * is the looping caller a city bus keeps using, completely unchanged;
 * `advanceOneWay` is the new one, and this file is where it is proven to
 * actually stop rather than trusted to by a comment.
 */

const START = new Date('2026-09-05T17:29:00Z')

// The same one-stop-then-terminal fixture tests/sim/cursor.test.ts already
// uses for `advanceCursor`, at a fixed 10 m/s (36 kph) so elapsed time and
// distance covered are simple arithmetic.
const SHAPE: ShapeIndex = {
  id: 'shape',
  points: [
    { lat: 12.97, lon: 77.59, sequence: 0, cumulativeDistanceMetres: 0 },
    { lat: 12.98, lon: 77.6, sequence: 1, cumulativeDistanceMetres: 1_000 },
  ],
  lengthMetres: 1_000,
  distanceSource: 'haversine',
}
const STOP = { id: 'a', name: 'A', nameLocal: null, lat: 12.971, lon: 77.591 }
const TRIP: GtfsTrip = {
  id: 'trip',
  routeId: 'route',
  serviceId: 'weekday',
  shapeId: 'shape',
  directionId: 0,
  headsign: 'Terminal',
  stops: [
    { stop: STOP, sequence: 1, arrivalTime: '17:29:10', departureTime: '17:29:10', stopDistanceMetres: 100 },
  ],
}
const PROFILE: BusMotionProfile = {
  seed: 1,
  speedKphMean: 36,
  speedKphSd: 0,
  speedKphMin: 36,
  speedKphMax: 36,
  dwellSecondsMean: 10,
  dwellSecondsSd: 0,
  peakSpeedFactor: 1,
  peakWindowMinutes: [],
  timezone: 'Asia/Kolkata',
  terminalLayoverSeconds: 20,
}

// 10s to the 100m stop, 10s dwell (dwellSecondsMean, sd 0), 90s for the
// remaining 900m at 10 m/s: 110s covers the whole run with room to spare.
const SECONDS_TO_TERMINAL = 130

describe('a one-way run (docs/intercity-coaches.md §3.4)', () => {
  it('reaches the terminal, sets arrivedAtMs, and stops rather than turning round', () => {
    const cursor = createCursor(TRIP, 0, PROFILE, 'KBS-01847', START)
    expect(cursor.arrivedAtMs).toBeNull()

    const result = advanceOneWay(cursor, TRIP, SHAPE, START, SECONDS_TO_TERMINAL, PROFILE, 'KBS-01847')

    expect(result.arrived).toBe(true)
    expect(cursor.distanceMetres).toBe(1_000)
    expect(cursor.arrivedAtMs).not.toBeNull()
    expect(cursor.arrivedAtMs).toBeLessThanOrEqual(START.getTime() + SECONDS_TO_TERMINAL * 1_000)
    // Unlike a bus, nothing resets the trip or flips direction: no layover
    // was ever set, because there is nothing to lay over into.
    expect(cursor.layoverUntilMs).toBeNull()
  })

  it('is idempotent once arrived: more elapsed time moves it no further', () => {
    const cursor = createCursor(TRIP, 0, PROFILE, 'KBS-01847', START)
    advanceOneWay(cursor, TRIP, SHAPE, START, SECONDS_TO_TERMINAL, PROFILE, 'KBS-01847')
    const arrivedAt = cursor.arrivedAtMs
    const distanceAtArrival = cursor.distanceMetres

    const later = new Date(START.getTime() + SECONDS_TO_TERMINAL * 1_000)
    const second = advanceOneWay(cursor, TRIP, SHAPE, later, 3_600, PROFILE, 'KBS-01847')

    expect(second).toEqual({ consumedSeconds: 0, arrived: true })
    expect(cursor.distanceMetres).toBe(distanceAtArrival)
    expect(cursor.arrivedAtMs).toBe(arrivedAt)
  })

  it('does not arrive early: partway through the run, arrived is false and distance is partial', () => {
    const cursor = createCursor(TRIP, 0, PROFILE, 'KBS-01847', START)
    const result = advanceOneWay(cursor, TRIP, SHAPE, START, 5, PROFILE, 'KBS-01847')
    expect(result.arrived).toBe(false)
    expect(cursor.arrivedAtMs).toBeNull()
    expect(cursor.distanceMetres).toBe(50)
  })

  it('contrasts with a bus: the same terminal, reached through advanceCursor directly, only signals reachedTerminal and leaves it to the caller to decide - which SimWorld.advanceBus resolves by flipping, and advanceOneWay resolves by stopping', () => {
    const busCursor = createCursor(TRIP, 0, PROFILE, 'BLR-04126', START)
    const busResult = advanceCursor(busCursor, TRIP, SHAPE, START, SECONDS_TO_TERMINAL, PROFILE, 'BLR-04126')
    expect(busResult.reachedTerminal).toBe(true)
    // advanceCursor itself never sets arrivedAtMs - that is advanceOneWay's
    // decision, not a property of reaching the end of a shape.
    expect(busCursor.arrivedAtMs).toBeNull()
  })
})
