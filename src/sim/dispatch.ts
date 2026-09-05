import type { GtfsRoute, GtfsTrip, LoadedGtfs } from '../geometry/loadGtfs.js'
import type { FleetMember } from '../world/port.js'
import { createCursor, type BusCursor } from './cursor.js'
import type { BusMotionProfile } from './profile.js'
import { serviceDate } from './serviceDate.js'

export interface ActiveBus {
  readonly member: FleetMember
  readonly route: GtfsRoute
  trip: GtfsTrip
  cursor: BusCursor
  tripStartedAt: Date
  /**
   * docs/intercity-coaches.md §3.2: a GTFS service date is not the calendar
   * date of a start instant - a trip starting at 00:30 can belong to the
   * *previous* service date - so it must be an explicit field set once, at
   * the moment a trip genuinely starts, and carried from there rather than
   * recomputed from `tripStartedAt` wherever it is needed. For today's bus
   * model, where every trip starts well inside daytime service and no roster
   * disagrees with the naive calendar date, computing it at dispatch (here)
   * and at each turnaround (`SimWorld.advanceBus`) produces the same string
   * a fresh `serviceDate(tripStartedAt, ...)` call always did - this is a
   * wiring fix, not a behaviour change, and `tests/sim/world.test.ts`'s
   * existing goldens are what prove that. A future roster-authored duty
   * assigns this field from its own data instead of deriving it at all.
   */
  serviceDate: string
}

export function dispatchInitialFleet(
  members: readonly FleetMember[],
  gtfs: LoadedGtfs,
  profile: BusMotionProfile,
  at: Date,
): readonly ActiveBus[] {
  const routeByNumber = new Map([...gtfs.routes.values()].map((route) => [route.number, route]))
  const membersByRoute = new Map<string, FleetMember[]>()
  for (const member of members) {
    const values = membersByRoute.get(member.homeRouteNumber) ?? []
    values.push(member)
    membersByRoute.set(member.homeRouteNumber, values)
  }
  const active: ActiveBus[] = []
  for (const [routeNumber, routeMembers] of membersByRoute) {
    const route = routeByNumber.get(routeNumber)
    if (route === undefined) throw new Error(`Fleet references missing route ${routeNumber}`)
    for (let index = 0; index < routeMembers.length; index += 1) {
      const member = routeMembers[index]
      if (member === undefined) continue
      const half = index % 2
      const directionId: 0 | 1 = half === 0 ? 0 : 1
      const trip = representativeTrip(route, directionId)
      const shape = gtfs.shapes.get(trip.shapeId)
      if (shape === undefined) throw new Error(`Trip ${trip.id} references missing shape ${trip.shapeId}`)
      const slot = Math.floor(index / 2)
      const slotsInDirection = Math.ceil((routeMembers.length - half) / 2)
      const distance = (slot / Math.max(1, slotsInDirection)) * shape.lengthMetres
      active.push({
        member,
        route,
        trip,
        cursor: createCursor(trip, distance, profile, member.bin, at),
        tripStartedAt: at,
        serviceDate: serviceDate(at, profile.timezone),
      })
    }
  }
  return active
}

export function representativeTrip(route: GtfsRoute, directionId: 0 | 1): GtfsTrip {
  const exact = route.trips.find((trip) => trip.directionId === directionId)
  const fallback = route.trips[0]
  if (exact === undefined && fallback === undefined) throw new Error(`Route ${route.number} has no trips`)
  return exact ?? fallback!
}
