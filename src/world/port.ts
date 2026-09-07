/**
 * The seam between the HTTP layer and the simulated world.
 *
 * This file is a contract and nothing else: no imports, no behaviour, no
 * dependency on `src/sim` or `src/geometry`. The HTTP layer (`src/api`) is
 * written against `WorldPort` and never against a concrete simulator, so the
 * endpoints can be built and tested before the simulator exists and the
 * simulator can be replaced without touching a route handler.
 *
 * The shapes below are derived directly from the response bodies in SPEC
 * sections 6.2 (`/fleet/resolve`) and 7.1 (`/fleet/vehicle/{bin}/position`),
 * with the identity fields removed. Identity - the BIN, the plate and its
 * history, the hub - belongs to `src/fleet/registry.ts` and the world is never
 * asked about it. The world is asked exactly one question:
 *
 *     given a BIN, what is this vehicle doing (duty) and where is it
 *     (tracking), and what does it reach next (predictions)?
 *
 * The two state machines stay separate here, as they do everywhere else. SPEC
 * section 5: `duty.status` and `tracking.state` are independent, all sixteen
 * combinations are reachable, and neither may be derived from the other. A
 * `DutyObservation` and a `TrackingObservation` are returned side by side and
 * never merged.
 */

/**
 * SPEC 3.3. One vehicle model, two profiles - now three.
 * `'coach'` is docs/intercity-coaches.md §2.2's addition, gated entirely
 * behind `INTERCITY_CORRIDORS` (unset by default, §14.1): nothing in `src/`
 * outside `sim/profile.ts`, `sim/device.ts` and `sim/duty.ts` may branch on
 * this value (tests/contract/sourceBoundaries.test.ts), and the existing bus
 * and metro paths never construct one.
 */
export type VehicleClass = 'bus' | 'metro' | 'coach'

/* ------------------------------------------------------------------ *
 * Duty: what is this vehicle doing?  (SPEC 5.1)
 * ------------------------------------------------------------------ */

export type DutyStatus = 'confirmed' | 'inferred' | 'unknown' | 'out_of_service'

/** SPEC 6.2. `roster` for confirmed, `position_match` for inferred, `none` otherwise. */
export type DutySource = 'roster' | 'position_match' | 'none'

/** SPEC 6.2. Non-null whenever `status` is `unknown` or `out_of_service`. */
export type DutyReason =
  | 'ambiguous_trip_match'
  | 'off_pattern'
  | 'roster_swapped'
  | 'deadheading'
  | 'on_break'
  | 'withdrawn'

/** A GTFS route, as the rider and the feed see it. SPEC 6.2. */
export interface RouteRef {
  /** GTFS `route_id`. */
  readonly id: string
  /** GTFS `route_short_name`. The rider-facing one, painted on the board. */
  readonly number: string
  /** GTFS `route_long_name`. */
  readonly name: string
  /** Kannada, when the source feed carries a translation. Null otherwise. */
  readonly nameLocal: string | null
}

/**
 * A GTFS trip. `startTime` is a noon-relative GTFS time and may exceed
 * `24:00:00`; `startDate` is a GTFS *service* date, not a calendar date.
 * `startedAt` exists so no consumer has to implement either rule. SPEC 6.2.
 */
export interface TripRef {
  readonly id: string
  /** GTFS `HH:MM:SS`, may exceed 24 hours. */
  readonly startTime: string
  /** GTFS `YYYYMMDD` service date. */
  readonly startDate: string
  /** RFC 3339 instant. Unambiguous. */
  readonly startedAt: string
  /** docs/intercity-coaches.md §10.1. Present for a coach, and it crosses midnight. */
  readonly scheduledEndAt?: string
}

/**
 * docs/intercity-coaches.md §10.1: "A corridor is not a GTFS route: it has no
 * `route_short_name` a rider reads off a destination board, and inventing one
 * would put a fabricated route number on a screen." `duty.corridor` and
 * `duty.route` are both present on a coach's body and exactly one is non-null,
 * so a consumer that only understands buses reads `route: null` and degrades
 * to what it can support instead of rendering `BNG-HSP` where `500-D` goes.
 */
export interface CorridorRef {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
}

/**
 * §7.5: what is published, and why it can never be an occupancy. `covers` is
 * the load-bearing field and it does not go away when the data gets better:
 * booked is not boarded, and this network is one sales channel among several,
 * so the count is structurally a lower bound on sales and will still be one
 * when the BPP is real.
 *
 * Note what is absent and stays absent: the `held` and `simulated` counts the
 * push carries. §7.4 accepts both at the door, records both, and publishes
 * neither, because republishing the provider's own seeded fill would give a
 * fabrication a second source and make it look corroborated.
 */
