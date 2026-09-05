import type { GtfsStopTime, GtfsTrip } from '../geometry/loadGtfs.js'
import type { ShapeIndex } from '../geometry/shape.js'
import { drawBusSpeedKph, drawDwellSeconds, type BusMotionProfile } from './profile.js'

export interface BusCursor {
  shapeId: string
  distanceMetres: number
  directionId: 0 | 1
  dwellUntilMs: number | null
  layoverUntilMs: number | null
  nextStopIndex: number
  segment: number
  stopVisits: number
  speedKph: number
  /**
   * docs/intercity-coaches.md §3.4: "A run has no end, only a layover... There
   * is no cursor state for 'this vehicle's duty is over and it is not running
   * anything.'" This is that state. Null for the life of a looping bus, which
   * never sets it (`SimWorld.advanceBus` always flips direction on
   * `reachedTerminal` instead - see `advanceCursor`'s `CursorAdvanceResult`).
   * Set once, by `advanceOneWay` below, for a one-way run that has reached
   * its final stop: the instant it happened, in milliseconds since the
   * epoch, on the same clock every other cursor field uses. A cursor with a
   * non-null `arrivedAtMs` does not move again no matter how much more
   * elapsed time it is given - the duty is finished, not paused.
   */
  arrivedAtMs: number | null
}

export interface CursorAdvanceResult {
  readonly reachedTerminal: boolean
  readonly consumedSeconds: number
}

export function createCursor(
  trip: GtfsTrip,
  distanceMetres: number,
  profile: BusMotionProfile,
  bin: string,
  at: Date,
): BusCursor {
  return {
    shapeId: trip.shapeId,
    distanceMetres,
    directionId: trip.directionId,
    dwellUntilMs: null,
    layoverUntilMs: null,
    nextStopIndex: findNextStopIndex(trip.stops, distanceMetres),
    segment: 0,
    stopVisits: 0,
    speedKph: drawBusSpeedKph(profile, bin, 0, at),
    arrivedAtMs: null,
  }
}

export function advanceCursor(
  cursor: BusCursor,
  trip: GtfsTrip,
  shape: ShapeIndex,
  from: Date,
  elapsedSeconds: number,
  profile: BusMotionProfile,
  bin: string,
): CursorAdvanceResult {
  let remaining = Math.max(0, elapsedSeconds)
  let currentMs = from.getTime()
  const startedWith = remaining
  while (remaining > 1e-9) {
    if (cursor.dwellUntilMs !== null && cursor.dwellUntilMs > currentMs) {
      const consumed = Math.min(remaining, (cursor.dwellUntilMs - currentMs) / 1000)
      remaining -= consumed
      currentMs += consumed * 1000
      if (currentMs >= cursor.dwellUntilMs) cursor.dwellUntilMs = null
      continue
    }
    const nextStop = trip.stops[cursor.nextStopIndex]
    const targetDistance = nextStop?.stopDistanceMetres ?? shape.lengthMetres
    const metresPerSecond = cursor.speedKph / 3.6
    const distanceRemaining = Math.max(0, targetDistance - cursor.distanceMetres)
    const secondsToTarget = metresPerSecond === 0 ? Number.POSITIVE_INFINITY : distanceRemaining / metresPerSecond
    if (secondsToTarget > remaining) {
      cursor.distanceMetres += metresPerSecond * remaining
      currentMs += remaining * 1000
      remaining = 0
      break
    }
    cursor.distanceMetres = targetDistance
    remaining -= secondsToTarget
    currentMs += secondsToTarget * 1000
    if (nextStop === undefined) {
      return { reachedTerminal: true, consumedSeconds: startedWith - remaining }
    }
    cursor.nextStopIndex += 1
    cursor.stopVisits += 1
    const dwellSeconds = drawDwellSeconds(profile, bin, cursor.stopVisits)
    cursor.dwellUntilMs = currentMs + dwellSeconds * 1000
    cursor.segment += 1
    cursor.speedKph = drawBusSpeedKph(profile, bin, cursor.segment, new Date(currentMs))
  }
  return { reachedTerminal: false, consumedSeconds: startedWith }
}

export function findNextStopIndex(stops: readonly GtfsStopTime[], distanceMetres: number): number {
  const index = stops.findIndex((stop) => stop.stopDistanceMetres > distanceMetres)
  return index < 0 ? stops.length : index
}

export interface OneWayAdvanceResult {
  readonly consumedSeconds: number
  readonly arrived: boolean
}

/**
 * docs/intercity-coaches.md §3.4: a coach that reaches its terminal does not
 * turn round - it is finished. This is `advanceCursor` (unchanged; a city
 * bus's loop-forever caller, `SimWorld.advanceBus`, keeps using it directly
 * and is not touched by anything in this function) wrapped with the one
 * decision a one-way run needs and a looping one must never make: on
 * `reachedTerminal`, stop advancing rather than flip direction and dispatch
 * a new trip.
 *
 * Idempotent once arrived: a cursor with `arrivedAtMs` already set consumes
 * none of `elapsedSeconds` and reports `arrived: true` immediately, so a
 * caller that keeps ticking an arrived duty by mistake cannot make it drive
 * again.
 */
export function advanceOneWay(
  cursor: BusCursor,
  trip: GtfsTrip,
  shape: ShapeIndex,
  from: Date,
  elapsedSeconds: number,
  profile: BusMotionProfile,
  bin: string,
): OneWayAdvanceResult {
  if (cursor.arrivedAtMs !== null) return { consumedSeconds: 0, arrived: true }
  const result = advanceCursor(cursor, trip, shape, from, elapsedSeconds, profile, bin)
  if (result.reachedTerminal) {
    cursor.arrivedAtMs = from.getTime() + result.consumedSeconds * 1000
  }
  return { consumedSeconds: result.consumedSeconds, arrived: cursor.arrivedAtMs !== null }
}
