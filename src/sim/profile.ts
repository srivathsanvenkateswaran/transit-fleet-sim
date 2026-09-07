import { config } from '../config.js'
import { cachedDateTimeFormat } from './dateTimeFormatCache.js'
import { rand } from './rand.js'

export interface BusMotionProfile {
  readonly seed: number
  readonly speedKphMean: number
  readonly speedKphSd: number
  readonly speedKphMin: number
  readonly speedKphMax: number
  readonly dwellSecondsMean: number
  readonly dwellSecondsSd: number
  readonly peakSpeedFactor: number
  readonly peakWindowMinutes: readonly { start: number; end: number }[]
  readonly timezone: string
  readonly terminalLayoverSeconds: number
}

export const defaultBusMotionProfile: BusMotionProfile = {
  seed: config.simSeed,
  speedKphMean: config.busSpeedKphMean,
  speedKphSd: config.busSpeedKphSd,
  speedKphMin: config.busSpeedKphMin,
  speedKphMax: config.busSpeedKphMax,
  dwellSecondsMean: config.busDwellSecondsMean,
  dwellSecondsSd: config.busDwellSecondsSd,
  peakSpeedFactor: config.busPeakSpeedFactor,
  peakWindowMinutes: config.busPeakWindowMinutes,
  timezone: config.simTimezone,
  terminalLayoverSeconds: config.busTerminalLayoverSeconds,
}

export function drawBusSpeedKph(
  profile: BusMotionProfile,
  bin: string,
  segment: number,
  at: Date,
): number {
  const sampled = normal(profile, bin, 'speed', segment, profile.speedKphMean, profile.speedKphSd)
  const factored = sampled * (isPeak(at, profile) ? profile.peakSpeedFactor : 1)
  return clamp(factored, profile.speedKphMin, profile.speedKphMax)
}

export function drawDwellSeconds(
  profile: BusMotionProfile,
  bin: string,
  stopVisit: number,
): number {
  return Math.max(
    0,
    normal(profile, bin, 'dwell', stopVisit, profile.dwellSecondsMean, profile.dwellSecondsSd),
  )
}

function normal(
  profile: BusMotionProfile,
  bin: string,
  purpose: string,
  bucket: number,
  mean: number,
  standardDeviation: number,
): number {
  const first = Math.max(Number.EPSILON, rand(profile.seed, bin, `${purpose}_a`, bucket))
  const second = rand(profile.seed, bin, `${purpose}_b`, bucket)
  const standard = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
  return mean + standard * standardDeviation
}

function isPeak(at: Date, profile: BusMotionProfile): boolean {
  const parts = cachedDateTimeFormat('en-GB', {
    timeZone: profile.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  const current = hour * 60 + minute
  return profile.peakWindowMinutes.some(
    ({ start, end }) => current >= start && current < end,
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
