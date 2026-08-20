import { resolve } from 'node:path'

export type GtfsSource = 'bundled' | 'path' | 'url'

const servicePort = parsePositiveInteger(process.env.PORT ?? '8080', 'PORT')

/**
 * Environment names and local defaults live in this file only. Configuration
 * grows with the service, but callers receive already parsed values.
 */
export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: servicePort,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${servicePort}`,
  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? '*',
  requestTimeoutMs: parsePositiveInteger(
    process.env.REQUEST_TIMEOUT_MS ?? '5000',
    'REQUEST_TIMEOUT_MS',
  ),
  simAllowTimeTravel: parseBoolean(
    process.env.SIM_ALLOW_TIME_TRAVEL ?? 'false',
    'SIM_ALLOW_TIME_TRAVEL',
  ),
  predictionHorizonStops: parsePositiveInteger(
    process.env.PREDICTION_HORIZON_STOPS ?? '5',
    'PREDICTION_HORIZON_STOPS',
  ),
  busHubName: process.env.BUS_HUB_NAME ?? 'Bengaluru Central',
  gtfsSource: parseGtfsSource(process.env.GTFS_SOURCE ?? 'bundled'),
  gtfsBundlePath: resolve(process.env.GTFS_BUNDLE_PATH ?? 'data/bundle'),
  gtfsPath: process.env.GTFS_PATH === undefined ? null : resolve(process.env.GTFS_PATH),
  gtfsUrl: process.env.GTFS_URL ?? null,
  gtfsRepositoryUrl:
    process.env.GTFS_REPOSITORY_URL ?? 'https://github.com/Vonter/bmtc-gtfs',
  upstreamGtfsUrl:
    'https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip',
  gtfsCacheDir: resolve(process.env.GTFS_CACHE_DIR ?? '.cache/gtfs'),
  busRoutes: (process.env.BUS_ROUTES ?? '500-D,500-A,G-4,335-E,401-K')
    .split(',')
    .map((route) => route.trim())
    .filter(Boolean),
  busesPerRoute: parsePositiveInteger(process.env.BUSES_PER_ROUTE ?? '6', 'BUSES_PER_ROUTE'),
  busHubCode: parseHubCode(process.env.BUS_HUB_CODE ?? 'BLR', 'BUS_HUB_CODE'),
  simSeed: parseInteger(process.env.SIM_SEED ?? '1', 'SIM_SEED'),
  simTickMs: parsePositiveInteger(process.env.SIM_TICK_MS ?? '1000', 'SIM_TICK_MS'),
  simTimezone: process.env.SIM_TIMEZONE ?? 'Asia/Kolkata',
  simClock: process.env.SIM_CLOCK ?? 'system',
  simSpeedup: parsePositiveNumber(process.env.SIM_SPEEDUP ?? '1', 'SIM_SPEEDUP'),
  busTerminalLayoverSeconds: parseNonNegativeNumber(
    process.env.BUS_TERMINAL_LAYOVER_SECONDS ?? '300',
    'BUS_TERMINAL_LAYOVER_SECONDS',
  ),
  busSpeedKphMean: parsePositiveNumber(process.env.BUS_SPEED_KPH_MEAN ?? '17', 'BUS_SPEED_KPH_MEAN'),
  busSpeedKphSd: parseNonNegativeNumber(process.env.BUS_SPEED_KPH_SD ?? '4', 'BUS_SPEED_KPH_SD'),
  busSpeedKphMin: parsePositiveNumber(process.env.BUS_SPEED_KPH_MIN ?? '5', 'BUS_SPEED_KPH_MIN'),
  busSpeedKphMax: parsePositiveNumber(process.env.BUS_SPEED_KPH_MAX ?? '45', 'BUS_SPEED_KPH_MAX'),
  busDwellSecondsMean: parseNonNegativeNumber(
    process.env.BUS_DWELL_SECONDS_MEAN ?? '20',
    'BUS_DWELL_SECONDS_MEAN',
  ),
  busDwellSecondsSd: parseNonNegativeNumber(
    process.env.BUS_DWELL_SECONDS_SD ?? '8',
    'BUS_DWELL_SECONDS_SD',
  ),
  busPeakSpeedFactor: parsePositiveNumber(
    process.env.BUS_PEAK_SPEED_FACTOR ?? '0.7',
    'BUS_PEAK_SPEED_FACTOR',
  ),
  busPeakWindows: process.env.BUS_PEAK_WINDOWS ?? '07:00-10:00,17:00-21:00',
  busFixIntervalSeconds: parsePositiveNumber(
    process.env.BUS_FIX_INTERVAL_SECONDS ?? '20',
    'BUS_FIX_INTERVAL_SECONDS',
  ),
  busFixJitterSeconds: parseNonNegativeNumber(
    process.env.BUS_FIX_JITTER_SECONDS ?? '10',
    'BUS_FIX_JITTER_SECONDS',
  ),
  busStaleAfterSeconds: parsePositiveNumber(
    process.env.BUS_STALE_AFTER_SECONDS ?? '90',
    'BUS_STALE_AFTER_SECONDS',
  ),
  busDarkAfterSeconds: parsePositiveNumber(
    process.env.BUS_DARK_AFTER_SECONDS ?? '300',
    'BUS_DARK_AFTER_SECONDS',
  ),
  busCoverageShare: parseShare(process.env.BUS_COVERAGE_SHARE ?? '0.75', 'BUS_COVERAGE_SHARE'),
  busDropoutRatePerHour: parseNonNegativeNumber(
    process.env.BUS_DROPOUT_RATE_PER_HOUR ?? '1.5',
    'BUS_DROPOUT_RATE_PER_HOUR',
  ),
  busDropoutMinSeconds: parseNonNegativeNumber(
    process.env.BUS_DROPOUT_MIN_SECONDS ?? '60',
    'BUS_DROPOUT_MIN_SECONDS',
  ),
  busDropoutMaxSeconds: parseNonNegativeNumber(
    process.env.BUS_DROPOUT_MAX_SECONDS ?? '420',
    'BUS_DROPOUT_MAX_SECONDS',
  ),
  busGpsNoiseMetres: parseNonNegativeNumber(
    process.env.BUS_GPS_NOISE_METRES ?? '12',
    'BUS_GPS_NOISE_METRES',
  ),
  dutyConfirmedShare: parseShare(process.env.DUTY_CONFIRMED_SHARE ?? '0.60', 'DUTY_CONFIRMED_SHARE'),
  dutyInferredShare: parseShare(process.env.DUTY_INFERRED_SHARE ?? '0.25', 'DUTY_INFERRED_SHARE'),
  dutyUnknownShare: parseShare(process.env.DUTY_UNKNOWN_SHARE ?? '0.10', 'DUTY_UNKNOWN_SHARE'),
  dutyOutOfServiceShare: parseShare(
    process.env.DUTY_OUT_OF_SERVICE_SHARE ?? '0.05',
    'DUTY_OUT_OF_SERVICE_SHARE',
  ),
  dutyInferredConfidenceMin: parseShare(
    process.env.DUTY_INFERRED_CONFIDENCE_MIN ?? '0.55',
    'DUTY_INFERRED_CONFIDENCE_MIN',
  ),
  dutyInferredConfidenceMax: parseShare(
    process.env.DUTY_INFERRED_CONFIDENCE_MAX ?? '0.95',
    'DUTY_INFERRED_CONFIDENCE_MAX',
  ),
  dutySwapRatePerDay: parseNonNegativeNumber(
    process.env.DUTY_SWAP_RATE_PER_DAY ?? '0.15',
    'DUTY_SWAP_RATE_PER_DAY',
  ),
  geometryMaxStopOffsetMetres: parsePositiveNumber(
    process.env.GEOMETRY_MAX_STOP_OFFSET_METRES ?? '150',
    'GEOMETRY_MAX_STOP_OFFSET_METRES',
  ),
} as const

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parsePositiveNumber(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parseNonNegativeNumber(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parseShare(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parseInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parseHubCode(raw: string, name: string): string {
  const value = raw.toUpperCase()
  if (!/^[A-HJ-NP-Z]{3}$/.test(value)) {
    throw new Error(`${name} must be three letters without I or O, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parseGtfsSource(raw: string): GtfsSource {
  if (raw === 'bundled' || raw === 'path' || raw === 'url') return raw
  throw new Error(`GTFS_SOURCE must be bundled, path or url, got ${JSON.stringify(raw)}`)
}

function parseBoolean(raw: string, name: string): boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`)
}
