import { describe, expect, it } from 'vitest'
import { generateFleet } from '../../src/fleet/generate.js'
import type { GtfsRoute, GtfsStop, GtfsStopTime, GtfsTrip } from '../../src/geometry/loadGtfs.js'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'
import { dispatchInitialFleet, representativeTrip } from '../../src/sim/dispatch.js'
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

  it('dispatches vehicles onto every bundled KIA airport route', async () => {
    const gtfs = await loadGtfs()
    const kiaRoutes = ['KIA-4', 'KIA-8', 'KIA-9', 'KIA-10', 'KIA-15']
    const fleet = generateFleet({ seed: 1, routes: kiaRoutes, busesPerRoute: 2 })
    const active = dispatchInitialFleet(
      fleet,
      gtfs,
      defaultBusMotionProfile,
      new Date('2026-08-20T03:00:00Z'),
    )
    expect(active).toHaveLength(kiaRoutes.length * 2)
    for (const routeNumber of kiaRoutes) {
      const busesOnRoute = active.filter((bus) => bus.route.number === routeNumber)
      expect(busesOnRoute).toHaveLength(2)
      for (const bus of busesOnRoute) {
        expect(bus.member.class).toBe('bus')
        expect(bus.trip.routeId).toBe(bus.route.id)
      }
    }
  })

  it('picks the fullest-formed trip per direction, not merely the first one listed', () => {
    const stop: GtfsStop = { id: 's', name: 'S', nameLocal: null, lat: 12.9, lon: 77.6 }
    const stopTime = (sequence: number): GtfsStopTime => ({
      stop,
      sequence,
      arrivalTime: '08:00:00',
      departureTime: '08:00:00',
      stopDistanceMetres: sequence * 1000,
    })
    // A degenerate one-stop trip (the September 2026 expansion's known
    // community-feed data-quality gap - well under 1% of trips in the
    // bundled set, but real) listed first, and a well-formed five-stop trip
    // listed second - `route.trips[0]` would have picked the degenerate one.
    const degenerate: GtfsTrip = {
      id: 'degenerate',
      routeId: 'r1',
      serviceId: 'weekday',
      shapeId: 'shape',
      directionId: 0,
      headsign: 'Degenerate',
      stops: [stopTime(1)],
    }
    const wellFormed: GtfsTrip = {
      id: 'well-formed',
      routeId: 'r1',
      serviceId: 'weekday',
      shapeId: 'shape',
      directionId: 0,
      headsign: 'Well formed',
      stops: [stopTime(1), stopTime(2), stopTime(3), stopTime(4), stopTime(5)],
    }
    const route: GtfsRoute = { id: 'r1', number: 'X-1', name: 'X-1', trips: [degenerate, wellFormed] }
    expect(representativeTrip(route, 0).id).toBe('well-formed')
  })
})
