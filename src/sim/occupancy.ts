import { config } from '../config.js'
import type { OccupancyObservation, OccupancyStatus, TrackingState } from '../world/port.js'
import { rand } from './rand.js'

/**
 * How full a bus is, modelled as a consequence of the trip it is on rather
 * than a number drawn per request. The old implementation rebucketed a keyed
 * hash every five minutes: no route, no direction, no time of day, no
 * stop-level boarding, so a bus's fullness jumped arbitrarily instead of
 * filling toward a centre and emptying after it, and the top of the ladder
 * (`FULL`) was reachable only by the top few percent of the draw.
 *
 * This model instead treats load as a position on the route (SPEC 8.2 already
 * gives every bus a distance travelled), scaled by four things that a real
 * corridor's ridership actually depends on:
 *
 *   - **where** the bus is along the route, via a demand "centre" that
 *     stands in for the CBD-bound corridor most BMTC routes pass through -
 *     riders board approaching it and alight leaving it, so load rises then
 *     falls rather than being flat for the whole trip;
 *   - **when**, via a two-peak time-of-day curve (morning and evening);
 *   - **which way**, via a direction multiplier that is high for the
 *     centre-bound direction in the morning and flips in the evening, so an
 *     inbound morning bus and the same bus outbound are not equally full;
 *   - **which route and which run**, via small deterministic per-route and
 *     per-trip multipliers so the fleet is not perfectly uniform.
 *
 * The random draws below are all perturbations layered on this shape, keyed
 * through `rand` so the same vehicle at the same instant always answers the
 * same. Nothing here reads the wall clock or an unseeded source.
 */

export interface BusOccupancyProfile {
  readonly seed: number
  readonly timezone: string
  /** An ordinary BMTC bus: BS-IV/BS-VI standard floor, mixed seated/standing. */
  readonly seatedCapacity: number
  readonly standingCapacity: number
  /** A Vayu Vajra airport coach (`KIA-*` routes): all-seater, luggage racks. */
  readonly airportSeatedCapacity: number
  readonly airportStandingCapacity: number
}

export const defaultBusOccupancyProfile: BusOccupancyProfile = {
  seed: config.simSeed,
  timezone: config.simTimezone,
  seatedCapacity: config.busSeatedCapacity,
  standingCapacity: config.busStandingCapacity,
  airportSeatedCapacity: config.busAirportSeatedCapacity,
  airportStandingCapacity: config.busAirportStandingCapacity,
}

export interface OccupancyInput {
  readonly bin: string
  readonly trackingState: TrackingState
  readonly routeId: string
  /** GTFS `route_short_name`. Used only to recognise a `KIA-*` airport run. */
  readonly routeNumber: string
  readonly directionId: 0 | 1
  /**
   * Distance and route length as of the fix being served, not necessarily
   * "now" - see the note on `at` below.
   */
  readonly distanceAlongRouteMetres: number
  readonly routeLengthMetres: number
  /**
   * The instant to evaluate demand at. For `live` this is close enough to
   * "now" not to matter; for `stale` it must be the fix's `observedAt`, not
   * the serve time, so a five-minute-old load is not reported as current.
   * The caller (`SimWorld.observe`) is responsible for choosing it.
   */
  readonly at: Date
  /** Distinguishes successive laps by the same bus. Any stable per-trip value. */
  readonly tripStartedAtMs: number
  /**
   * A property of the duty being served, never of the vehicle class -
   * docs/intercity-coaches.md §7.3: "The reserved branch is a branch on the
   * duty, not on the vehicle class... `input.reservation` is a property of
   * the duty being served, so the existing regex [the vehicle-class boundary
   * test] does not fire and, more importantly, should not: reservation is the
   * correct axis and the class is not." `null` for a bus and for an
   * unreserved intercity duty (Karnataka Sarige); `{ required: true }` for a
   * reserved one (Pallakki, Airavat, ...). This is deliberately the *only*
   * fact about the duty's reservation this function is given - no manifest,
   * no seat count. §7.3 again: "The manifest is a separate object on the duty
   * and never reaches this function at all. Keeping the two apart in the type
   * system is what stops a later change from 'improving' the refusal by
   * feeding a booking count into an occupancy field." There is nowhere on
   * this type for one to arrive by accident.
   */
  readonly reservation: { readonly required: boolean } | null
}

/**
 * What `occupancyFor` decided, before it is turned into wire shape.
 *
 * `withheld` carries no number for anything to serialise - not a percentage,
 * not a status pulled from the ladder, nothing. That is deliberate and it is
 * the whole point: docs/intercity-coaches.md §7.3 requires the refusal to be
 * structural rather than a check at the response projector, and the cheapest
 * place to make a rule un-routable-around is the type system. An arm that
 * *could* carry a measured figure would be an invitation for a later change
 * to fill it in "just this once"; an arm that structurally cannot has nothing
 * to fill in. `projectOccupancy` is the one place this gets turned into (or
 * out of) `VehicleObservation.occupancy`, and every caller goes through it.
 */
