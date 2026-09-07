import { config } from '../config.js'
import type { StandKind } from '../geometry/corridorTopology.js'
import type { CoachWorldProfiles } from './coachWorld.js'
import type { ScheduleProfile } from './corridorRoster.js'
import { defaultBusOccupancyProfile } from './occupancy.js'

/**
 * Every intercity parameter, read from `src/config.ts` in one place.
 *
 * The same relationship `defaultBusMotionProfile` and `defaultBusDeviceProfile`
 * have to the bus model: the simulation modules take a profile object and
 * never reach for `config` themselves, so a test can drive them at any values
 * it likes and the running service reads the environment exactly once.
 */

const dwellMeanByKind: Readonly<Record<StandKind, number>> = {
  boarding: config.intercityBoardingSecondsMean,
  stand: config.intercityStandSecondsMean,
  meal_halt: config.intercityHaltSecondsMean,
  crew_change: config.intercityCrewChangeSecondsMean,
  // §4.1: a terminal has no dwell of its own - the run ends there.
  terminal: 0,
}

const dwellSdByKind: Readonly<Record<StandKind, number>> = {
  boarding: config.intercityBoardingSecondsSd,
  stand: config.intercityStandSecondsSd,
  meal_halt: config.intercityHaltSecondsSd,
  crew_change: config.intercityCrewChangeSecondsSd,
  terminal: 1,
}

export const defaultScheduleProfile: ScheduleProfile = {
  timezone: config.simTimezone,
  highwayKph: config.intercityCruiseKphMean,
  urbanKph: config.intercityUrbanKphMean,
  dwellSecondsByKind: dwellMeanByKind,
}

export const defaultCoachProfiles: CoachWorldProfiles = {
  seed: config.simSeed,
  timezone: config.simTimezone,
  motion: {
    seed: config.simSeed,
    highwayKphMean: config.intercityCruiseKphMean,
    highwayKphSd: config.intercityCruiseKphSd,
    highwayKphMin: config.intercityCruiseKphMin,
    highwayKphMax: config.intercityCruiseKphMax,
    urbanKphMean: config.intercityUrbanKphMean,
    urbanKphSd: config.intercityUrbanKphSd,
    dwellSecondsMeanByKind: dwellMeanByKind,
    dwellSecondsSdByKind: dwellSdByKind,
  },
  device: {
    seed: config.simSeed,
    coverageShareReserved: config.intercityCoverageShareReserved,
    coverageShareOrdinary: config.intercityCoverageShareOrdinary,
    fixIntervalSeconds: config.intercityFixIntervalSeconds,
    fixIntervalStationarySeconds: config.intercityFixIntervalStationarySeconds,
    fixJitterSeconds: config.intercityFixJitterSeconds,
    staleAfterSeconds: config.intercityStaleAfterSeconds,
    darkAfterSeconds: config.intercityDarkAfterSeconds,
    gpsNoiseMetres: config.intercityGpsNoiseMetres,
    urbanDropoutRatePerHour: config.intercityUrbanDropoutRatePerHour,
    // §6.3: the urban process is the city one, unmodified, on the urban
    // segments only - so it takes the city's own duration bounds rather than
    // a second pair of variables that would drift from them.
    urbanDropoutMinSeconds: config.busDropoutMinSeconds,
    urbanDropoutMaxSeconds: config.busDropoutMaxSeconds,
  },
  duty: {
    seed: config.simSeed,
    confirmedShare: config.intercityDutyConfirmedShare,
    inferredShare: config.intercityDutyInferredShare,
    unknownShare: config.intercityDutyUnknownShare,
    outOfServiceShare: config.intercityDutyOutOfServiceShare,
    inferredConfidenceMin: config.dutyInferredConfidenceMin,
    inferredConfidenceMax: config.dutyInferredConfidenceMax,
    // §12.5: fixed at zero and not configurable upward. A coach 200 km from
    // the nearest depot cannot be reassigned to another block mid-run.
    swapRatePerDay: 0,
  },
  prediction: {
    baseSeconds: config.intercityUncertaintyBaseSeconds,
    perHighwayKmSeconds: config.intercityUncertaintyPerHighwayKmSeconds,
    perHaltSeconds: config.intercityUncertaintyPerHaltSeconds,
    urbanApproachSeconds: config.intercityUncertaintyUrbanApproachSeconds,
    horizonSeconds: config.intercityPredictionHorizonSeconds,
    deadZoneMultiplier: config.intercityDeadZoneUncertaintyMultiplier,
    highwayKph: config.intercityCruiseKphMean,
    urbanKph: config.intercityUrbanKphMean,
    dwellSecondsMeanByKind: dwellMeanByKind,
  },
  occupancy: defaultBusOccupancyProfile,
  manifest: {
    maxAgeSeconds: config.intercityManifestMaxAgeSeconds,
    ttlMaxSeconds: config.intercityManifestTtlMaxSeconds,
  },
  schedule: defaultScheduleProfile,
  rosterDays: config.intercityRosterDays,
  assignmentHorizonHours: config.intercityAssignmentHorizonHours,
  substitutionRatePerDuty: config.intercityVehicleSubstitutionRatePerDuty,
  progressLogMaxEntries: config.intercityProgressLogMaxEntries,
}