export interface ManifestRef {
  readonly seatsBooked: number
  readonly seatsTotal: number
  readonly asOf: string
  readonly ageSeconds: number
  readonly source: 'bpp'
  readonly covers: 'bookings_through_this_network_only'
}

export interface ReservationRef {
  readonly required: boolean
  /** Absent when no manifest is held, or when the held one has expired. §7.6. */
  readonly manifest?: ManifestRef
}

/** §8.2. Every entry is an observation the service already published at the moment it happened. */
export interface ProgressLogEntry {
  readonly at: string
  readonly event: 'departed' | 'halt_began' | 'halt_ended' | 'went_dark' | 'recovered' | 'arrived'
  readonly stop?: string
  readonly cause?: string
  readonly gapMetres?: number
}

/**
 * A candidate duty when the matcher could not choose. SPEC 6.2 and 8.7: the
 * confidences deliberately do not sum to 1, because a real matcher's scores do
 * not either. The API caps the list at three and sorts by confidence
 * descending; the world may return them in any order.
 */
export interface DutyAlternative {
  readonly route: RouteRef
  readonly headsign: string | null
  readonly directionId: number | null
  readonly confidence: number
}

export interface DutyObservation {
  readonly status: DutyStatus
  /** In [0, 1], non-null if and only if `status` is `inferred`. SPEC 8.7. */
  readonly confidence: number | null
  /** Null when `status` is `unknown` or `out_of_service`. SPEC 6.2. */
  readonly route: RouteRef | null
  readonly headsign: string | null
  /** GTFS `direction_id`. Null when there is no duty. */
  readonly directionId: number | null
  /** Null when `status` is `unknown` or `out_of_service`. */
  readonly trip: TripRef | null
  /** RFC 3339 instant this duty was assigned. Updated by a mid-day swap. */
  readonly since: string | null
  readonly source: DutySource
  /** Possibly non-empty only when `status` is `unknown`. */
  readonly alternatives: readonly DutyAlternative[]
  /** Non-null whenever `status` is `unknown` or `out_of_service`. */
  readonly reason: DutyReason | null
  /**
   * docs/intercity-coaches.md §10.1. All four are additive and absent on a
   * bus, so an existing consumer's parsed body is unchanged (§14.1/§14.3).
   * `corridor` replaces `route` for a coach and never joins it: criterion 94
   * requires exactly one of the two to be non-null on a `200`.
   */
  readonly corridor?: CorridorRef | null
  /** §3.2: explicit, carried from the roster, never derived from an instant. */
  readonly serviceDate?: string
  readonly reservation?: ReservationRef | null
  readonly progressLog?: readonly ProgressLogEntry[]
  /** The operator's own run code - the join key the BPP holds. §7.4. */
  readonly service?: { readonly id: string; readonly number: string; readonly headsign: string } | null
}

/* ------------------------------------------------------------------ *
 * Tracking: where is it?  (SPEC 5.2)
 * ------------------------------------------------------------------ */

export type TrackingState = 'live' | 'stale' | 'dark' | 'untracked'

/** SPEC 6.2. Non-null whenever `state` is not `live`. */
export type TrackingReason =
  | 'fix_ageing'
  | 'no_fix_since'
  | 'device_offline'
  | 'no_device_fitted'

/** SPEC 8.6. A bus fix comes from a satellite, a train from a signalling system. */
export type TrackingSource = 'simulated_gnss' | 'simulated_signalling'

export interface Position {
  readonly lat: number
  readonly lon: number
  /** Degrees clockwise from true north. */
  readonly bearing: number
  readonly speedKph: number
  readonly accuracyMetres: number
}

export interface StopRef {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
  /** GTFS `stop_sequence` within the trip. */
  readonly sequence: number
}

/** GTFS-Realtime `VehicleStopStatus`. */
export type VehicleStopStatus = 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO'

/**
 * docs/intercity-coaches.md §4.1: a corridor's stop list is not homogeneous,
 * and a consumer seeing a vehicle stationary for twenty-five minutes at 02:00
 * has no way to distinguish a scheduled halt from a breakdown. The service
 * already knows which one it is, so the dwell says so.
 */
export type DwellKind = 'boarding' | 'stand' | 'meal_halt' | 'crew_change' | 'terminal'

