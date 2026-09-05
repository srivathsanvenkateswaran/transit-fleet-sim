import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import { entersUrban, haltsRemaining, highwayKmBetween } from '../../src/sim/coachCursor.js'
import { intercityUncertaintySeconds } from '../../src/sim/intercityPrediction.js'
import { binFor, coachHarness, pallakkiDuty, sarigeDuty } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §5: highway prediction, and the band that changes
 * shape.
 *
 * The claim under test is §0's: **a four-hour highway prediction is
 * proportionally tighter than a ten-minute city one**, which the stop-count
 * model reparameterised would have inverted. §17.2's caveat is unchanged and
 * is the reason none of these tests asserts that a prediction is *accurate*:
 * the band is linear in remaining kilometres and in remaining halts,
 * uncalibrated against any real run-time distribution, and a consuming app
 * must not tune a threshold to it.
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')
const PROFILE = defaultCoachProfiles.prediction

describe('the intercity prediction band (§5)', () => {
  it('criterion 78: the band is base + perKm * km + perHalt * halts + urbanApproach, from the config', () => {
    // Asserted against the configuration rather than against literals. This
    // is the criterion that removes `predictNextStops`'s hardcoded
    // `45 + index * 30`, which read no configuration at all and happened to
    // equal the defaults - which is exactly why nobody noticed.
    expect(
      intercityUncertaintySeconds(PROFILE, {
        remainingHighwayKm: 190,
        haltsRemaining: 1,
        urbanApproach: false,
        insideDeadZone: false,
      }),
    ).toBe(
      Math.round(
        config.intercityUncertaintyBaseSeconds +
          config.intercityUncertaintyPerHighwayKmSeconds * 190 +
          config.intercityUncertaintyPerHaltSeconds * 1,
      ),
    )
    // §5.3's worked example: a coach at Chitradurga at 02:00 predicting
    // Hosapete, 190 km and one halt away with no city at the far end.
    expect(
      intercityUncertaintySeconds(PROFILE, {
        remainingHighwayKm: 190,
        haltsRemaining: 1,
        urbanApproach: false,
        insideDeadZone: false,
      }),
    ).toBe(825)
    // The urban approach is a single, large, one-off contribution.
    expect(
      intercityUncertaintySeconds(PROFILE, {
        remainingHighwayKm: 190,
        haltsRemaining: 1,
        urbanApproach: true,
        insideDeadZone: false,
      }),
    ).toBe(825 + config.intercityUncertaintyUrbanApproachSeconds)
  })

  it('a four-hour highway prediction is proportionally tighter than the city model at five stops', () => {
    // The claim §0 makes, as arithmetic. 825 s on a three-hour horizon is
    // about 8 per cent; the city model's fifth stop is 195 s on a horizon of
    // perhaps ten minutes, which is a third of the prediction.
    const highway = 825 / (3 * 3_600)
    const city =
      (config.predictionUncertaintyBaseSeconds + config.predictionUncertaintyPerStopSeconds * 5) /
      600
    expect(highway).toBeLessThan(city)
  })

  it('§10.8: the dead-zone multiplier widens the band and nothing else', () => {
    const clear = intercityUncertaintySeconds(PROFILE, {
      remainingHighwayKm: 40,
      haltsRemaining: 0,
      urbanApproach: false,
      insideDeadZone: false,
    })
    const inZone = intercityUncertaintySeconds(PROFILE, {
      remainingHighwayKm: 40,
      haltsRemaining: 0,
      urbanApproach: false,
      insideDeadZone: true,
    })
    expect(inZone).toBe(Math.round(clear * config.intercityDeadZoneUncertaintyMultiplier))
  })

  it('criterion 77: every predicted arrival carries a band, never omitted and never zero, over a full-day sweep', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    let predictions = 0
    for (const duty of simulation.duties) {
      const bin = binFor(simulation, duty.id)
      for (let minute = 0; minute <= 600; minute += 3) {
        const at = new Date(duty.departureAt.getTime() + minute * 60_000)
        for (const prediction of simulation.predictNextStops(bin, at, 100)) {
          predictions += 1
          expect(Number.isFinite(prediction.uncertaintySeconds)).toBe(true)
          expect(prediction.uncertaintySeconds).toBeGreaterThan(0)
        }
      }
    }
    expect(predictions).toBeGreaterThan(1_000)
  })

  it('criterion 80: the band is non-decreasing along a trip’s stop list at a single instant', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    let checked = 0
    for (const duty of simulation.duties) {
      const bin = binFor(simulation, duty.id)
      for (let minute = 0; minute <= 600; minute += 7) {
        const at = new Date(duty.departureAt.getTime() + minute * 60_000)
        const stops = simulation.predictNextStops(bin, at, 100)
        for (let index = 1; index < stops.length; index += 1) {
          expect(stops[index]!.uncertaintySeconds).toBeGreaterThanOrEqual(
            stops[index - 1]!.uncertaintySeconds,
          )
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('criterion 79: for a fixed stand within one run the band is non-increasing between successive observations', async () => {
    // "A rider watching the Hosapete estimate firm up from plus or minus 23
    // minutes at Tumakuru to 14 at Chitradurga to 4 at Kudligi is watching the
    // model behave, and a violation means something is reading the wrong
    // cursor."
    //
    // The one thing that can raise it is §10.8's dead-zone multiplier, which
    // is a deliberate, published widening of a band while the coach is inside
    // an authored zone. So the invariant is asserted over the samples where
    // that multiplier's state is unchanged, which is the whole run apart from
    // the two edges of each zone. The multiplier's own effect is tested
    // above, against the configuration, rather than being allowed to hide a
    // real regression here.
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 1, coverageShareOrdinary: 1 },
    })
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const previousByStand = new Map<string, { band: number; inZone: boolean }>()
    let compared = 0
    for (let minute = 0; minute <= 600; minute += 1) {
      const at = new Date(duty.departureAt.getTime() + minute * 60_000)
      const inZone = simulation.runSnapshot(duty, at).insideDeadZone
      for (const prediction of simulation.predictNextStops(bin, at, 100)) {
        const previous = previousByStand.get(prediction.stop.id)
        if (previous !== undefined && previous.inZone === inZone) {
          expect(prediction.uncertaintySeconds).toBeLessThanOrEqual(previous.band)
          compared += 1
        }
        previousByStand.set(prediction.stop.id, { band: prediction.uncertaintySeconds, inZone })
      }
    }
    expect(compared).toBeGreaterThan(500)
  })

  it('criterion 81: stands beyond the six-hour horizon are NO_DATA with no arrival, and the destination inside it is predicted', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 1, coverageShareOrdinary: 1 },
    })
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    // Just after departure the whole 417 km run is inside a six-hour horizon
    // only in part, so both arms are exercised on one trip.
    const early = simulation.scheduleUpdates(bin, new Date(duty.departureAt.getTime() + 60_000))
    expect(early.length).toBeGreaterThan(4)
    for (const update of early) {
      if (update.seconds === null) expect(update.uncertaintySeconds).toBeNull()
      else expect(update.uncertaintySeconds).toBeGreaterThan(0)
    }
    expect(early.some((update) => update.seconds === null)).toBe(true)

    // §5.4's point: six hours is chosen so a coach dispatched at 22:59 can
    // predict its arrival from about 00:30, which is the last moment a rider
    // is awake to set an alarm against it. Four hours in, the terminal is
    // inside the horizon and is predicted rather than refused.
    const late = simulation.scheduleUpdates(bin, new Date(duty.departureAt.getTime() + 240 * 60_000))
    const terminal = late.at(-1)
    expect(terminal?.stop.name).toBe('Hampi')
    expect(terminal?.seconds).not.toBeNull()
    expect(config.intercityPredictionHorizonSeconds).toBe(21_600)
  })

  it('an unreserved coach is predicted on exactly the same model - the band is about physics, not reservation', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 1, coverageShareOrdinary: 1 },
    })
    const duty = sarigeDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const at = new Date(duty.departureAt.getTime() + 90 * 60_000)
    const snapshot = simulation.runSnapshot(duty, at)
    const stops = simulation.predictNextStops(bin, at, 1)
    expect(stops.length).toBe(1)
    const stand = snapshot.corridor.stands.find((candidate) => candidate.id === stops[0]!.stop.id)!
    expect(stops[0]!.uncertaintySeconds).toBe(
      intercityUncertaintySeconds(PROFILE, {
        remainingHighwayKm: highwayKmBetween(
          snapshot.corridor,
          snapshot.cursor.distanceMetres,
          stand.distanceMetres,
        ),
        haltsRemaining: haltsRemaining(
          snapshot.corridor,
          snapshot.cursor.distanceMetres,
          stand.distanceMetres,
        ),
        urbanApproach: entersUrban(
          snapshot.corridor,
          snapshot.cursor.distanceMetres,
          stand.distanceMetres,
        ),
        insideDeadZone: snapshot.insideDeadZone,
      }),
    )
  })
})
