import type { CorridorDeadZone } from '../geometry/corridorTopology.js'
import { haversineMetres } from '../geometry/haversine.js'
import type { DeadZoneRef, Position, Recovery, TrackingObservation } from '../world/port.js'
import { poissonDropoutActive, type BusDeviceProfile, type FixSnapshot } from './device.js'
import { rand } from './rand.js'

/**
 * The intercity device model - docs/intercity-coaches.md §6.
 *
 * The ruling is "better fitted, worse tracked", and the two halves are
 * separate facts that the city model conflates because in Bengaluru they
 * nearly coincide.
 *
 *   - **Coverage** answers *is there a device*. It goes up for a reserved
 *     coach (0.92 against the city bus's 0.75) because the premium fleet is
 *     largely post-2018 under a registration-linked fitment mandate and the
 *     operator carries refund liability against named bookings. It goes
 *     *down* for ordinary Karnataka Sarige (0.70), which is the old rural
 *     end of the same corporations' fleets. That is what makes this a ruling
 *     about **service class** rather than about mode, and it is why the share
 *     is chosen by `reserved`, never by `.class === 'coach'`.
 *   - **Continuity** answers *can it reach a backhaul*, and it collapses:
 *     `stale` after 180 s rather than 90, `dark` after 600 rather than 300,
 *     and dropouts that are intervals of route distance rather than a Poisson
 *     process in time.
 *
 * Every magnitude above is a modelling choice and none is a measurement. No
 * public source states any of the three corporations' AIS-140 fitment rate;
 * §17.2 records the whole row as stubbed and every figure is an environment
 * variable for exactly that reason.
 *
 * §12.2 also records the one deliberate departure from GTFS-Realtime's
 * 90-second data-age guidance: at 65 km/h a 90-second-old fix puts the coach
 * 1.6 km further on, which on a 340 km run is not worth flagging to a rider,
 * and spending the word `stale` on it would leave nothing to say when a fix
 * is genuinely twenty minutes old. That changes this service's own editorial
 * vocabulary and nothing else - the feed stays unfreshened and
 * `fixAgeSeconds` is published either way.
 */

export interface IntercityDeviceProfile {
  readonly seed: number
  readonly coverageShareReserved: number
  readonly coverageShareOrdinary: number
  readonly fixIntervalSeconds: number
  readonly fixIntervalStationarySeconds: number
  readonly fixJitterSeconds: number
  readonly staleAfterSeconds: number
  readonly darkAfterSeconds: number
  readonly gpsNoiseMetres: number
  readonly urbanDropoutRatePerHour: number
  readonly urbanDropoutMinSeconds: number
  readonly urbanDropoutMaxSeconds: number
}

export interface IntercityDeviceState {
  readonly bin: string
  readonly hasDevice: boolean
  lastFix: (FixSnapshot & { readonly observedAt: Date; readonly distanceMetres: number }) | null
  nextFixAtMs: number | null
  fixSequence: number
  /** Non-null while no fix can reach a backhaul, whatever the mechanism. */
  blockedSinceMs: number | null
  blockedInZone: boolean
  blockedOutsideZone: boolean
  currentZone: CorridorDeadZone | null
  recovery: Recovery | null
  recoveredUntilMs: number | null
}

export interface IntercityFixContext {
  readonly distanceMetres: number
  readonly corridorId: string
  readonly deadZones: readonly CorridorDeadZone[]
  readonly segmentKind: 'highway' | 'urban'
  /** True while dwelling at a stand or halt: §4.3's slower stationary interval. */
  readonly stationary: boolean
  readonly speedKph: number
  /**
   * The band on `expectedExitAt`, supplied by the caller so the exit estimate
   * uses §5.3's prediction model rather than a second, unrelated constant
   * invented here.
   */
  readonly exitUncertaintySeconds: number
}

/** §6.2: the coverage share is chosen by reservation, never by vehicle class. */
export function coverageShareFor(profile: IntercityDeviceProfile, reserved: boolean): number {
  return reserved ? profile.coverageShareReserved : profile.coverageShareOrdinary
}

export function createIntercityDeviceState(
  bin: string,
  reserved: boolean,
  profile: IntercityDeviceProfile,
): IntercityDeviceState {
  const hasDevice = rand(profile.seed, bin, 'coverage', 0) < coverageShareFor(profile, reserved)
  return {
    bin,
    hasDevice,
    lastFix: null,
    nextFixAtMs: null,
    fixSequence: 0,
    blockedSinceMs: null,
    blockedInZone: false,
    blockedOutsideZone: false,
    currentZone: null,
    recovery: null,
    recoveredUntilMs: null,
  }
}