export interface Dwell {
  readonly kind: DwellKind
  readonly stop: { readonly id: string; readonly name: string }
  readonly startedAt: string
  readonly scheduledSeconds: number
  readonly endsAt: string
  /**
   * §4.2: never zero and never omitted. A halt is discretionary - the driver
   * leaves when the last passenger is back on the coach - and that is the
   * single largest source of variance on the whole run. A halt end with no
   * band would be the one certain number in a model that has none.
   */
  readonly endsAtUncertaintySeconds: number
}

export interface Progress {
  readonly nextStop: StopRef | null
  readonly currentStatus: VehicleStopStatus
  readonly distanceAlongRouteMetres: number
  readonly routeLengthMetres: number
  /**
   * §4.2: present only while stopped, null while moving. A halt never
   * produces a `tracking.reason` - a halted coach with a working device is
   * `live`, and the two facts are orthogonal in exactly the way `duty` and
   * `tracking` are.
   */
  readonly dwell?: Dwell | null
}

/**
 * §10.2: "`deadZone` being non-null is a stronger statement than `reason:
 * no_fix_since`... A dark city bus could be anywhere; a dark coach is inside
 * a known interval of a corridor it cannot leave." It is authored geometry,
 * not a position, and the last known `position` beside it keeps its true age.
 */
export interface DeadZoneRef {
  readonly corridorId: string
  readonly fromMetres: number
  readonly toMetres: number
  readonly enteredAt: string
  readonly expectedExitAt: string
  readonly expectedExitUncertaintySeconds: number
}

/**
 * §6.4: over a 40-minute dead zone the coach has moved 45 km, and the jump is
 * 45 km. Both fixes were real observations the service already made; this
 * object publishes them together so a consumer can draw the gap as a gap
 * rather than animating a teleport across open country.
 */
export interface Recovery {
  readonly fromPosition: { readonly lat: number; readonly lon: number }
  readonly fromObservedAt: string
  readonly gapSeconds: number
  readonly gapMetres: number
  /** `dead_zone` only when the dark period began and ended inside an authored zone. */
  readonly cause: 'dead_zone' | 'device_offline' | 'unknown'
}

/**
 * Where the vehicle was when it last said so.
 *
 * `observedAt` is when the fix was TAKEN. The API supplies `servedAt` and
 * derives `fixAgeSeconds` as their difference, so that acceptance criterion 23
 * (`fixAgeSeconds == servedAt - observedAt`, to the second, on every response)
 * holds by construction rather than by agreement between two modules. The world
 * must therefore never report a `state` computed against a different instant
 * than the `at` it was called with.
 *
 * `position` is non-null in `live`, `stale` and `dark`, and null only in
 * `untracked`. In `dark` it is the last known fix, however old. The world must
 * not extrapolate a dark position forward and neither may a consumer. SPEC 6.2.
 */
export interface TrackingObservation {
  readonly state: TrackingState
  /** RFC 3339. Null only when `state` is `untracked`. */
  readonly observedAt: string | null
  /** Null only when `state` is `untracked`. SPEC 6.2. */
  readonly position: Position | null
  /** Null when there is no position, or no duty to measure progress against. */
  readonly progress: Progress | null
  readonly source: TrackingSource
  /** Non-null whenever `state` is not `live`. */
  readonly reason: TrackingReason | null
  /**
   * True for one fix interval after a store-and-forward device reconnects and
   * the position jumps to where the vehicle actually is now. SPEC 8.5.
   */
  readonly recoveredFromDropout: boolean
  /**
   * docs/intercity-coaches.md §10.2. Both are additive and absent-by-default,
   * so an existing parser is unaffected: a bus never carries either.
   */
  readonly deadZone?: DeadZoneRef | null
  readonly recovery?: Recovery | null
}

/* ------------------------------------------------------------------ *
 * The observation, and the port
 * ------------------------------------------------------------------ */

/**
 * Everything the HTTP layer needs from the world about one vehicle at one
 * instant. Note what is absent: no plate, no hub, no BIN check character. The
 * registry owns identity and the world owns behaviour, and neither reaches
 * into the other.
 */
export interface VehicleObservation {
  /** Canonical hyphenated BIN, echoed back so a caller can assert on it. */
  readonly bin: string
  readonly class: VehicleClass
  readonly duty: DutyObservation
  readonly tracking: TrackingObservation
  readonly occupancy?: OccupancyObservation
  /**
   * True when a scenario override is currently forcing this vehicle's duty or
   * tracking. Surfaces as `meta.overridden` so nobody debugs a forced state for
   * twenty minutes. SPEC 7.5.
   */
  readonly overridden: boolean
}

