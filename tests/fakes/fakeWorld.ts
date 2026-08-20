/**
 * A hand-written, in-memory `WorldPort`.
 *
 * The endpoint tests need to put a vehicle into any of the sixteen cells of
 * SPEC 5.3 on demand and assert the response body. Driving the real simulator
 * into `confirmed + dark` means waiting for a dropout that is deliberately
 * random, so the API tests talk to this instead: every field is set by the
 * test, nothing is drawn, and the clock does not move unless the test moves it.
 *
 * It also lets the HTTP layer be built and tested before `src/sim` exists,
 * which is the reason `src/world/port.ts` exists at all.
 */

import type {
  DutyObservation,
  DutyReason,
  DutyStatus,
  Position,
  Progress,
  RouteRef,
  StopPrediction,
  TrackingObservation,
  TrackingState,
  TripRef,
  VehicleClass,
  VehicleObservation,
  WorldPort,
  WorldStatus,
} from '../../src/world/port.js'

export const FAKE_NOW = new Date('2026-08-20T09:41:26Z')

export const ROUTE_500D: RouteRef = {
  id: '1066',
  number: '500-D',
  name: 'Central Silk Board to Hebbala Bridge',
  nameLocal: null,
}

export const ROUTE_335E: RouteRef = {
  id: '1071',
  number: '335-E',
  name: 'Kempegowda Bus Station to Kadugodi',
  nameLocal: null,
}

export const TRIP_1042: TripRef = {
  id: '1042',
  startTime: '09:15:00',
  startDate: '20260820',
  startedAt: '2026-08-20T03:45:00Z',
}

export const POSITION_DOMLUR: Position = {
  lat: 12.97843,
  lon: 77.64081,
  bearing: 118.4,
  speedKph: 21.6,
  accuracyMetres: 12,
}

export const PROGRESS_DOMLUR: Progress = {
  nextStop: { id: '20985', name: 'Domlur', nameLocal: 'ದೊಮ್ಮಲೂರು', sequence: 14 },
  currentStatus: 'IN_TRANSIT_TO',
  distanceAlongRouteMetres: 8241.5,
  routeLengthMetres: 21903,
}

/** Ages that land a vehicle in each tracking band under the default thresholds. */
const DEFAULT_FIX_AGE_SECONDS: Record<TrackingState, number | null> = {
  live: 14,
  stale: 120,
  dark: 400,
  untracked: null,
}

const DEFAULT_TRACKING_REASON: Record<TrackingState, TrackingObservation['reason']> = {
  live: null,
  stale: 'fix_ageing',
  dark: 'no_fix_since',
  untracked: 'no_device_fitted',
}

const DEFAULT_DUTY_REASON: Record<DutyStatus, DutyReason | null> = {
  confirmed: null,
  inferred: null,
  unknown: 'ambiguous_trip_match',
  out_of_service: 'withdrawn',
}

/**
 * A duty in the requested state, with every dependent field already correct:
 * `confidence` only when `inferred`, `route` and `trip` null when there is no
 * duty, `reason` non-null when the state demands one. Override any of it.
 */
export function fakeDuty(
  status: DutyStatus,
  overrides: Partial<DutyObservation> = {},
): DutyObservation {
  const onDuty = status === 'confirmed' || status === 'inferred'
  const base: DutyObservation = {
    status,
    confidence: status === 'inferred' ? 0.72 : null,
    route: onDuty ? ROUTE_500D : null,
    headsign: onDuty ? 'Hebbala Bridge' : null,
    directionId: onDuty ? 0 : null,
    trip: onDuty ? TRIP_1042 : null,
    since: '2026-08-20T03:45:00Z',
    source: status === 'confirmed' ? 'roster' : status === 'inferred' ? 'position_match' : 'none',
    alternatives: [],
    reason: DEFAULT_DUTY_REASON[status],
  }
  return { ...base, ...overrides }
}

/**
 * Tracking in the requested state, aged relative to `at` so that
 * `fixAgeSeconds` lands in the right band. `untracked` gets a null position and
 * `no_device_fitted`, which is the pairing SPEC 6.2 makes mandatory.
 */
export function fakeTracking(
  state: TrackingState,
  overrides: Partial<TrackingObservation> & { at?: Date; fixAgeSeconds?: number } = {},
): TrackingObservation {
  const { at = FAKE_NOW, fixAgeSeconds, ...rest } = overrides
  const age = fixAgeSeconds ?? DEFAULT_FIX_AGE_SECONDS[state]
  const tracked = state !== 'untracked'
  const base: TrackingObservation = {
    state,
    observedAt: age === null ? null : new Date(at.getTime() - age * 1000).toISOString(),
    position: tracked ? POSITION_DOMLUR : null,
    progress: tracked ? PROGRESS_DOMLUR : null,
    source: 'simulated_gnss',
    reason: DEFAULT_TRACKING_REASON[state],
    recoveredFromDropout: false,
  }
  return { ...base, ...rest }
}

/** One vehicle in one cell of the SPEC 5.3 grid. */
export function fakeObservation(
  bin: string,
  duty: DutyStatus | DutyObservation,
  tracking: TrackingState | TrackingObservation,
  extra: { class?: VehicleClass; overridden?: boolean; at?: Date } = {},
): VehicleObservation {
  const at = extra.at ?? FAKE_NOW
  return {
    bin,
    class: extra.class ?? 'bus',
    duty: typeof duty === 'string' ? fakeDuty(duty) : duty,
    tracking: typeof tracking === 'string' ? fakeTracking(tracking, { at }) : tracking,
    overridden: extra.overridden ?? false,
  }
}

const DEFAULT_STATUS: WorldStatus = {
  geometryLoaded: true,
  routes: 5,
  metroLines: 0,
  vehicles: 30,
  lastTickAt: FAKE_NOW.toISOString(),
  tickLagMs: 3,
  seed: 1,
}

export interface FakeWorldOptions {
  now?: Date
  observations?: readonly VehicleObservation[]
  predictions?: Readonly<Record<string, readonly StopPrediction[]>>
  status?: Partial<WorldStatus>
}

export class FakeWorld implements WorldPort {
  #now: Date
  #observations = new Map<string, VehicleObservation>()
  #predictions = new Map<string, readonly StopPrediction[]>()
  #status: WorldStatus
  started = false

  /** Every `observe()` call, in order. The endpoint tests assert on this. */
  readonly observeCalls: string[] = []

  constructor(options: FakeWorldOptions = {}) {
    this.#now = options.now ?? FAKE_NOW
    for (const observation of options.observations ?? []) this.put(observation)
    for (const [bin, stops] of Object.entries(options.predictions ?? {})) {
      this.#predictions.set(bin, stops)
    }
    this.#status = { ...DEFAULT_STATUS, ...options.status }
  }

  put(observation: VehicleObservation): this {
    this.#observations.set(observation.bin, observation)
    return this
  }

  setPredictions(bin: string, stops: readonly StopPrediction[]): this {
    this.#predictions.set(bin, stops)
    return this
  }

  setNow(now: Date): this {
    this.#now = now
    return this
  }

  setStatus(status: Partial<WorldStatus>): this {
    this.#status = { ...this.#status, ...status }
    return this
  }

  now(): Date {
    return this.#now
  }

  observe(bin: string): VehicleObservation | null {
    this.observeCalls.push(bin)
    return this.#observations.get(bin) ?? null
  }

  predictNextStops(bin: string, _at: Date, limit: number): readonly StopPrediction[] {
    return (this.#predictions.get(bin) ?? []).slice(0, limit)
  }

  status(): WorldStatus {
    return this.#status
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }
}
