import { config } from '../config.js'
import type { GtfsRoute } from '../geometry/loadGtfs.js'
import type { DutyObservation, DutyReason, DutyStatus, RouteRef } from '../world/port.js'
import type { ActiveBus } from './dispatch.js'
import { rand } from './rand.js'

export interface BusDutyProfile {
  readonly seed: number
  readonly confirmedShare: number
  readonly inferredShare: number
  readonly unknownShare: number
  readonly outOfServiceShare: number
  readonly inferredConfidenceMin: number
  readonly inferredConfidenceMax: number
  readonly swapRatePerDay: number
}

export interface DutyState {
  status: DutyStatus
  since: Date
  confidence: number | null
  reason: DutyReason | null
}

export const defaultBusDutyProfile: BusDutyProfile = {
  seed: config.simSeed,
  confirmedShare: config.dutyConfirmedShare,
  inferredShare: config.dutyInferredShare,
  unknownShare: config.dutyUnknownShare,
  outOfServiceShare: config.dutyOutOfServiceShare,
  inferredConfidenceMin: config.dutyInferredConfidenceMin,
  inferredConfidenceMax: config.dutyInferredConfidenceMax,
  swapRatePerDay: config.dutySwapRatePerDay,
}

export function validateDutyProfile(profile: BusDutyProfile): void {
  const total =
    profile.confirmedShare +
    profile.inferredShare +
    profile.unknownShare +
    profile.outOfServiceShare
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(
      `Duty shares must sum to 1.0; confirmed=${profile.confirmedShare}, inferred=${profile.inferredShare}, unknown=${profile.unknownShare}, out_of_service=${profile.outOfServiceShare}, sum=${total}`,
    )
  }
  if (profile.inferredConfidenceMin > profile.inferredConfidenceMax) {
    throw new Error('Duty inferred confidence minimum exceeds maximum')
  }
}

export function createDutyState(
  bin: string,
  at: Date,
  serviceDate: string,
  profile: BusDutyProfile = defaultBusDutyProfile,
): DutyState {
  validateDutyProfile(profile)
  const draw = rand(profile.seed, bin, 'duty', serviceDate)
  if (draw < profile.confirmedShare) {
    return { status: 'confirmed', since: new Date(at), confidence: null, reason: null }
  }
  if (draw < profile.confirmedShare + profile.inferredShare) {
    return {
      status: 'inferred',
      since: new Date(at),
      confidence: inferredConfidence(profile, bin, serviceDate),
      reason: null,
    }
  }
  if (draw < profile.confirmedShare + profile.inferredShare + profile.unknownShare) {
    const reasons: DutyReason[] = ['ambiguous_trip_match', 'off_pattern', 'roster_swapped']
    const reasonIndex = Math.floor(rand(profile.seed, bin, 'duty_reason', serviceDate) * reasons.length)
    return {
      status: 'unknown',
      since: new Date(at),
      confidence: null,
      reason: reasons[reasonIndex] ?? 'ambiguous_trip_match',
    }
  }
  return {
    status: 'out_of_service',
    since: new Date(at),
    confidence: null,
    reason: rand(profile.seed, bin, 'out_of_service_reason', serviceDate) < 0.5 ? 'deadheading' : 'on_break',
  }
}

export function maybeSwapDuty(
  state: DutyState,
  bin: string,
  at: Date,
  profile: BusDutyProfile = defaultBusDutyProfile,
): void {
  if (state.status !== 'confirmed' || profile.swapRatePerDay === 0) return
  const minute = Math.floor(at.getTime() / 60_000)
  const probabilityPerMinute = 1 - Math.exp(-profile.swapRatePerDay / 1_440)
  if (rand(profile.seed, bin, 'duty_swap', minute) >= probabilityPerMinute) return
  const unknown = rand(profile.seed, bin, 'duty_swap_result', minute) < 0.5
  state.status = unknown ? 'unknown' : 'inferred'
  state.since = new Date(at)
  state.confidence = unknown ? null : inferredConfidence(profile, bin, minute)
  state.reason = 'roster_swapped'
}

export function dutyObservation(
  state: DutyState,
  bus: ActiveBus,
  allRoutes: readonly GtfsRoute[],
  profile: BusDutyProfile = defaultBusDutyProfile,
): DutyObservation {
  const onDuty = state.status === 'confirmed' || state.status === 'inferred'
  const route = routeRef(bus.route)
  return {
    status: state.status,
    confidence: state.confidence,
    route: onDuty ? route : null,
    headsign: onDuty ? bus.trip.headsign : null,
    directionId: onDuty ? bus.trip.directionId : null,
    trip: onDuty
      ? {
          id: bus.trip.id,
          startTime: bus.trip.stops[0]?.departureTime ?? '00:00:00',
          startDate: serviceDate(bus.tripStartedAt, config.simTimezone),
          startedAt: bus.tripStartedAt.toISOString(),
        }
      : null,
    since: state.since.toISOString(),
    source:
      state.status === 'confirmed'
        ? 'roster'
        : state.status === 'inferred'
          ? 'position_match'
          : 'none',
    alternatives:
      state.status === 'unknown' && state.reason === 'ambiguous_trip_match'
        ? alternatives(allRoutes, bus, profile)
        : [],
    reason: state.reason,
  }
}

function inferredConfidence(profile: BusDutyProfile, bin: string, bucket: string | number): number {
  const draw = rand(profile.seed, bin, 'duty_confidence', bucket)
  const value = profile.inferredConfidenceMin + draw * (profile.inferredConfidenceMax - profile.inferredConfidenceMin)
  return Math.round(value * 100) / 100
}

function alternatives(
  routes: readonly GtfsRoute[],
  bus: ActiveBus,
  profile: BusDutyProfile,
): DutyObservation['alternatives'] {
  return routes
    .filter((route) => route.id !== bus.route.id)
    .slice(0, 2)
    .map((route, index) => ({
      route: routeRef(route),
      headsign: route.trips[0]?.headsign ?? null,
      directionId: route.trips[0]?.directionId ?? null,
      confidence: Math.round((0.51 + rand(profile.seed, bus.member.bin, 'alternative', index) * 0.3) * 100) / 100,
    }))
    .sort((a, b) => b.confidence - a.confidence)
}

function routeRef(route: GtfsRoute): RouteRef {
  return { id: route.id, number: route.number, name: route.name, nameLocal: null }
}

function serviceDate(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}${value('month')}${value('day')}`
}