export type OccupancyOutcome =
  | { readonly kind: 'modelled'; readonly observation: OccupancyObservation }
  | {
      readonly kind: 'withheld'
      /**
       * `reserved_no_onboard_count`: a reserved duty, manifest or no
       * manifest - §7.2, the rule with no exceptions.
       * `not_reporting`: the existing dark/untracked short-circuit, unified
       * under the same outcome type so a bus's `NO_DATA_AVAILABLE` and a
       * coach's silence are visibly two instances of one shape rather than
       * two unrelated mechanisms that happen to both omit a number.
       */
      readonly reason: 'reserved_no_onboard_count' | 'not_reporting'
    }

/** A whole-route demand hump is centred here; sigma controls how sharply it falls off. */
const CENTRE_SIGMA = 0.22
/** Every rider count starts from this share of design capacity, so a route never reads as literally zero. */
const BASELINE_LOAD_FRACTION = 0.03
/** Buses do get overloaded beyond their nominal design capacity; this is how far. */
const OVERCROWD_CEILING_FRACTION = 1.25
/**
 * Scales the whole time/direction/route/trip product down before it multiplies
 * the position curve. Tuned so an averagely-popular route at peak, in the
 * peak-aligned direction, right at the demand centre lands in
 * `CRUSHED_STANDING_ROOM_ONLY` rather than `FULL` - `FULL` needs an
 * above-average route, a lucky trip, and standing right at the centre, all
 * at once, which is what keeps it real rather than the common case.
 */
const DEMAND_SCALE = 0.62

export function occupancyFor(
  input: OccupancyInput,
  profile: BusOccupancyProfile = defaultBusOccupancyProfile,
): OccupancyOutcome {
  // docs/intercity-coaches.md §7.2-7.3: a reserved duty's load is somebody
  // else's fact - a manifest a booking system holds, not a headcount this
  // service could ever take. The refusal is checked first, unconditionally,
  // regardless of `trackingState`: a reserved coach that is `live` gets the
  // same refusal as one that is `dark`, because tracking has nothing to do
  // with why this is withheld. Nothing below this line runs for a reserved
  // duty - not `headcountFor`, not the demand curve, nothing - which is what
  // "before any demand-model function is called" means as a property of the
  // code rather than as a comment about it.
  if (input.reservation?.required === true) {
    return { kind: 'withheld', reason: 'reserved_no_onboard_count' }
  }
  // The honesty rule (docs/prompts/fleet-sim-02-vehicle-occupancy.md): a dark
  // or untracked vehicle gets no occupancy at all, not a zero. Not knowing
  // where a bus is and not knowing how full it is are the same ignorance.
  if (input.trackingState === 'dark' || input.trackingState === 'untracked') {
    return { kind: 'withheld', reason: 'not_reporting' }
  }
  const { headcount, seatedCapacity, designCapacity } = headcountFor(input, profile)
  const status = statusFor(headcount, seatedCapacity, designCapacity)
  const percentage = clamp(Math.round((headcount / designCapacity) * 100), 0, 100)
  return { kind: 'modelled', observation: { status, percentage } }
}

/**
 * Turns an `OccupancyOutcome` into the wire shape, or into nothing at all.
 *
 * This is the single place a caller reaches to fill in
 * `VehicleObservation.occupancy`, and it is deliberately the only place: a
 * reserved duty's `withheld` never becomes `NO_DATA_AVAILABLE` here, it
 * becomes `undefined`, and `undefined` is what makes the property vanish from
 * the response rather than survive as a key with an honest-looking value
 * (docs/intercity-coaches.md §7.2's "omission, not `NO_DATA_AVAILABLE`").
 * `not_reporting` still becomes `NO_DATA_AVAILABLE`, unchanged from the
 * bus/metro behaviour this replaces, so every existing golden stays
 * byte-identical.
 */
export function projectOccupancy(outcome: OccupancyOutcome): OccupancyObservation | undefined {
  if (outcome.kind === 'modelled') return outcome.observation
  if (outcome.reason === 'not_reporting') return { status: 'NO_DATA_AVAILABLE' }
  return undefined
}