/** §6.3: a vehicle is dark exactly while `cursor.distanceMetres` lies inside an authored zone. */
export function deadZoneAt(
  distanceMetres: number,
  zones: readonly CorridorDeadZone[],
): CorridorDeadZone | null {
  return (
    zones.find((zone) => distanceMetres >= zone.fromMetres && distanceMetres < zone.toMetres) ?? null
  )
}

export function updateIntercityDevice(
  state: IntercityDeviceState,
  at: Date,
  context: IntercityFixContext,
  capture: (fixSequence: number) => FixSnapshot,
  profile: IntercityDeviceProfile,
  dropoutBucketAt: Date = at,
): void {
  if (!state.hasDevice) return

  const zone = deadZoneAt(context.distanceMetres, context.deadZones)
  // §6.3: both mechanisms run on the same corridor, on different parts of it.
  // The Poisson process is the city model's own, unmodified, and it is
  // confined to urban segments - a highway between districts fails
  // geographically or not at all.
  const urbanDropout =
    zone === null &&
    context.segmentKind === 'urban' &&
    poissonDropoutActive(urbanProfile(profile, state.bin), state.bin, dropoutBucketAt)
  const blocked = zone !== null || urbanDropout

  if (blocked) {
    if (state.blockedSinceMs === null) state.blockedSinceMs = at.getTime()
    if (zone !== null) state.blockedInZone = true
    else state.blockedOutsideZone = true
    state.currentZone = zone
    return
  }

  const recovered = state.blockedSinceMs !== null
  const previousFix = state.lastFix
  if (!recovered && (state.nextFixAtMs === null || at.getTime() < state.nextFixAtMs)) {
    if (state.lastFix !== null) return
  }

  state.fixSequence += 1
  const snapshot = capture(state.fixSequence)
  const nextFix = { ...snapshot, observedAt: new Date(at), distanceMetres: context.distanceMetres }

  if (recovered && previousFix !== null) {
    // §6.4: publish the gap, do not paper over it. Both ends were genuine
    // observations this service already made; `gapMetres` is measured between
    // the two *published* positions, so criterion 76's "to within one metre"
    // holds by construction rather than by agreeing with a separate cursor
    // reading.
    state.recovery = {
      fromPosition: { lat: previousFix.position.lat, lon: previousFix.position.lon },
      fromObservedAt: previousFix.observedAt.toISOString(),
      gapSeconds: Math.round((at.getTime() - previousFix.observedAt.getTime()) / 1_000),
      gapMetres: haversineMetres(previousFix.position, nextFix.position),
      cause: recoveryCause(state),
    }
  } else if (!recovered) {
    state.recovery = null
  }

  state.lastFix = nextFix
  const interval = nextIntervalSeconds(profile, state.bin, state.fixSequence, context.stationary)
  state.nextFixAtMs = at.getTime() + interval * 1_000
  state.recoveredUntilMs = recovered ? at.getTime() + interval * 1_000 : state.recoveredUntilMs
  state.blockedSinceMs = null
  state.blockedInZone = false
  state.blockedOutsideZone = false
  state.currentZone = null
}

/**
 * §6.4: "`cause` is `dead_zone` only when the dark period began and ended
 * inside an authored zone, and `unknown` otherwise - the service does not
 * guess at a cause it cannot distinguish."
 *
 * `device_offline` is in the published union (§6.4) and is deliberately not
 * produced here. A gap on an urban segment is the city model's Poisson
 * dropout, and a real tracking backend looking at that gap cannot tell a dead
 * SIM from a tunnel from a switched-off device; naming it `device_offline`
 * would be this simulator leaking its own ground truth onto the wire, which
 * is the same fault as a prediction that cannot be wrong. The value stays in
 * the union for a cause an operator genuinely does know - a device reported
 * offline - which nothing in this build produces.
 */
function recoveryCause(state: IntercityDeviceState): Recovery['cause'] {
  return state.blockedInZone && !state.blockedOutsideZone ? 'dead_zone' : 'unknown'
}