export type OccupancyStatus = 'EMPTY' | 'MANY_SEATS_AVAILABLE' | 'FEW_SEATS_AVAILABLE' | 'STANDING_ROOM_ONLY' | 'CRUSHED_STANDING_ROOM_ONLY' | 'FULL' | 'NOT_ACCEPTING_PASSENGERS' | 'NO_DATA_AVAILABLE'
export interface OccupancyObservation { readonly status: OccupancyStatus; readonly percentage?: number }

/** One predicted stop arrival, with its band. SPEC 7.1. */
export interface StopPrediction {
  readonly stop: StopRef
  readonly seconds: number
  /** Never omitted and never zero. SPEC decision 6, criterion 35. */
  readonly uncertaintySeconds: number
}

/**
 * One row of a `TripUpdate`. `seconds` and `uncertaintySeconds` are both null
 * exactly when the stop is `NO_DATA` - the two travel together because a
 * prediction with no band and a band with no prediction are each a bug.
 */
export interface ScheduleUpdate {
  readonly stop: StopRef
  readonly seconds: number | null
  readonly uncertaintySeconds: number | null
}

export interface MetroArrivalsQuery {
  readonly stationId: string
  readonly towardsId: string | null
  readonly lineId: string | null
  readonly limit: number
}

export interface MetroArrivalsResult {
  readonly state: 'open' | 'closed' | 'no_arrivals' | 'not_simulated'
  readonly body: unknown
}

/** What `/readyz` needs to decide whether the world is actually turning. SPEC 7.4. */
export interface WorldStatus {
  readonly geometryLoaded: boolean
  readonly routes: number
  readonly metroLines: number
  readonly vehicles: number
  /** RFC 3339 instant of the last completed tick, or null if none has run. */
  readonly lastTickAt: string | null
  /** How far the last tick ran behind its schedule. */
  readonly tickLagMs: number
  readonly seed: number
  /**
   * docs/intercity-coaches.md §10.7/§14.1: present only when
   * `INTERCITY_CORRIDORS` is set - omitted entirely otherwise, so an existing
   * consumer's parsed `/readyz` body is unaffected by a deployment that never
   * turns coaches on.
   */
  readonly corridors?: number
  /** §10.7: duties in the roster window. Present with `corridors`. */
  readonly coachesRostered?: number
  /** §10.7: in flight right now - the `#active` set `tickAt` iterates. */
  readonly coachesActive?: number
  readonly rosterWindow?: { readonly from: string; readonly to: string }
  /**
   * §10.7: "`503` conditions gain one: the roster window does not contain
   * today." A process whose roster ran out yesterday answers every duty
   * lookup with `outside_roster_window` while `/readyz` says ready, and that
   * is exactly the silent-failure shape `/readyz` exists to catch. False (or
   * absent, when coaches are off) means the probe has nothing to complain
   * about.
   */
  readonly rosterWindowStale?: boolean
}

/**
 * One vehicle the world is asked to simulate.
 *
 * The registry generates identity (`src/fleet/generate.ts`) and hands the world
 * the resulting roll call. `homeRouteNumber` is a GTFS `route_short_name` from
 * `BUS_ROUTES` (or a metro line id); the world resolves it against the loaded
 * geometry and dispatches the vehicle onto that route's blocks. Passing the
 * short name rather than a `route_id` keeps `generate.ts` free of any
 * dependency on geometry, which is what lets identity be generated before the
 * feed is parsed.
 */
export interface FleetMember {
  readonly bin: string
  readonly class: VehicleClass
  readonly homeRouteNumber: string
  /**
   * docs/intercity-coaches.md §1.2/§2.2. Carried as plain strings rather than
   * the registry's own unions so this file keeps its no-imports rule: the
   * world is handed the two identity facts a coach roster needs to pick a
   * vehicle for a duty, and validates them against the loaded class table
   * rather than against a type it would have to import.
   */
  readonly corporation?: string | null
  readonly serviceClass?: string | null
}

/* ------------------------------------------------------------------ *
 * The intercity surfaces  (docs/intercity-coaches.md §10.3-§10.5)
 * ------------------------------------------------------------------ */

/** §7.4's push, as it arrives at the door, before any validation. */
export interface ManifestPush {
  readonly serviceId: string
  readonly travelDate: string
  readonly seats: {
    readonly total: number
    readonly booked: number
    readonly held: number
    readonly simulated: number
  }
  readonly asOf: string
  readonly ttlSeconds: number
}