function headcountFor(
  input: OccupancyInput,
  profile: BusOccupancyProfile,
): { headcount: number; seatedCapacity: number; designCapacity: number } {
  const isAirport = input.routeNumber.startsWith('KIA-')
  const seatedCapacity = isAirport ? profile.airportSeatedCapacity : profile.seatedCapacity
  const standingCapacity = isAirport ? profile.airportStandingCapacity : profile.standingCapacity
  const designCapacity = seatedCapacity + standingCapacity

  const minutes = localMinutes(input.at, profile.timezone)
  const fraction = input.routeLengthMetres > 0
    ? clamp(input.distanceAlongRouteMetres / input.routeLengthMetres, 0, 1)
    : 0
  const centre = centreFraction(profile.seed, input.routeId, input.directionId)
  const combined =
    DEMAND_SCALE *
    timeOfDayFactor(minutes) *
    directionFactor(minutes, input.directionId) *
    routeBaseFactor(profile.seed, input.routeId) *
    tripJitterFactor(profile.seed, input.bin, input.tripStartedAtMs)
  const loadFraction = clamp(
    BASELINE_LOAD_FRACTION + gaussian(fraction, centre, CENTRE_SIGMA) * combined,
    0,
    OVERCROWD_CEILING_FRACTION,
  )
  return { headcount: Math.round(loadFraction * designCapacity), seatedCapacity, designCapacity }
}

/**
 * `STANDING_ROOM_ONLY` is defined by the seated/standing boundary, not
 * derived from the percentage - crossing `seatedCapacity` is what it means
 * for every seat to be taken, whatever fraction of design capacity that is
 * for this vehicle's class.
 */
function statusFor(headcount: number, seatedCapacity: number, designCapacity: number): OccupancyStatus {
  if (headcount <= designCapacity * 0.05) return 'EMPTY'
  if (headcount <= seatedCapacity * 0.6) return 'MANY_SEATS_AVAILABLE'
  if (headcount <= seatedCapacity) return 'FEW_SEATS_AVAILABLE'
  if (headcount <= designCapacity * 0.92) return 'STANDING_ROOM_ONLY'
  if (headcount < designCapacity * 1.05) return 'CRUSHED_STANDING_ROOM_ONLY'
  return 'FULL'
}

/**
 * Two peaks (morning, evening) plus a gentle midday shoulder and a low
 * overnight baseline. Not a real APC-derived curve - see SPEC.md section 13 -
 * but shaped like Bengaluru service actually runs: near-empty at 23:00,
 * moderate at 14:00, close to the ceiling either side of 08:30 and 18:30.
 */
function timeOfDayFactor(minutes: number): number {
  const baseline = 0.06
  const morning = 0.85 * gaussian(minutes, 8 * 60 + 15, 65)
  const evening = 0.9 * gaussian(minutes, 18 * 60 + 15, 75)
  const midday = 0.22 * gaussian(minutes, 13 * 60, 180)
  return clamp(baseline + morning + evening + midday, 0.04, 1)
}

/**
 * `directionId === 0` is treated as the centre-bound direction. Boosted in
 * the morning and damped in the evening; direction 1 is the mirror image, so
 * a morning-inbound bus and the same bus outbound at the same hour diverge
 * rather than sharing one number.
 */
function directionFactor(minutes: number, directionId: 0 | 1): number {
  const morningWeight = gaussian(minutes, 8 * 60 + 15, 90)
  const eveningWeight = gaussian(minutes, 18 * 60 + 15, 90)
  const inbound = 1 + 0.55 * morningWeight - 0.45 * eveningWeight
  const outbound = 1 + 0.55 * eveningWeight - 0.45 * morningWeight
  return clamp(directionId === 0 ? inbound : outbound, 0.35, 1.6)
}

/** A per-route popularity multiplier, stable for the life of the route. */
function routeBaseFactor(seed: number, routeId: string): number {
  return 0.8 + 0.5 * rand(seed, routeId, 'occupancy_route_base', 0)
}

/**
 * A per-lap perturbation. Not built here, but this is the seam a future ONDC
 * boarding-sale signal (docs/prompts/fleet-sim-02-vehicle-occupancy.md,
 * "The ONDC connection") would join at: a perturbation on this demand model,
 * never the source of the number, and this simulator has to work with it
 * switched off - which today it always is.
 */
function tripJitterFactor(seed: number, bin: string, tripStartedAtMs: number): number {
  return 0.85 + 0.3 * rand(seed, bin, 'occupancy_trip_jitter', tripStartedAtMs)
}

/**
 * Where the demand hump sits, as a fraction of route length. Direction 1
 * mirrors direction 0's fraction because its shape is (approximately) the
 * same corridor run the other way, so the hump lands on the same geography
 * rather than at the mirrored geography read against the wrong direction.
 */
function centreFraction(seed: number, routeId: string, directionId: 0 | 1): number {
  const base = 0.35 + 0.3 * rand(seed, routeId, 'occupancy_centre', 0)
  return directionId === 0 ? base : 1 - base
}

function gaussian(x: number, mean: number, standardDeviation: number): number {
  const z = (x - mean) / standardDeviation
  return Math.exp(-0.5 * z * z)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}
