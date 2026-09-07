import { describe, expect, it } from 'vitest'
import type { GtfsRoute, GtfsStop, GtfsStopTime, GtfsTrip, LoadedGtfs } from '../../src/geometry/loadGtfs.js'
import { computeRouteRosterSizes } from '../../src/sim/busRoster.js'

const STOP_A: GtfsStop = { id: 'a', name: 'A', nameLocal: null, lat: 12.9, lon: 77.6 }
const STOP_B: GtfsStop = { id: 'b', name: 'B', nameLocal: null, lat: 12.95, lon: 77.65 }

function stopTime(stop: GtfsStop, sequence: number, time: string): GtfsStopTime {
  return { stop, sequence, arrivalTime: time, departureTime: time, stopDistanceMetres: sequence * 1000 }
}

function trip(id: string, routeId: string, stops: readonly GtfsStopTime[]): GtfsTrip {
  return { id, routeId, serviceId: 'weekday', shapeId: `${routeId}-shape`, directionId: 0, headsign: 'Test', stops }
}

function route(id: string, number: string, trips: readonly GtfsTrip[]): GtfsRoute {
  return { id, number, name: number, trips }
}

function gtfsWith(routes: readonly GtfsRoute[]): LoadedGtfs {
  return {
    routes: new Map(routes.map((r) => [r.id, r])),
    trips: new Map(routes.flatMap((r) => r.trips).map((t) => [t.id, t])),
    stops: new Map([[STOP_A.id, STOP_A], [STOP_B.id, STOP_B]]),
    shapes: new Map(),
    warnings: [],
  }
}

const OPTIONS = { turnaroundSeconds: 300, minimumPerRoute: 1, scale: 1 }

describe('computeRouteRosterSizes', () => {
  it('gives a single once-a-day trip exactly one vehicle', () => {
    const r = route('r1', 'X-1', [trip('t1', 'r1', [stopTime(STOP_A, 1, '08:00:00'), stopTime(STOP_B, 2, '08:30:00')])])
    const sizes = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], OPTIONS)
    expect(sizes.get('X-1')).toEqual({ routeNumber: 'X-1', vehicles: 1, realTripCount: 1 })
  })

  it('reuses one vehicle for trips that do not overlap once turnaround is added', () => {
    const r = route('r1', 'X-1', [
      trip('t1', 'r1', [stopTime(STOP_A, 1, '08:00:00'), stopTime(STOP_B, 2, '08:30:00')]),
      // Departs after the first trip's arrival plus the 300s turnaround -
      // the same physical bus could plausibly run both.
      trip('t2', 'r1', [stopTime(STOP_A, 1, '08:36:00'), stopTime(STOP_B, 2, '09:06:00')]),
    ])
    const sizes = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], OPTIONS)
    expect(sizes.get('X-1')?.vehicles).toBe(1)
  })

  it('requires a second vehicle for trips that genuinely overlap', () => {
    const r = route('r1', 'X-1', [
      trip('t1', 'r1', [stopTime(STOP_A, 1, '08:00:00'), stopTime(STOP_B, 2, '08:30:00')]),
      // Departs before the first trip's arrival-plus-turnaround: one vehicle
      // cannot be on both trips at once, so this needs its own bus.
      trip('t2', 'r1', [stopTime(STOP_A, 1, '08:05:00'), stopTime(STOP_B, 2, '08:35:00')]),
    ])
    const sizes = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], OPTIONS)
    expect(sizes.get('X-1')?.vehicles).toBe(2)
  })

  it('sizes a busy trunk route to its real peak overlap, not its trip count', () => {
    // Five trips a day apart (no overlap at all) plus three genuinely
    // simultaneous morning departures: peak concurrency is 3, not 8.
    const spaced = ['06:00:00', '10:00:00', '14:00:00', '18:00:00', '22:00:00'].map((time, index) =>
      trip(`spaced-${index}`, 'r1', [stopTime(STOP_A, 1, time), stopTime(STOP_B, 2, addMinutes(time, 20))]),
    )
    const simultaneous = ['08:00:00', '08:02:00', '08:04:00'].map((time, index) =>
      trip(`peak-${index}`, 'r1', [stopTime(STOP_A, 1, time), stopTime(STOP_B, 2, addMinutes(time, 40))]),
    )
    const r = route('r1', 'X-1', [...spaced, ...simultaneous])
    const sizes = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], OPTIONS)
    expect(sizes.get('X-1')?.vehicles).toBe(3)
    expect(sizes.get('X-1')?.realTripCount).toBe(8)
  })

  it('applies the floor when a route has no usable trip intervals', () => {
    const degenerate = trip('t1', 'r1', [stopTime(STOP_A, 1, '08:00:00')])
    const r = route('r1', 'X-1', [degenerate])
    const sizes = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], { ...OPTIONS, minimumPerRoute: 2 })
    expect(sizes.get('X-1')).toEqual({ routeNumber: 'X-1', vehicles: 2, realTripCount: 0 })
  })

  it('scales the computed roster and still respects the floor', () => {
    const r = route('r1', 'X-1', [
      trip('t1', 'r1', [stopTime(STOP_A, 1, '08:00:00'), stopTime(STOP_B, 2, '08:30:00')]),
      trip('t2', 'r1', [stopTime(STOP_A, 1, '08:05:00'), stopTime(STOP_B, 2, '08:35:00')]),
    ])
    const doubled = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], { ...OPTIONS, scale: 2 })
    expect(doubled.get('X-1')?.vehicles).toBe(4)
    const flooredDown = computeRouteRosterSizes(gtfsWith([r]), ['X-1'], { ...OPTIONS, scale: 0.1, minimumPerRoute: 1 })
    expect(flooredDown.get('X-1')?.vehicles).toBe(1)
  })

  it('sums two GTFS routes that share a route number (a direction-split feed row) into one roster', () => {
    const up = route('r1', 'X-1', [trip('t1', 'r1', [stopTime(STOP_A, 1, '08:00:00'), stopTime(STOP_B, 2, '08:30:00')])])
    const down = route('r2', 'X-1', [trip('t2', 'r2', [stopTime(STOP_B, 1, '08:05:00'), stopTime(STOP_A, 2, '08:35:00')])])
    const sizes = computeRouteRosterSizes(gtfsWith([up, down]), ['X-1'], OPTIONS)
    expect(sizes.get('X-1')?.realTripCount).toBe(2)
    expect(sizes.get('X-1')?.vehicles).toBe(2)
  })
})

function addMinutes(time: string, minutes: number): string {
  const [h = '0', m = '0', s = '0'] = time.split(':')
  const total = Number(h) * 60 + Number(m) + minutes
  const hh = Math.floor(total / 60)
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${s}`
}