export interface IntercityResult {
  readonly status: number
  readonly body: unknown
}

/**
 * Everything the HTTP layer needs from the coach half of the world.
 *
 * Separate from `WorldPort` on purpose: §14.1 makes coaches off by default,
 * and a deployment with `INTERCITY_CORRIDORS` unset simply has no
 * `IntercityPort` to hand the server, so `/fleet/duty`, `/fleet/corridors`
 * and `/fleet/manifest` return the same ordinary `404` as any unknown path.
 * That is the same increment boundary this repository already draws around
 * `/fleet/routes` and `/admin/scenario`, and it is what makes "ship it off,
 * let the consuming app opt in" possible without a feature flag inside every
 * handler.
 */
export interface IntercityPort {
  /** §10.3, both forms. `service` + `date`, or `dutyId`. */
  dutyLookup(
    query: { readonly serviceId?: string; readonly date?: string; readonly dutyId?: string },
    at: Date,
  ): IntercityResult
  /** §10.4. */
  corridors(at: Date): IntercityResult
  /** §7.4/§10.5. Accepts, validates, stores - and discards an out-of-order push. */
  putManifest(push: unknown, at: Date): IntercityResult
  /** §7.4: clears one or all. */
  deleteManifest(
    query: { readonly serviceId: string | null; readonly travelDate: string | null },
    at: Date,
  ): IntercityResult
}

/**
 * The world, as the HTTP layer sees it.
 *
 * Implemented by `src/sim` for real and by `tests/fakes/fakeWorld.ts` for the
 * endpoint tests. Every method is synchronous except the lifecycle pair,
 * because a request handler must not await the simulation.
 */
export interface WorldPort {
  /**
   * The simulated clock. SPEC 8.8: `SIM_CLOCK` may freeze the world at an
   * instant, in which case this returns that instant forever. Every timestamp
   * the API emits - `servedAt`, `meta.generatedAt` - comes from here and never
   * from `Date.now()`, so that a frozen world produces byte-identical responses.
   */
  now(): Date

  /**
   * Duty and tracking for one BIN at one instant, or null if the world has
   * never heard of the BIN.
   *
   * `bin` is the canonical hyphenated form. A null return for a BIN that IS in
   * the registry is not an error: the API answers it as SPEC 5.3 cell D,
   * `unknown` duty with `untracked` tracking, because the registry row and the
   * plate are still facts and refusing to answer would be less honest than
   * saying what is known.
   */
  observe(bin: string, at: Date): VehicleObservation | null

  /**
   * The next stops this vehicle reaches, at most `limit` of them.
   *
   * Empty when `tracking.state` is `dark` or `untracked`, or when
   * `duty.status` is `unknown` - the same rule as the feeds, because it is the
   * same claim in a different wrapper. SPEC 7.1.
   */
  predictNextStops(bin: string, at: Date, limit: number): readonly StopPrediction[]

  /**
   * Every remaining stop on this vehicle's trip, in order, for the
   * `trip-updates` feed - including the ones it will not predict.
   *
   * SPEC 7.3 rules 3 and 4 both need a stop this service has no prediction
   * for: beyond the horizon, and on a dark vehicle. Both are published as
   * `schedule_relationship: NO_DATA` with no `arrival` and no `departure`,
   * which the specification requires and which tells a consumer the trip is
   * running and the timing is unknown - more than silence tells it. A
   * `seconds` of `null` here is that stop.
   *
   * Optional on the port because `tests/fakes/fakeWorld.ts` drives the JSON
   * endpoints and has no trip to enumerate; the feed treats a world without
   * it as a world with no trips to publish.
   */
  scheduleUpdates?(bin: string, at: Date): readonly ScheduleUpdate[]

  /** SPEC 7.4. Drives `/readyz`, which is the probe a monitor should watch. */
  status(at: Date): WorldStatus

  /** Begin ticking. Called once from `src/index.ts` before the server listens. */
  start(): Promise<void>

  /** Stop ticking. Called on shutdown; must be safe to call twice. */
  stop(): Promise<void>
}

/**
 * How `src/index.ts` builds the world. `src/sim` exports a function of this
 * shape; it reads its own parameters from `src/config.ts` and loads its own
 * geometry, and is told only which vehicles exist.
 */
export type CreateWorld = (fleet: readonly FleetMember[]) => Promise<WorldPort>
