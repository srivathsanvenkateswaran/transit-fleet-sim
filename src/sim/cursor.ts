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
