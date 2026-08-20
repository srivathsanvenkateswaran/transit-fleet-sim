import { describe, expect, it } from 'vitest'
import type { GtfsTrip } from '../../src/geometry/loadGtfs.js'
import type { ShapeIndex } from '../../src/geometry/shape.js'
import { advanceCursor, createCursor } from '../../src/sim/cursor.js'
import type { BusMotionProfile } from '../../src/sim/profile.js'

const START = new Date('2026-08-20T03:00:00Z')
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
  headsign: 'End',
  stops: [
    {
      stop: STOP,
      sequence: 1,
      arrivalTime: '08:00:00',
      departureTime: '08:00:00',
      stopDistanceMetres: 100,
    },
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
  peakWindows: '',
  timezone: 'Asia/Kolkata',
  terminalLayoverSeconds: 20,
}

describe('bus cursor', () => {
  it('moves to a stop, dwells, then resumes without losing elapsed time', () => {
    const cursor = createCursor(TRIP, 0, PROFILE, 'BLR-04126', START)
    advanceCursor(cursor, TRIP, SHAPE, START, 10, PROFILE, 'BLR-04126')
    expect(cursor.distanceMetres).toBe(100)
    expect(cursor.dwellUntilMs).toBe(START.getTime() + 20_000)

    advanceCursor(
      cursor,
      TRIP,
      SHAPE,
      new Date(START.getTime() + 10_000),
      5,
      PROFILE,
      'BLR-04126',
    )
    expect(cursor.distanceMetres).toBe(100)

    advanceCursor(
      cursor,
      TRIP,
      SHAPE,
      new Date(START.getTime() + 15_000),
      10,
      PROFILE,
      'BLR-04126',
    )
    expect(cursor.distanceMetres).toBe(150)
  })
})
