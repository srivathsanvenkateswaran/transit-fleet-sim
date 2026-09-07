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
  // September 2026 coverage expansion: every 500-series route, plus every
  // route touching the seven named east/south Bengaluru places (Kundalahalli,
  // Indiranagar, Domlur Flyover, AECS Layout Cross, Devarabisanahalli Ring
  // Road, Agara Junction, BDA Complex HSR Layout) or running from one of them
  // to Kempegowda Bus Station - see `scripts/build-bundle.ts`'s own doc
  // comment for exactly how this list was resolved against Tatak's BMTC GTFS,
  // and `data/bundle/SOURCE.md` for the bundle this filters against. Kept as
  // an overridable env default, not a hardcoded route set, for the same
  // reason `BUS_ROUTES` has always been one: a deployment that wants a
  // narrower or different slice of the feed still can.
  const busRoutes = validation.list(
    'BUS_ROUTES',
    '138,138 D6G-JBN,138 KBS-VSD-JBN,139,139 D6G-HLS-JBN,139 SBS-KFC-D6G,139 VSD-JBN,139-MRS-SBS,144-E D6G-KFC-NRG,171 KBS-SNCA,171-G KBS-SSP,201,201 D06G-DMR,201-G,201-G BEMLG-ELC,201-G BSK-BNM,201-G CSB-D06G,201-G CSB-JBN,201-G D6G-BSK,201-G KRM-BEMLF,201-G SGH-JBN,201-Q,201-Q D6G-CSB,201-R CSB-BEMLF,201-RB BSKTTMC-BTLQT,201-V,201-V CSB-RMN,223-A HAL-DBT,225-CA BEML5-HAL ARDC,252-A PSS-ISROM,290-G HSS-RKHN,293-BC,293-BC BTM-BGR,314,314 BEMLF-SBS-YHK,314 CLO-KBS-BEMLF,314 KBS-KFC-D06G,314 KBS-NGWP,314 SBS-NVP,314-B,314-B KBS-CVRNRG,314-B YBS-BEMLG,314-C,314-D,314-FA,314-FA D06G-MLP,314-H,314-H KBS-BEMLF,314-H MLP-SMH,314-P,314-T D06G-VBP,314-T RMN-VSD-KBS,314-T VSD-RMN,315-G,315-G CNS-DML,319-E,322,323,323 D41G-HAL-KMT,323 KMT-HAL-D41G,323-A,323-AB,323-AK,323-AK KBS-D41G,323-B,323-D,323-E,323-F,323-G,323-H,323-J,323-L,323-M,323-N,324,324-A,325,325 KBS-HAL-HRH,325-A,326-E,326-E KMT-KDG,327 KMT-HAL ARDC,327-A,327-B,327-C,327-E,327-FA,328,328-E,328-F,328-G,328-K,329,329-A,329-B,329-C,329-D,329-E,329-F,329-G,329-H,329-J,329-J SNBS-SNH,329-K,330-B,330-C,330-G,330-G SBS-MRHB-DDNK,330-H,330-M,330-P,331,331-A SBS-KDG,332,332-A,333 KBS-HALM-BEMLF,333-C,333-E,333-F,333-G,333-H,333-K,333-N,333-Q KBS-PTR,334 -EA SBS-HSK,334-B,334-E,334-E BRAB-BDG,334-E DBS-KDG,335-C,335-E,335-E KBS-HAL NP,335-E KDG-KVDRDO,335-E SNBS-KDG,335-G,335-G D31G-KDG,335-H,335-M,335-N KGR-KMT-ARDCHAL,336,336-A,338,340-A KBS-ADG-HSR 2nd,340-A KBS-ADG-HSRKEB,340-A STJN-HSRKEB,340-K,341-A,341-C,341-C KBS-KDRM,342,342 D42G-CPWD-VSD,342-A,342-A D42G-KMT,342-A KMT HRH,342-A KRMTTMC-SJP,342-B,342-C,342-E,342-F,342-F BEG-KBS,342-F KBS-D42G,342-F KRMTTMC-STJN-SJP,342-F SJBHS-SJP,342-F SJWA-SJP,342-G,342-H,342-H D42G-SJBHS,342-H STJN-GGSK,342-J,342-K,342-K KBS-ADK,342-L,342-M,342-MA,342-N KBS-KMS,342-P,342-P KMT-GNGP-JGH,342-Q,342-Q KMT-D42G,342-T,342-TA,342-U,342-V,342-W,342-WA,342-Y,342-Z,348-C,356-CW Fly,356-CW UFLY,401-K,411-A CSB-MVW-HALNPS,411-D,412,412 KLN-BRAB DMLR,412 KLN-BSK,412-H,412-H HBLB-ISRO,412-H ISRO-KLN,45-G KMK-KBS-BEMLF,500 BEML-MRTB-CSB,500 SNCS-GGP,500 YTTMC-HBLB-JKLO,500-A,500-A BSK-BELF,500-A D45G-BEMLF,500-A ISROM-HBL-MTK-YBS,500-A MRH-JKLO,500-A PPLO-HBLB,500-AD,500-BA,500-BA YTTMC-MTK-KRPGH,500-BC,500-BC YTTMC-MTK-CSB,500-C,500-C CSB-TCP,500-C KRPGH-BSK,500-C KRPGH-SJP,500-CA,500-CD,500-CD D42-TNF,500-CF,500-CF BSK-HSS,500-CF D41G-SJP-CKT,500-CH,500-CH D42G-TNF,500-CH DNK-BEG,500-CH SJP-HBL,500-CH SJR-KRP,500-CH TNF-ASP,500-CK,500-CS,500-CS D42G-CSB,500-D,500-D BELF-CSB,500-D BEML-TNF-CSB,500-D BSBI-CSB,500-D D10G-BTM,500-D D10G-CSB,500-D D10G-HBLB,500-D D10G-NGW-HBLB,500-D D10G-TNF-CSB,500-D GKVK-CSB,500-D HBLB-BTM,500-D JGS-CSB,500-D KRPRLY-SNCS,500-D MRHB-HBL-PSS,500-DC D32 SRYN-HBLB,500-DC D38G-BELF,500-DG,500-DH HSRCPWD-ATB,500-DJ,500-DM YBS-HBL-ELCW,500-DP DNK-GGP,500-EB,500-EB ELC-HBL,500-EB ELCW-WTF-KDG,500-EB NJP-TNF,500-EB SMVR-ELCW,500-F,500-FB,500-FB CSB-HSK,500-HC,500-HC HBLB-WTTMC,500-HG,500-HG HSK-BELF,500-HK,500-J,500-L,500-L BSK-KRPGH,500-L BSK-TNF-D6G,500-L BSK-TNF-KRPGH,500-L CSB-BEML,500-LA,500-Q,500-Q D10G-TNF-KRPGH,500-Q MDR-CJP,500-QA,500-QA YTTMC-GGP-KRPGH,500-QB,500-QD,500-QD YBS-CSB,500-QG,500-QG KRPGH-BELF,500-QG PSB-GGP-KRP,500-QG PTH-HBL-KRPGH,500-QK,500-QK BBD-KDG,500-QN,500-QP,500-TA,501-CD,501-CD DPJN-NDH-CSB,503-A,503-A VRP-BSK,505 TNF-KKH-VRK,506,BEML-BGR,BEML5-BEMLG,CHAKRA-16,CHAKRA-16A,D06G-MNK,D06G-MRS,D25-HSRBDA,D25G-HSRBDA,D6G-CVRN,D6G-SOQ,G-2,G-2 ATO-SJP,G-2 CHM-SJP,G-2 D06G-JN SJP,G-2 KBS-MYH-SJP,G-2 SBS-SJP,G-2 SJP-KVS,G-4,HSR FDR-1,HSR FDR-1A,IMD-CSB,K-3,KBS-1I,KBS-1I BEMLF-KDG,KBS-1I D06G-LIDO-KDG,KBS-1K,KBS-1K KBS-D41G,KBS-1K KBS-VSD-D41G,KIA-10,KIA-15,KIA-15A,KIA-4,KIA-4A,KIA-7,KIA-7A,KIA-7A D25G-KIA,KIA-8,KIA-8A,KIA-8C,KIA-8D,KIA-8E,KIA-8EW,KIA-8H,KIA-9,KRM-BEMLG,KRM-CPWD,MBS-6 YST-CVRN,MF-1F,MF-1F D6G-RMN,MF-22E,MF-22E KRMTTMC-HRMS,MF-22EA,MF-22ET D38G-TNF,MF-3,MF-3A,MF-4A,MF-5,MF-5 SMVT-BSK,MF-6,MF-6 D06G-CSB,MF-6 JBN-SVMS,MF-9 MRH-D24G,SBS-1K,SBS-1K SBS-D41G,SBS-HAL-BEMLG,V-331A,V-333E,V-335E,V-342F,V-342F D25G-KBS,V-500A,V-500A D13G-BSK-HBL,V-500BC,V-500CA,V-500CA KMK-BSK-ITPL,V-500CK,V-500D,V-500DP,V-500E,V-500E ELCKIA-HBLB,V-500F,V-500FA,V-500HS,V-500L,V-505 ELCW-KDG FLY,V-DIVYA DARSHANA-1B,V-MF1C,V-MF1C BSK-KRPMS,V-MF1D,V-MF1D ELC-KRPMS,V-MF6,VW-226HSR,WTTMC-KDLG-VRTKD',
  )
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
  // docs/intercity-coaches.md §12.2-§12.8. Every one of these is read only
  // when `INTERCITY_CORRIDORS` is set; they are parsed unconditionally so a
  // typo fails startup rather than waiting for the first coach.
  const intercityStaleAfterSeconds = validation.positiveNumber('INTERCITY_STALE_AFTER_SECONDS', '180')
  const intercityDarkAfterSeconds = validation.positiveNumber('INTERCITY_DARK_AFTER_SECONDS', '600')
  const intercityFixIntervalSeconds = validation.positiveNumber('INTERCITY_FIX_INTERVAL_SECONDS', '30')
  const intercityFixIntervalStationarySeconds = validation.positiveNumber(
    'INTERCITY_FIX_INTERVAL_STATIONARY_SECONDS',
    '120',
  )
  const intercityFixJitterSeconds = validation.nonNegativeNumber('INTERCITY_FIX_JITTER_SECONDS', '8')
  const intercityCoverageShareReserved = validation.share('INTERCITY_COVERAGE_SHARE__RESERVED', '0.92')
  const intercityCoverageShareOrdinary = validation.share('INTERCITY_COVERAGE_SHARE__ORDINARY', '0.70')
  const intercityCruiseKphMin = validation.positiveNumber('INTERCITY_CRUISE_KPH_MIN', '30')
  const intercityCruiseKphMax = validation.positiveNumber('INTERCITY_CRUISE_KPH_MAX', '85')
  const intercityDutyConfirmedShare = validation.share('INTERCITY_DUTY_CONFIRMED_SHARE', '0.80')
  const intercityDutyInferredShare = validation.share('INTERCITY_DUTY_INFERRED_SHARE', '0.15')
  const intercityDutyUnknownShare = validation.share('INTERCITY_DUTY_UNKNOWN_SHARE', '0.03')
  const intercityDutyOutOfServiceShare = validation.share('INTERCITY_DUTY_OUT_OF_SERVICE_SHARE', '0.02')

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
  if (intercityStaleAfterSeconds >= intercityDarkAfterSeconds) {
    validation.issue('INTERCITY_STALE_AFTER_SECONDS must be less than INTERCITY_DARK_AFTER_SECONDS')
  }
  if (intercityFixJitterSeconds >= intercityFixIntervalSeconds) {
    validation.issue('INTERCITY_FIX_JITTER_SECONDS must be less than INTERCITY_FIX_INTERVAL_SECONDS')
  }
  if (intercityFixIntervalStationarySeconds < intercityFixIntervalSeconds) {
    validation.issue(
      'INTERCITY_FIX_INTERVAL_STATIONARY_SECONDS must not be shorter than INTERCITY_FIX_INTERVAL_SECONDS',
    )
  }
  if (intercityCruiseKphMin > intercityCruiseKphMax) {
    validation.issue('INTERCITY_CRUISE_KPH_MIN must not exceed INTERCITY_CRUISE_KPH_MAX')
  }
  // §12.5: the four intercity duty shares must sum to 1.0 within 1e-6 or
  // startup fails, naming all four and the sum - the same rule the bus shares
  // already carry, restated because these are a separate set with separate
  // defaults (confirmed 0.80 against the bus's 0.60).
  const intercityDutyShareTotal =
    intercityDutyConfirmedShare +
    intercityDutyInferredShare +
    intercityDutyUnknownShare +
    intercityDutyOutOfServiceShare
  if (Math.abs(intercityDutyShareTotal - 1) > 1e-6) {
    validation.issue(
      `Intercity duty shares must sum to 1.0; confirmed=${intercityDutyConfirmedShare}, inferred=${intercityDutyInferredShare}, unknown=${intercityDutyUnknownShare}, out_of_service=${intercityDutyOutOfServiceShare}, sum=${intercityDutyShareTotal}`,
    )
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
    // `computeRouteRosterSizes` (src/sim/busRoster.ts) replaces this flat
    // count with a per-route figure read off each route's own real GTFS
    // trips - a minimum-vehicles-to-cover-the-timetable computation, not a
    // guess. `busesPerRoute` above still applies wherever that computation
    // cannot run (a caller that builds a fleet without loading GTFS first),
    // so nothing here removes the flat knob, only adds a better default path
    // on top of it. `busRosterScale` is the one dial on the result: a route
    // whose honest minimum is, say, four vehicles becomes eight at scale 2 or
    // two at scale 0.5, always still floored at `busRosterMinPerRoute`.
    busRosterScale: validation.positiveNumber('BUS_ROSTER_SCALE', '1'),
    busRosterMinPerRoute: validation.positiveInteger('BUS_ROSTER_MIN_PER_ROUTE', '1'),
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
    busSeatedCapacity: validation.positiveInteger('BUS_SEATED_CAPACITY', '42'),
    busStandingCapacity: validation.nonNegativeNumber('BUS_STANDING_CAPACITY', '38'),
    busAirportSeatedCapacity: validation.positiveInteger('BUS_AIRPORT_SEATED_CAPACITY', '45'),
    busAirportStandingCapacity: validation.nonNegativeNumber('BUS_AIRPORT_STANDING_CAPACITY', '8'),
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
    osmApiBaseUrl: validation.url('OSM_API_BASE_URL', 'https://api.openstreetmap.org/api/0.6'),
    cityBbox: validation.bbox('CITY_BBOX', '12.7,77.3,13.2,77.9'),
    geometryMaxStopOffsetMetres: validation.positiveNumber(
      'GEOMETRY_MAX_STOP_OFFSET_METRES',
      '150',
    ),
    metroMaxStationGapMetres: validation.positiveNumber(
      'METRO_MAX_STATION_GAP_METRES',
      '4000',
    ),

    // docs/intercity-coaches.md §12.1. Unset means no coaches at all (§14.1) -
    // this is the one config surface built in this pass whose entire job is
    // to stay off by default, because the consuming app's client rejects an
    // unknown vehicle class until it is released separately from this one.
    intercityCorridors: validation.optionalList('INTERCITY_CORRIDORS'),
    intercityTopologyPath: resolve(
      validation.nonEmpty('INTERCITY_TOPOLOGY_PATH', './data/bundle/corridor-topology.json'),
    ),
    // BJP, BDM, BGK and KWR added alongside the bidirectional-roster coverage
    // pass: a `reverse` departure on BNG-BJP, BNG-BDM, BNG-BGK or MNG-KWR
    // originates at the corridor's other end, which needed its own hub - see
    // FIXTURE_HUBS in src/fleet/corporation.ts.
    intercityHubCodes: validation.hubCodeList(
      'INTERCITY_HUB_CODES',
      'KBS,MYS,MDK,HUB,HSP,MNG,CKM,UDP,DND,BJP,BDM,BGK,KWR',
    ),
    intercityServiceClasses: validation.list(
      'INTERCITY_SERVICE_CLASSES',
      'karnataka_sarige,rajahamsa_executive,airavat,airavat_club_class,ambaari_utsav,pallakki',
    ),
    intercityRosterPath: resolve(
      validation.nonEmpty('INTERCITY_ROSTER_PATH', './data/bundle/corridor-roster.json'),
    ),
    // §12.1: service days held at once. Must be at least 2 for a duty that
    // crosses midnight - a window of one day cannot contain both the service
    // date a coach departed on and the calendar day it arrives on.
    intercityRosterDays: validation.rosterDays('INTERCITY_ROSTER_DAYS', '3'),
    intercityAssignmentHorizonHours: validation.positiveNumber(
      'INTERCITY_ASSIGNMENT_HORIZON_HOURS',
      '36',
    ),

    // §12.2
    intercityCoverageShareReserved,
    intercityCoverageShareOrdinary,
    intercityFixIntervalSeconds,
    intercityFixIntervalStationarySeconds,
    intercityFixJitterSeconds,
    intercityStaleAfterSeconds,
    intercityDarkAfterSeconds,
    intercityGpsNoiseMetres: validation.nonNegativeNumber('INTERCITY_GPS_NOISE_METRES', '12'),

    // §12.3. The four zone-placement variables are deliberately absent: §12.3
    // marks them "Build-time; the zones are written into the topology", and
    // `scripts/build-corridors.ts` carries them as its own constants. A
    // runtime knob for them would let a deployment move a dead zone that is
    // already committed to a geometry file and validated by the gate.
    intercityDeadZoneUncertaintyMultiplier: validation.positiveNumber(
      'INTERCITY_DEAD_ZONE_UNCERTAINTY_MULTIPLIER',
      '2.5',
    ),
    intercityUrbanDropoutRatePerHour: validation.nonNegativeNumber(
      'INTERCITY_URBAN_DROPOUT_RATE_PER_HOUR',
      '1.5',
    ),

    // §12.4
    intercityBoardingSecondsMean: validation.nonNegativeNumber('INTERCITY_BOARDING_SECONDS_MEAN', '180'),
    intercityBoardingSecondsSd: validation.positiveNumber('INTERCITY_BOARDING_SECONDS_SD', '60'),
    intercityStandSecondsMean: validation.nonNegativeNumber('INTERCITY_STAND_SECONDS_MEAN', '420'),
    intercityStandSecondsSd: validation.positiveNumber('INTERCITY_STAND_SECONDS_SD', '180'),
    intercityHaltSecondsMean: validation.nonNegativeNumber('INTERCITY_HALT_SECONDS_MEAN', '1800'),
    intercityHaltSecondsSd: validation.positiveNumber('INTERCITY_HALT_SECONDS_SD', '420'),
    intercityCrewChangeSecondsMean: validation.nonNegativeNumber(
      'INTERCITY_CREW_CHANGE_SECONDS_MEAN',
      '420',
    ),
    intercityCrewChangeSecondsSd: validation.positiveNumber('INTERCITY_CREW_CHANGE_SECONDS_SD', '120'),

    // §12.5
    intercityDutyConfirmedShare,
    intercityDutyInferredShare,
    intercityDutyUnknownShare,
    intercityDutyOutOfServiceShare,
    intercityVehicleSubstitutionRatePerDuty: validation.share(
      'INTERCITY_VEHICLE_SUBSTITUTION_RATE_PER_DUTY',
      '0.06',
    ),

    // §12.6
    intercityCruiseKphMean: validation.positiveNumber('INTERCITY_CRUISE_KPH_MEAN', '62'),
    intercityCruiseKphSd: validation.nonNegativeNumber('INTERCITY_CRUISE_KPH_SD', '8'),
    intercityCruiseKphMin,
    intercityCruiseKphMax,
    intercityUrbanKphMean: validation.positiveNumber('INTERCITY_URBAN_KPH_MEAN', '17'),
    intercityUrbanKphSd: validation.nonNegativeNumber('INTERCITY_URBAN_KPH_SD', '4'),

    // §12.7
    intercityUncertaintyBaseSeconds: validation.positiveNumber(
      'INTERCITY_UNCERTAINTY_BASE_SECONDS',
      '120',
    ),
    intercityUncertaintyPerHighwayKmSeconds: validation.positiveNumber(
      'INTERCITY_UNCERTAINTY_PER_HIGHWAY_KM_SECONDS',
      '1.5',
    ),
    intercityUncertaintyPerHaltSeconds: validation.positiveNumber(
      'INTERCITY_UNCERTAINTY_PER_HALT_SECONDS',
      '420',
    ),
    intercityUncertaintyUrbanApproachSeconds: validation.nonNegativeNumber(
      'INTERCITY_UNCERTAINTY_URBAN_APPROACH_SECONDS',
      '600',
    ),
    intercityPredictionHorizonSeconds: validation.positiveInteger(
      'INTERCITY_PREDICTION_HORIZON_SECONDS',
      '21600',
    ),
    intercitySuggestedPollSeconds: validation.positiveInteger('INTERCITY_SUGGESTED_POLL_SECONDS', '120'),

    // §12.8. `MANIFEST_TOKEN` is deliberately a different credential from
    // `ADMIN_TOKEN` (§10.5): the BPP is a peer service, not an operator of
    // this one, and one shared credential would let a ticketing platform
    // force a coach dark. Unset means `404`, not `401`.
    manifestToken: validation.optional('MANIFEST_TOKEN'),
    intercityManifestMaxAgeSeconds: validation.positiveInteger(
      'INTERCITY_MANIFEST_MAX_AGE_SECONDS',
      '3600',
    ),
    intercityManifestTtlMaxSeconds: validation.positiveInteger(
      'INTERCITY_MANIFEST_TTL_MAX_SECONDS',
      '86400',
    ),
    intercityProgressLogMaxEntries: validation.positiveInteger(
      'INTERCITY_PROGRESS_LOG_MAX_ENTRIES',
      '40',
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

  /**
   * §14.1: unset means the feature is off, which `list()` cannot express -
   * it requires at least one value and falls back to a non-empty default
   * when the variable is missing. `INTERCITY_CORRIDORS` unset must mean "no
   * coaches at all", so an empty list is the valid, default answer here.
   */
  optionalList(name: string): readonly string[] {
    const raw = this.optional(name)
    if (raw === null) return []
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }

  /**
   * §12.1: "Must be at least 2 for a duty that crosses midnight." A one-day
   * roster window cannot hold both the service date a coach departed on and
   * the calendar day it arrives on, so a coach dispatched at 22:59 would fall
   * out of the roster at midnight while still on the road.
   */
  rosterDays(name: string, fallback: string): number {
    const value = this.integer(name, fallback)
    if (Number.isSafeInteger(value) && value >= 2) return value
    this.issue(
      `${name} must be an integer of at least 2 (a cross-midnight duty needs two service days), got ${JSON.stringify(this.raw(name, fallback))}`,
    )
    return Number(fallback)
  }

  /** §2.3/§12.1: a comma-separated list of three-letter hub codes, none containing I or O. */
  hubCodeList(name: string, fallback: string): readonly string[] {
    const values = this.list(name, fallback)
    const bad = values.filter((value) => !/^[A-HJ-NP-Z]{3}$/.test(value.toUpperCase()))
    if (bad.length > 0) {
      this.issue(`${name} must list three-letter hub codes without I or O; invalid: ${bad.join(', ')}`)
      return fallback.split(',')
    }
    return values.map((value) => value.toUpperCase())
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
    const windows = raw.split(',')
    if (
      windows.length > 0 &&
      windows.every((window) => {
        const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window)
        if (match === null) return false
        const [, startHour, startMinute, endHour, endMinute] = match
        const start = Number(startHour) * 60 + Number(startMinute)
        const end = Number(endHour) * 60 + Number(endMinute)
        return (
          Number(startHour) < 24 &&
          Number(endHour) < 24 &&
          Number(startMinute) < 60 &&
          Number(endMinute) < 60 &&
          start < end
        )
      })
    ) return raw
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
