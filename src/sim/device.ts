import { config } from '../config.js'
import type { Position, Progress, TrackingObservation } from '../world/port.js'
import { rand } from './rand.js'

export interface FixSnapshot {
  readonly position: Position
  readonly progress: Progress | null
}

export interface BusDeviceProfile {
  readonly seed: number
  readonly coverageShare: number
  readonly fixIntervalSeconds: number
  readonly fixJitterSeconds: number
  readonly staleAfterSeconds: number
  readonly darkAfterSeconds: number
  readonly dropoutRatePerHour: number
  readonly dropoutMinSeconds: number
  readonly dropoutMaxSeconds: number
  readonly gpsNoiseMetres: number
}

export interface DeviceState {
  readonly bin: string
  readonly hasDevice: boolean
  lastFix: (FixSnapshot & { readonly observedAt: Date }) | null
  nextFixAtMs: number | null
  fixSequence: number
  dropoutActive: boolean
  recoveredUntilMs: number | null
}

export const defaultBusDeviceProfile: BusDeviceProfile = {
  seed: config.simSeed,
  coverageShare: config.busCoverageShare,
  fixIntervalSeconds: config.busFixIntervalSeconds,
  fixJitterSeconds: config.busFixJitterSeconds,
  staleAfterSeconds: config.busStaleAfterSeconds,
  darkAfterSeconds: config.busDarkAfterSeconds,
  dropoutRatePerHour: config.busDropoutRatePerHour,
  dropoutMinSeconds: config.busDropoutMinSeconds,
  dropoutMaxSeconds: config.busDropoutMaxSeconds,
  gpsNoiseMetres: config.busGpsNoiseMetres,
}

export function createDeviceState(
  bin: string,
  at: Date,
  capture: () => FixSnapshot,
  profile: BusDeviceProfile = defaultBusDeviceProfile,
): DeviceState {
  const hasDevice = rand(profile.seed, bin, 'coverage', 0) < profile.coverageShare
  if (!hasDevice) {
    return {
      bin,
      hasDevice,
      lastFix: null,
      nextFixAtMs: null,
      fixSequence: 0,
      dropoutActive: false,
      recoveredUntilMs: null,
    }
  }
  return {
    bin,
    hasDevice,
    lastFix: { ...capture(), observedAt: new Date(at) },
    nextFixAtMs: at.getTime() + nextIntervalSeconds(profile, bin, 0) * 1000,
    fixSequence: 0,
    dropoutActive: false,
    recoveredUntilMs: null,
  }
}

export function updateDevice(
  state: DeviceState,
  at: Date,
  capture: (fixSequence: number) => FixSnapshot,
  profile: BusDeviceProfile = defaultBusDeviceProfile,
): void {
  if (!state.hasDevice) return
  const dropping = activeDropout(profile, state.bin, at)
  const recovered = state.dropoutActive && !dropping
  state.dropoutActive = dropping
  if (dropping) return
  if (!recovered && (state.nextFixAtMs === null || at.getTime() < state.nextFixAtMs)) return
  state.fixSequence += 1
  state.lastFix = { ...capture(state.fixSequence), observedAt: new Date(at) }
  const interval = nextIntervalSeconds(profile, state.bin, state.fixSequence)
  state.nextFixAtMs = at.getTime() + interval * 1000
  state.recoveredUntilMs = recovered ? at.getTime() + interval * 1000 : null
}

export function trackingObservation(
  state: DeviceState,
  at: Date,
  hasDuty: boolean,
  profile: BusDeviceProfile = defaultBusDeviceProfile,
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
    }
  }
  const ageSeconds = Math.max(0, (at.getTime() - state.lastFix.observedAt.getTime()) / 1000)
  const trackingState =
    ageSeconds <= profile.staleAfterSeconds
      ? 'live'
      : ageSeconds <= profile.darkAfterSeconds
        ? 'stale'
        : 'dark'
  return {
    state: trackingState,
    observedAt: state.lastFix.observedAt.toISOString(),
    position: state.lastFix.position,
    progress: trackingState === 'live' && hasDuty ? state.lastFix.progress : null,
    source: 'simulated_gnss',
    reason:
      trackingState === 'live'
        ? null
        : trackingState === 'stale'
          ? 'fix_ageing'
          : state.dropoutActive
            ? 'device_offline'
            : 'no_fix_since',
    recoveredFromDropout:
      state.recoveredUntilMs !== null && at.getTime() <= state.recoveredUntilMs,
  }
}

export function addGpsNoise(
  position: Position,
  profile: BusDeviceProfile,
  bin: string,
  fixSequence: number,
): Position {
  if (profile.gpsNoiseMetres === 0) return { ...position, accuracyMetres: 0 }
  const along = normal(profile.seed, bin, 'gps_along', fixSequence) * profile.gpsNoiseMetres
  const cross = normal(profile.seed, bin, 'gps_cross', fixSequence) * profile.gpsNoiseMetres
  const bearing = (position.bearing * Math.PI) / 180
  const north = along * Math.cos(bearing) - cross * Math.sin(bearing)
  const east = along * Math.sin(bearing) + cross * Math.cos(bearing)
  const latitudeScale = 111_320
  const longitudeScale = latitudeScale * Math.cos((position.lat * Math.PI) / 180)
  return {
    ...position,
    lat: position.lat + north / latitudeScale,
    lon: position.lon + east / longitudeScale,
    accuracyMetres: profile.gpsNoiseMetres,
  }
}

function nextIntervalSeconds(profile: BusDeviceProfile, bin: string, sequence: number): number {
  const jitter = (rand(profile.seed, bin, 'fix_jitter', sequence) * 2 - 1) * profile.fixJitterSeconds
  return Math.max(0.001, profile.fixIntervalSeconds + jitter)
}

function activeDropout(profile: BusDeviceProfile, bin: string, at: Date): boolean {
  if (profile.dropoutRatePerHour === 0) return false
  const currentMinute = Math.floor(at.getTime() / 60_000)
  const lookback = Math.ceil(profile.dropoutMaxSeconds / 60) + 1
  const probabilityPerMinute = 1 - Math.exp(-profile.dropoutRatePerHour / 60)
  for (let bucket = currentMinute - lookback; bucket <= currentMinute; bucket += 1) {
    if (rand(profile.seed, bin, 'dropout', bucket) >= probabilityPerMinute) continue
    const duration =
      profile.dropoutMinSeconds +
      rand(profile.seed, bin, 'dropout_duration', bucket) *
        (profile.dropoutMaxSeconds - profile.dropoutMinSeconds)
    const startedAt = bucket * 60_000
    if (at.getTime() >= startedAt && at.getTime() < startedAt + duration * 1000) return true
  }
  return false
}

function normal(seed: number, bin: string, purpose: string, bucket: number): number {
  const first = Math.max(Number.EPSILON, rand(seed, bin, `${purpose}_a`, bucket))
  const second = rand(seed, bin, `${purpose}_b`, bucket)
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
}
