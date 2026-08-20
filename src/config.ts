import { resolve } from 'node:path'

export type GtfsSource = 'bundled' | 'path' | 'url'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFormat = 'json' | 'pretty'

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const validation = new Validation(env)
  const port = validation.positiveInteger('PORT', '8080')
  const host = validation.nonEmpty('HOST', '0.0.0.0')
  const publicBaseUrl = validation.url('PUBLIC_BASE_URL', `http://localhost:${port}`)
  const gtfsSource = validation.choice<GtfsSource>('GTFS_SOURCE', 'bundled', [
    'bundled',
    'path',
    'url',
  ])
  const gtfsPathRaw = validation.optional('GTFS_PATH')
  const gtfsUrl = validation.optionalUrl('GTFS_URL')
  const simTimezone = validation.timezone('SIM_TIMEZONE', 'Asia/Kolkata')
  const simClock = validation.clock('SIM_CLOCK', 'system')
  const busRoutes = validation.list('BUS_ROUTES', '500-D,500-A,G-4,335-E,401-K')
  const busSpeedKphMin = validation.positiveNumber('BUS_SPEED_KPH_MIN', '5')
  const busSpeedKphMax = validation.positiveNumber('BUS_SPEED_KPH_MAX', '45')
  const busFixIntervalSeconds = validation.positiveNumber('BUS_FIX_INTERVAL_SECONDS', '20')
  const busFixJitterSeconds = validation.nonNegativeNumber('BUS_FIX_JITTER_SECONDS', '10')
  const busStaleAfterSeconds = validation.positiveNumber('BUS_STALE_AFTER_SECONDS', '90')
  const busDarkAfterSeconds = validation.positiveNumber('BUS_DARK_AFTER_SECONDS', '300')
  const busDropoutMinSeconds = validation.nonNegativeNumber('BUS_DROPOUT_MIN_SECONDS', '60')
  const busDropoutMaxSeconds = validation.nonNegativeNumber('BUS_DROPOUT_MAX_SECONDS', '420')
  const dutyConfirmedShare = validation.share('DUTY_CONFIRMED_SHARE', '0.60')
  const dutyInferredShare = validation.share('DUTY_INFERRED_SHARE', '0.25')
  const dutyUnknownShare = validation.share('DUTY_UNKNOWN_SHARE', '0.10')
  const dutyOutOfServiceShare = validation.share('DUTY_OUT_OF_SERVICE_SHARE', '0.05')
  const dutyInferredConfidenceMin = validation.share('DUTY_INFERRED_CONFIDENCE_MIN', '0.55')
  const dutyInferredConfidenceMax = validation.share('DUTY_INFERRED_CONFIDENCE_MAX', '0.95')

  if (gtfsSource === 'path' && gtfsPathRaw === null) {
    validation.issue('GTFS_PATH is required when GTFS_SOURCE=path')
  }
  if (gtfsSource === 'url' && gtfsUrl === null) {
    validation.issue('GTFS_URL is required when GTFS_SOURCE=url')
  }
  if (busSpeedKphMin > busSpeedKphMax) {
    validation.issue('BUS_SPEED_KPH_MIN must not exceed BUS_SPEED_KPH_MAX')
  }
  if (busFixJitterSeconds >= busFixIntervalSeconds) {
    validation.issue('BUS_FIX_JITTER_SECONDS must be less than BUS_FIX_INTERVAL_SECONDS')
  }
  if (busStaleAfterSeconds >= busDarkAfterSeconds) {
    validation.issue('BUS_STALE_AFTER_SECONDS must be less than BUS_DARK_AFTER_SECONDS')
  }
  if (busDropoutMinSeconds > busDropoutMaxSeconds) {
    validation.issue('BUS_DROPOUT_MIN_SECONDS must not exceed BUS_DROPOUT_MAX_SECONDS')
  }
  const dutyShareTotal =
    dutyConfirmedShare + dutyInferredShare + dutyUnknownShare + dutyOutOfServiceShare
  if (Math.abs(dutyShareTotal - 1) > 1e-6) {
    validation.issue(
      `Duty shares must sum to 1.0; confirmed=${dutyConfirmedShare}, inferred=${dutyInferredShare}, unknown=${dutyUnknownShare}, out_of_service=${dutyOutOfServiceShare}, sum=${dutyShareTotal}`,
    )
  }
  if (dutyInferredConfidenceMin > dutyInferredConfidenceMax) {
    validation.issue('DUTY_INFERRED_CONFIDENCE_MIN must not exceed DUTY_INFERRED_CONFIDENCE_MAX')
  }

  const result = {
    port,
    host,
    publicBaseUrl,
    qrPathPrefix: validation.nonEmpty('QR_PATH_PREFIX', '/b/'),
    logLevel: validation.choice<LogLevel>('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
    logFormat: validation.choice<LogFormat>('LOG_FORMAT', 'json', ['json', 'pretty']),
    corsAllowedOrigins: validation.nonEmpty('CORS_ALLOWED_ORIGINS', '*'),
    adminToken: validation.optional('ADMIN_TOKEN'),
    requestTimeoutMs: validation.positiveInteger('REQUEST_TIMEOUT_MS', '5000'),

    simSeed: validation.integer('SIM_SEED', '1'),
    simTickMs: validation.positiveInteger('SIM_TICK_MS', '1000'),
    simTimezone,
    simClock,
    simSpeedup: validation.positiveNumber('SIM_SPEEDUP', '1'),
    simAllowTimeTravel: validation.boolean('SIM_ALLOW_TIME_TRAVEL', 'false'),

    busRoutes,
    busesPerRoute: validation.positiveInteger('BUSES_PER_ROUTE', '6'),
    busHubCode: validation.hubCode('BUS_HUB_CODE', 'BLR'),
    busHubName: 'Bengaluru Central',
    busTerminalLayoverSeconds: validation.nonNegativeNumber(
      'BUS_TERMINAL_LAYOVER_SECONDS',
      '300',
    ),
    metroLines: validation.list('METRO_LINES', 'purple,green,yellow'),
    metroTrainsPerLine: validation.optionalPositiveInteger('METRO_TRAINS_PER_LINE'),
    metroHubCode: validation.hubCode('METRO_HUB_CODE', 'MTR'),
    metroTurnaroundSeconds: validation.nonNegativeNumber('METRO_TURNAROUND_SECONDS', '240'),

    busFixIntervalSeconds,
    busFixJitterSeconds,
    busStaleAfterSeconds,
    busDarkAfterSeconds,
    busCoverageShare: validation.share('BUS_COVERAGE_SHARE', '0.75'),
    busDropoutRatePerHour: validation.nonNegativeNumber('BUS_DROPOUT_RATE_PER_HOUR', '1.5'),
    busDropoutMinSeconds,
    busDropoutMaxSeconds,
    busGpsNoiseMetres: validation.nonNegativeNumber('BUS_GPS_NOISE_METRES', '12'),
    metroFixIntervalSeconds: validation.positiveNumber('METRO_FIX_INTERVAL_SECONDS', '5'),
    metroStaleAfterSeconds: validation.positiveNumber('METRO_STALE_AFTER_SECONDS', '30'),
    metroDarkAfterSeconds: validation.positiveNumber('METRO_DARK_AFTER_SECONDS', '120'),
    metroCoverageShare: validation.share('METRO_COVERAGE_SHARE', '1.0'),
    metroDropoutRatePerHour: validation.nonNegativeNumber(
      'METRO_DROPOUT_RATE_PER_HOUR',
      '0.05',
    ),
    metroPositionNoiseMetres: validation.nonNegativeNumber(
      'METRO_POSITION_NOISE_METRES',
      '2',
    ),
    metroBlockLengthMetres: validation.positiveNumber('METRO_BLOCK_LENGTH_METRES', '200'),

    dutyConfirmedShare,
    dutyInferredShare,
    dutyUnknownShare,
    dutyOutOfServiceShare,
    dutyInferredConfidenceMin,
    dutyInferredConfidenceMax,
    dutySwapRatePerDay: validation.nonNegativeNumber('DUTY_SWAP_RATE_PER_DAY', '0.15'),
    metroDutyConfirmedShare: validation.share('METRO_DUTY_CONFIRMED_SHARE', '0.99'),
    metroDutySwapRatePerDay: validation.nonNegativeNumber('METRO_DUTY_SWAP_RATE_PER_DAY', '0'),

    busSpeedKphMean: validation.positiveNumber('BUS_SPEED_KPH_MEAN', '17'),
    busSpeedKphSd: validation.nonNegativeNumber('BUS_SPEED_KPH_SD', '4'),
    busSpeedKphMin,
    busSpeedKphMax,
    busDwellSecondsMean: validation.nonNegativeNumber('BUS_DWELL_SECONDS_MEAN', '20'),
    busDwellSecondsSd: validation.nonNegativeNumber('BUS_DWELL_SECONDS_SD', '8'),
    busPeakSpeedFactor: validation.positiveNumber('BUS_PEAK_SPEED_FACTOR', '0.7'),
    busPeakWindows: validation.peakWindows('BUS_PEAK_WINDOWS', '07:00-10:00,17:00-21:00'),
    metroCruiseKph: validation.positiveNumber('METRO_CRUISE_KPH', '60'),
    metroAccelMps2: validation.positiveNumber('METRO_ACCEL_MPS2', '1.0'),
    metroDecelMps2: validation.positiveNumber('METRO_DECEL_MPS2', '1.1'),
    metroDwellSeconds: validation.nonNegativeNumber('METRO_DWELL_SECONDS', '25'),
    metroDwellSecondsSd: validation.nonNegativeNumber('METRO_DWELL_SECONDS_SD', '4'),
    metroHeadwaySecondsPeak: validation.positiveNumber('METRO_HEADWAY_SECONDS_PEAK', '480'),
    metroHeadwaySecondsOffPeak: validation.positiveNumber(
      'METRO_HEADWAY_SECONDS_OFFPEAK',
      '720',
    ),
    metroHeadwaySecondsPeakYellow: validation.positiveNumber(
      'METRO_HEADWAY_SECONDS_PEAK__YELLOW',
      '540',
    ),
    metroHeadwaySecondsOffPeakYellow: validation.positiveNumber(
      'METRO_HEADWAY_SECONDS_OFFPEAK__YELLOW',
      '840',
    ),
    metroHeadwayJitterSeconds: validation.nonNegativeNumber(
      'METRO_HEADWAY_JITTER_SECONDS',
      '20',
    ),

    publishTripUpdates: validation.boolean('PUBLISH_TRIP_UPDATES', 'true'),
    predictionHorizonStops: validation.positiveInteger('PREDICTION_HORIZON_STOPS', '5'),
    predictionUncertaintyBaseSeconds: validation.positiveNumber(
      'PREDICTION_UNCERTAINTY_BASE_SECONDS',
      '45',
    ),
    predictionUncertaintyPerStopSeconds: validation.positiveNumber(
      'PREDICTION_UNCERTAINTY_PER_STOP_SECONDS',
      '30',
    ),
    metroPredictionUncertaintyBaseSeconds: validation.positiveNumber(
      'METRO_PREDICTION_UNCERTAINTY_BASE_SECONDS',
      '15',
    ),
    metroPredictionUncertaintyPerStopSeconds: validation.positiveNumber(
      'METRO_PREDICTION_UNCERTAINTY_PER_STOP_SECONDS',
      '5',
    ),
    tripUpdatesOmitUntracked: validation.boolean('TRIP_UPDATES_OMIT_UNTRACKED', 'false'),
    feedTtlSeconds: validation.positiveInteger('FEED_TTL_SECONDS', '15'),

    gtfsSource,
    gtfsBundlePath: resolve(validation.nonEmpty('GTFS_BUNDLE_PATH', './data/bundle')),
    gtfsPath: gtfsPathRaw === null ? null : resolve(gtfsPathRaw),
    gtfsUrl,
    gtfsCacheDir: resolve(validation.nonEmpty('GTFS_CACHE_DIR', './.cache/gtfs')),
    gtfsRepositoryUrl: 'https://github.com/Vonter/bmtc-gtfs',
    upstreamGtfsUrl:
      'https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip',
    metroTopologyPath: resolve(
      validation.nonEmpty('METRO_TOPOLOGY_PATH', './data/bundle/metro-topology.json'),
    ),
    overpassUrl: validation.url('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
    cityBbox: validation.bbox('CITY_BBOX', '12.7,77.3,13.2,77.9'),
    geometryMaxStopOffsetMetres: validation.positiveNumber(
      'GEOMETRY_MAX_STOP_OFFSET_METRES',
      '150',
    ),
    metroMaxStationGapMetres: validation.positiveNumber(
      'METRO_MAX_STATION_GAP_METRES',
      '4000',
    ),
  } as const

  validation.finish()
  return result
}

class Validation {
  readonly #issues: string[] = []
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  issue(message: string): void {
    this.#issues.push(message)
  }

  finish(): void {
    if (this.#issues.length === 0) return
    throw new Error(`Invalid configuration:\n${this.#issues.map((issue) => `- ${issue}`).join('\n')}`)
  }

  raw(name: string, fallback: string): string {
    return this.env[name] ?? fallback
  }

  optional(name: string): string | null {
    const value = this.env[name]
    return value === undefined || value === '' ? null : value
  }

  nonEmpty(name: string, fallback: string): string {
    const value = this.raw(name, fallback)
    if (value.trim() !== '') return value
    this.issue(`${name} must not be empty`)
    return fallback
  }

  number(name: string, fallback: string): number {
    const raw = this.raw(name, fallback)
    const value = Number(raw)
    if (Number.isFinite(value)) return value
    this.issue(`${name} must be a number, got ${JSON.stringify(raw)}`)
    return Number(fallback)
  }

  positiveNumber(name: string, fallback: string): number {
    const value = this.number(name, fallback)
    if (value > 0) return value
    this.issue(`${name} must be positive, got ${JSON.stringify(this.raw(name, fallback))}`)
    return Number(fallback)
  }

  nonNegativeNumber(name: string, fallback: string): number {
    const value = this.number(name, fallback)
    if (value >= 0) return value
    this.issue(`${name} must be non-negative, got ${JSON.stringify(this.raw(name, fallback))}`)
    return Number(fallback)
  }

  integer(name: string, fallback: string): number {
    const value = this.number(name, fallback)
    if (Number.isSafeInteger(value)) return value
    this.issue(`${name} must be a safe integer, got ${JSON.stringify(this.raw(name, fallback))}`)
    return Number(fallback)
  }

  positiveInteger(name: string, fallback: string): number {
    const value = this.integer(name, fallback)
    if (value > 0) return value
    this.issue(`${name} must be a positive integer, got ${JSON.stringify(this.raw(name, fallback))}`)
    return Number(fallback)
  }

  optionalPositiveInteger(name: string): number | null {
    const raw = this.optional(name)
    if (raw === null) return null
    const value = Number(raw)
    if (Number.isSafeInteger(value) && value > 0) return value
    this.issue(`${name} must be a positive integer when set, got ${JSON.stringify(raw)}`)
    return null
  }

  share(name: string, fallback: string): number {
    const value = this.number(name, fallback)
    if (value >= 0 && value <= 1) return value
    this.issue(`${name} must be between 0 and 1, got ${JSON.stringify(this.raw(name, fallback))}`)
    return Number(fallback)
  }

  boolean(name: string, fallback: 'true' | 'false'): boolean {
    const raw = this.raw(name, fallback)
    if (raw === 'true') return true
    if (raw === 'false') return false
    this.issue(`${name} must be true or false, got ${JSON.stringify(raw)}`)
    return fallback === 'true'
  }

  choice<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
    const raw = this.raw(name, fallback)
    if (choices.includes(raw as T)) return raw as T
    this.issue(`${name} must be one of ${choices.join(', ')}, got ${JSON.stringify(raw)}`)
    return fallback
  }

  list(name: string, fallback: string): readonly string[] {
    const values = this.raw(name, fallback)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (values.length > 0) return values
    this.issue(`${name} must contain at least one value`)
    return fallback.split(',')
  }

  hubCode(name: string, fallback: string): string {
    const raw = this.raw(name, fallback)
    const value = raw.toUpperCase()
    if (/^[A-HJ-NP-Z]{3}$/.test(value)) return value
    this.issue(`${name} must be three letters without I or O, got ${JSON.stringify(raw)}`)
    return fallback
  }

  url(name: string, fallback: string): string {
    const raw = this.raw(name, fallback)
    try {
      return new URL(raw).toString().replace(/\/$/, '')
    } catch {
      this.issue(`${name} must be an absolute URL, got ${JSON.stringify(raw)}`)
      return fallback
    }
  }

  optionalUrl(name: string): string | null {
    const raw = this.optional(name)
    if (raw === null) return null
    try {
      return new URL(raw).toString()
    } catch {
      this.issue(`${name} must be an absolute URL when set, got ${JSON.stringify(raw)}`)
      return null
    }
  }

  timezone(name: string, fallback: string): string {
    const raw = this.raw(name, fallback)
    try {
      new Intl.DateTimeFormat('en', { timeZone: raw }).format()
      return raw
    } catch {
      this.issue(`${name} must be an IANA time zone, got ${JSON.stringify(raw)}`)
      return fallback
    }
  }

  clock(name: string, fallback: string): string {
    const raw = this.raw(name, fallback)
    if (raw === 'system') return raw
    if (raw.startsWith('offset:') && Number.isFinite(Number(raw.slice('offset:'.length)))) return raw
    if (Number.isFinite(new Date(raw).getTime())) return raw
    this.issue(`${name} must be system, offset:<seconds>, or an RFC 3339 instant`)
    return fallback
  }

  peakWindows(name: string, fallback: string): string {
    const raw = this.raw(name, fallback)
    if (/^\d{2}:\d{2}-\d{2}:\d{2}(,\d{2}:\d{2}-\d{2}:\d{2})*$/.test(raw)) return raw
    this.issue(`${name} must be comma-separated HH:MM-HH:MM windows`)
    return fallback
  }

  bbox(name: string, fallback: string): readonly [number, number, number, number] {
    const raw = this.raw(name, fallback)
    const values = raw.split(',').map(Number)
    if (values.length === 4 && values.every(Number.isFinite)) {
      return [values[0]!, values[1]!, values[2]!, values[3]!]
    }
    this.issue(`${name} must contain south,west,north,east numeric values`)
    return fallback.split(',').map(Number) as [number, number, number, number]
  }
}

export const config = loadConfig()
