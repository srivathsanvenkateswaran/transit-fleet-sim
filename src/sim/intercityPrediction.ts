import type { Corridor, StandKind } from '../geometry/corridorTopology.js'
import type { StopRef } from '../world/port.js'
import { entersUrban, haltsRemaining, highwayKmBetween, type CoachCursor } from './coachCursor.js'

/**
 * Highway prediction - docs/intercity-coaches.md §5.
 *
 * The city band is `base + perStop * n` because in city traffic the number of
 * stops is a decent proxy for the number of independent delay events. On a
 * highway that proxy fails in both directions: 90 km of divided carriageway
 * between Tumakuru and Chitradurga has genuinely low variance and counts as
 * "one stop", while the meal halt at Hiriyur is also one stop and carries
 * more variance on its own than the previous 90 km of driving.
 *
 * So the band gets terms for the things that actually vary, in descending
 * order of contribution: the discretionary halt, the urban approach into a
 * destination city at Bengaluru's measured ~17 km/h, and highway running
 * time, which is real but small.
 *
 * The result is the claim §0 makes: **a four-hour highway prediction is
 * proportionally tighter than a ten-minute city one.** A coach at
 * Chitradurga predicting Hosapete, 190 km and one halt away, gets
 * `120 + 1.5*190 + 420 = 825 s` on a three-hour horizon - about 8 per cent -
 * against the city model's `45 + 30*5 = 195 s` on a ten-minute horizon, which
 * is a third of the prediction.
 *
 * §17.2 keeps the caveat the city model already carries: linear in remaining
 * kilometres and in remaining halts, uncalibrated against any real run-time
 * distribution, and honest in kind while wrong in shape. **A consuming app
 * must not tune a threshold to these numbers.**
 */

export interface IntercityPredictionProfile {
  readonly baseSeconds: number
  readonly perHighwayKmSeconds: number
  readonly perHaltSeconds: number
  readonly urbanApproachSeconds: number
  /** §5.4: a horizon in time, not in stops. Six hours by default. */
  readonly horizonSeconds: number
  /** §10.8: applied to the band while inside an authored dead zone. */
  readonly deadZoneMultiplier: number
  /** Nominal running speeds, by segment kind, for the travel-time model. */
  readonly highwayKph: number
  readonly urbanKph: number
  readonly dwellSecondsMeanByKind: Readonly<Record<StandKind, number>>
}

export interface IntercityPrediction {
  readonly stop: StopRef
  readonly seconds: number
  readonly uncertaintySeconds: number
  /** §5.4: beyond the horizon the feed says `NO_DATA` rather than guessing. */
  readonly beyondHorizon: boolean
}

export interface BandTerms {
  readonly remainingHighwayKm: number
  readonly haltsRemaining: number
  readonly urbanApproach: boolean
  readonly insideDeadZone: boolean
}

/**
 * The band, and nothing else. Kept as a pure function of its four terms so
 * criterion 78 can assert it against the configuration rather than against
 * literals - which is the criterion that removes `predictNextStops`'s
 * hardcoded `45 + index * 30`.
 */
export function intercityUncertaintySeconds(
  profile: IntercityPredictionProfile,
  terms: BandTerms,
): number {
  const band =
    profile.baseSeconds +
    profile.perHighwayKmSeconds * terms.remainingHighwayKm +
    profile.perHaltSeconds * terms.haltsRemaining +
    (terms.urbanApproach ? profile.urbanApproachSeconds : 0)
  return Math.round(terms.insideDeadZone ? band * profile.deadZoneMultiplier : band)
}

/**
 * The remaining stands, each with a predicted arrival and its band.
 *
 * The travel-time model runs on the **nominal** per-segment speeds and dwell
 * means, not on the cursor's own drawn values. That is a deliberate choice
 * about what kind of prediction this is: a model that read the coach's actual
 * drawn speed for the next 190 km would be reading the ground truth the
 * simulator generated, and §17.2 already flags prediction skill as the place
 * this simulator cannot be wrong the way a real one is. The one actual fact
 * it does use is the remaining time on a dwell that is happening now, which
 * is a published observation rather than a peek at the future.
 */
export function predictIntercityStands(
  corridor: Corridor,
  cursor: CoachCursor,
  at: Date,
  profile: IntercityPredictionProfile,
  insideDeadZone: boolean,
): readonly IntercityPrediction[] {
  if (cursor.arrivedAtMs !== null) return []
  const predictions: IntercityPrediction[] = []
  let seconds =
    cursor.dwell === null ? 0 : Math.max(0, (cursor.dwell.endsAtMs - at.getTime()) / 1_000)
  let fromMetres = cursor.distanceMetres

  for (let index = cursor.nextStandIndex; index < corridor.stands.length; index += 1) {
    const stand = corridor.stands[index]!
    const previous = corridor.stands[index - 1]!
    // `fromMetres` starts at the cursor's own position, so the first leg is
    // the part of the current segment still ahead of the coach rather than
    // the whole segment it is halfway down.
    const legMetres = Math.max(0, stand.distanceMetres - fromMetres)
    const kph = segmentKphBetween(corridor, previous.id, stand.id, profile)
    seconds += (legMetres / 1_000 / kph) * 3_600
    predictions.push({
      stop: {
        id: stand.id,
        name: stand.name,
        nameLocal: stand.nameLocal,
        sequence: index + 1,
      },
      seconds: Math.round(seconds),
      uncertaintySeconds: intercityUncertaintySeconds(profile, {
        remainingHighwayKm: highwayKmBetween(corridor, cursor.distanceMetres, stand.distanceMetres),
        haltsRemaining: haltsRemaining(corridor, cursor.distanceMetres, stand.distanceMetres),
        urbanApproach: entersUrban(corridor, cursor.distanceMetres, stand.distanceMetres),
        insideDeadZone,
      }),
      beyondHorizon: seconds > profile.horizonSeconds,
    })
    if (stand.kind !== 'terminal') seconds += profile.dwellSecondsMeanByKind[stand.kind]
    fromMetres = stand.distanceMetres
  }
  return predictions
}

function segmentKphBetween(
  corridor: Corridor,
  fromStandId: string,
  toStandId: string,
  profile: IntercityPredictionProfile,
): number {
  const segment = corridor.segments.find(
    (candidate) => candidate.fromStandId === fromStandId && candidate.toStandId === toStandId,
  )
  return segment?.kind === 'urban' ? profile.urbanKph : profile.highwayKph
}
