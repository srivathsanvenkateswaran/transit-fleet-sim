import type { GtfsRoute, GtfsTrip, LoadedGtfs } from '../geometry/loadGtfs.js'
import type { FleetMember } from '../world/port.js'
import { createCursor, type BusCursor } from './cursor.js'
import type { BusMotionProfile } from './profile.js'

export interface ActiveBus {
  readonly member: FleetMember
  readonly route: GtfsRoute
  trip: GtfsTrip
  cursor: BusCursor
  tripStartedAt: Date
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