export function intercityTrackingObservation(
  state: IntercityDeviceState,
  at: Date,
  hasDuty: boolean,
  context: IntercityFixContext,
  profile: IntercityDeviceProfile,
): TrackingObservation {
  if (!state.hasDevice || state.lastFix === null) {
    return {
      state: 'untracked',
      observedAt: null,
      position: null,
      progress: null,
      source: 'simulated_gnss',
      reason: 'no_device_fitted',
      recoveredFromDropout: false,
      deadZone: null,
      recovery: null,
    }
  }
  const ageSeconds = Math.max(0, (at.getTime() - state.lastFix.observedAt.getTime()) / 1_000)
  const trackingState =
    ageSeconds <= profile.staleAfterSeconds
      ? 'live'
      : ageSeconds <= profile.darkAfterSeconds
        ? 'stale'
        : 'dark'
  const recoveredFromDropout =
    state.recoveredUntilMs !== null && at.getTime() <= state.recoveredUntilMs
  return {
    state: trackingState,
    observedAt: state.lastFix.observedAt.toISOString(),
    position: state.lastFix.position,
    // §10.2: `progress` stays null in `stale`, `dark` and `untracked`,
    // unchanged. The `deadZone` object is not a position and does not pretend
    // to be one.
    progress: trackingState === 'live' && hasDuty ? state.lastFix.progress : null,
    source: 'simulated_gnss',
    reason:
      trackingState === 'live'
        ? null
        : trackingState === 'stale'
          ? 'fix_ageing'
          : state.blockedSinceMs !== null && !state.blockedInZone
            ? 'device_offline'
            : 'no_fix_since',
    recoveredFromDropout,
    deadZone: deadZoneRef(state, at, context, profile),
    recovery: recoveredFromDropout ? state.recovery : null,
  }
}

/**
 * §10.2: non-null only inside an authored zone, and only once the fix has
 * actually aged out of `live`. Publishing an interval while the last fix is
 * still fresh would describe a gap that has not happened yet.
 */
function deadZoneRef(
  state: IntercityDeviceState,
  at: Date,
  context: IntercityFixContext,
  profile: IntercityDeviceProfile,
): DeadZoneRef | null {
  const zone = state.currentZone
  if (zone === null || state.blockedSinceMs === null || state.lastFix === null) return null
  const ageSeconds = (at.getTime() - state.lastFix.observedAt.getTime()) / 1_000
  if (ageSeconds <= profile.staleAfterSeconds) return null
  const metresPerSecond = Math.max(1, context.speedKph) / 3.6
  const secondsToExit = Math.max(0, (zone.toMetres - context.distanceMetres) / metresPerSecond)
  return {
    corridorId: context.corridorId,
    fromMetres: zone.fromMetres,
    toMetres: zone.toMetres,
    enteredAt: new Date(state.blockedSinceMs).toISOString(),
    expectedExitAt: new Date(at.getTime() + secondsToExit * 1_000).toISOString(),
    expectedExitUncertaintySeconds: Math.round(context.exitUncertaintySeconds),
  }
}

/** §4.3: a coach parked for thirty minutes at a 20-second interval emits ninety identical fixes. */
function nextIntervalSeconds(
  profile: IntercityDeviceProfile,
  bin: string,
  sequence: number,
  stationary: boolean,
): number {
  const base = stationary ? profile.fixIntervalStationarySeconds : profile.fixIntervalSeconds
  const jitter = (rand(profile.seed, bin, 'fix_jitter', sequence) * 2 - 1) * profile.fixJitterSeconds
  return Math.max(0.001, base + jitter)
}

/**
 * The city device profile, as the urban segments of a corridor see it. Only
 * the four fields `poissonDropoutActive` reads are meaningful; the rest are
 * filled from the intercity profile so nothing in this shape is a second,
 * silently diverging copy of a number.
 */
function urbanProfile(profile: IntercityDeviceProfile, _bin: string): BusDeviceProfile {
  return {
    seed: profile.seed,
    coverageShare: 1,
    fixIntervalSeconds: profile.fixIntervalSeconds,
    fixJitterSeconds: profile.fixJitterSeconds,
    staleAfterSeconds: profile.staleAfterSeconds,
    darkAfterSeconds: profile.darkAfterSeconds,
    dropoutRatePerHour: profile.urbanDropoutRatePerHour,
    dropoutMinSeconds: profile.urbanDropoutMinSeconds,
    dropoutMaxSeconds: profile.urbanDropoutMaxSeconds,
    gpsNoiseMetres: profile.gpsNoiseMetres,
  }
}

export function intercityGpsProfile(profile: IntercityDeviceProfile): BusDeviceProfile {
  return urbanProfile(profile, '')
}

export type { Position }
