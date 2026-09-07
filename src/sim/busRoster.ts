import type { GtfsRoute, GtfsTrip, LoadedGtfs } from '../geometry/loadGtfs.js'
import { secondsOfDay } from './localTime.js'

/**
 * How many buses a route actually needs, read off its own timetable rather
 * than handed down as one flat number for every route.
 *
 * The bundled fleet used to dispatch a fixed `BUSES_PER_ROUTE` (six) onto
 * every route regardless of how busy that route's real schedule is - a
 * once-a-day single-trip branch pattern and an all-day trunk route with 250
 * trips got the same six buses. That is why an owner riding a real corridor
 * kept finding "no vehicle behind this one": the fleet's shape had nothing to
 * do with the route's actual service density.
 *
 * This module answers a narrower, honest question instead: given a route's
 * real departure and arrival times for every trip in the bundled GTFS, what
 * is the smallest number of vehicles that could run that exact timetable
 * back to back, allowing a fixed turnaround at each terminal? That number is
 * a fact about the schedule, not a measurement of BMTC's real depot roster
 * (nobody publishes how many physical buses a route runs), so it is
 * `secondary_unverified` in the sense docs/intercity-coaches.md's confidence
 * vocabulary uses that term - derived from real, verified trip times, but
 * the vehicle count itself is inferred rather than observed. What it is not
 * is *arbitrary*: a route with one trip a day gets one vehicle, and a route
 * with a bus every four minutes gets a roster sized to actually cover that.
 */

export interface BusRosterOptions {
  /**
   * Minimum turnaround at a terminal before the same physical vehicle could
   * plausibly be assigned the next overlapping trip. Reuses
   * `config.busTerminalLayoverSeconds` - the same "a bus doesn't instantly
   * reappear at the other end" assumption the endless-loop dispatcher already
   * bakes in for a single route, just applied here across a whole day's trips
   * instead of one direction flip.
   */
  readonly turnaroundSeconds: number
  /**
   * A route with real trips must still get at least this many vehicles, even
   * one whose whole day is a single trip - "tracked continuously" means the
   * route is never simply absent from the fleet.
   */
  readonly minimumPerRoute: number
  /**
   * `BUS_ROSTER_SCALE`: a single dial on the whole computed fleet, for the
   * demo-tuning and tick-cost cases described in SPEC.md and the September
   * 2026 coverage-expansion brief - turn the schedule-derived roster down
   * without abandoning schedule-derived sizing entirely, or up if a reviewer
   * wants denser tracking than the bare minimum-vehicles answer gives.
   * Applied after the minimum-vehicles computation and before the
   * per-route floor, so `minimumPerRoute` always wins over a scale small
   * enough to round a real route down to zero.
   */
  readonly scale: number
}

interface TripInterval {
  readonly startSeconds: number
  readonly endSeconds: number
}

/**
 * One route's minimum-vehicle roster size, and the real trip count it was
 * derived from - carried together so a caller (and this project's own
 * startup log) can tell "one trip a day" apart from "no real schedule data
 * at all for this route number", which would otherwise both read as `size:
 * 1` after the floor is applied.
 */
export interface RouteRosterSize {
  readonly routeNumber: string
  readonly vehicles: number
  readonly realTripCount: number
}

/**
 * Computes a roster size for every requested route number, from the trips
 * `gtfs` actually loaded for it. A route number absent from `gtfs.routes` (it
 * was requested but the GTFS filter upstream did not find it) is not this
 * function's problem to raise - `loadGtfs` already throws on a genuinely
 * missing route before this ever runs - so every entry here corresponds to a
 * route that exists, though possibly with zero usable trips (§ the
 * `realTripCount: 0` case below), which still needs its floor.
 */
export function computeRouteRosterSizes(
  gtfs: LoadedGtfs,
  routeNumbers: readonly string[],
  options: BusRosterOptions,
): ReadonlyMap<string, RouteRosterSize> {
  const routesByNumber = new Map<string, GtfsRoute[]>()
  for (const route of gtfs.routes.values()) {
    const bucket = routesByNumber.get(route.number) ?? []
    bucket.push(route)
    routesByNumber.set(route.number, bucket)
  }

  const sizes = new Map<string, RouteRosterSize>()
  for (const routeNumber of routeNumbers) {
    const routes = routesByNumber.get(routeNumber) ?? []
    const intervals = routes
      .flatMap((route) => route.trips)
      .map(tripInterval)
      .filter((interval): interval is TripInterval => interval !== null)
    const minimumVehicles = peakConcurrency(intervals, options.turnaroundSeconds)
    const vehicles = Math.max(options.minimumPerRoute, Math.round(minimumVehicles * options.scale))
    sizes.set(routeNumber, { routeNumber, vehicles, realTripCount: intervals.length })
  }
  return sizes
}

/**
 * A trip's real service window, in GTFS seconds-from-midnight - which, per
 * `secondsOfDay`'s own contract, is exactly the raw arithmetic parse with no
 * modulo, so a trip that departs at `23:50:00` and arrives at `00:15:00` the
 * next service day already reads as ending at `24:15:00`, later than every
 * same-day trip, rather than wrapping back to look earlier than its own
 * departure.
 *
 * `null` for a trip with fewer than two stop times: there is no real
 * departure-to-arrival span to measure, and the handful of these in the
 * bundled feed (a community-maintained feed's own data-quality gaps, not
 * anything this project generated) should not silently inflate a route's
 * roster with a zero-length phantom trip.
 */
function tripInterval(trip: GtfsTrip): TripInterval | null {
  const first = trip.stops[0]
  const last = trip.stops.at(-1)
  if (first === undefined || last === undefined || trip.stops.length < 2) return null
  return { startSeconds: secondsOfDay(first.departureTime), endSeconds: secondsOfDay(last.arrivalTime) }
}

/**
 * The classic "minimum meeting rooms" sweep, read as "minimum buses": the
 * peak number of trips simultaneously in progress (each stretched by
 * `bufferSeconds` past its real arrival, standing in for the turnaround) is
 * the fewest vehicles that could run every trip in `intervals` without one
 * vehicle needing to be in two places at once.
 *
 * An end-of-turnaround event is ordered before a start event at the exact
 * same instant, deliberately: a vehicle freed at `T` by `bufferSeconds`'
 * worth of turnaround is available to *this* `T` departure, not merely to
 * the one after it. Getting this ordering backwards would overcount the
 * roster by one vehicle on every route where a trip's turnaround lands
 * exactly on the next trip's departure - not a rounding error a reviewer
 * would ever notice was wrong, which is exactly why it is spelled out here.
 */
function peakConcurrency(intervals: readonly TripInterval[], bufferSeconds: number): number {
  if (intervals.length === 0) return 0
  const events: { readonly time: number; readonly delta: 1 | -1 }[] = []
  for (const interval of intervals) {
    events.push({ time: interval.startSeconds, delta: 1 })
    events.push({ time: interval.endSeconds + bufferSeconds, delta: -1 })
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta)
  let concurrent = 0
  let peak = 0
  for (const event of events) {
    concurrent += event.delta
    if (concurrent > peak) peak = concurrent
  }
  return peak
}
