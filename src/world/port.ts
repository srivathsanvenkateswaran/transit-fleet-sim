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

/** SPEC 3.3. One vehicle model, two profiles. */
export type VehicleClass = 'bus' | 'metro'

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
  readonly since: string
  readonly source: DutySource
  /** Possibly non-empty only when `status` is `unknown`. */
  readonly alternatives: readonly DutyAlternative[]
  /** Non-null whenever `status` is `unknown` or `out_of_service`. */
  readonly reason: DutyReason | null
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

export interface Progress {
  readonly nextStop: StopRef | null
  readonly currentStatus: VehicleStopStatus
  readonly distanceAlongRouteMetres: number
  readonly routeLengthMetres: number
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
  /**
   * True when a scenario override is currently forcing this vehicle's duty or
   * tracking. Surfaces as `meta.overridden` so nobody debugs a forced state for
   * twenty minutes. SPEC 7.5.
   */
  readonly overridden: boolean
}

/** One predicted stop arrival, with its band. SPEC 7.1. */
export interface StopPrediction {
  readonly stop: StopRef
  readonly seconds: number
  /** Never omitted and never zero. SPEC decision 6, criterion 35. */
  readonly uncertaintySeconds: number
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
