import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { haversineMetres } from '../../src/geometry/haversine.js'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import { coverageShareFor, deadZoneAt } from '../../src/sim/intercityDevice.js'
import { binFor, coachHarness, pallakkiDuty, runMinutes, sarigeDuty } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §6: the device ruling, and the evidence for it.
 *
 * "Better fitted, worse tracked." Coverage and continuity are separate facts
 * and the intercity case inverts them: `untracked` gets rarer for a reserved
 * coach, `dark` gets far more common and far longer for both, and dropouts
 * stop being a Poisson process in time and become intervals of route
 * distance.
 *
 * Every magnitude asserted below is a **modelling choice**, not a
 * measurement: no public source states any of the three corporations'
 * AIS-140 fitment rate, and §17.2 records the whole row as stubbed. What
 * these tests pin is that the shipped numbers are the documented ones and
 * that the *direction* of the ruling is observable in the fleet rather than
 * only in the configuration.
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')

describe('the intercity device and dead-zone model (§6)', () => {
  it('ships the documented coverage and continuity figures, and they are the ones §6.2 argues for', () => {
    // Coverage: better fitted. 0.92 reserved is above the city bus's 0.75.
    expect(config.intercityCoverageShareReserved).toBe(0.92)
    // And 0.70 ordinary is deliberately *below* it, which is what makes the
    // ruling one about service class rather than about mode.
    expect(config.intercityCoverageShareOrdinary).toBe(0.7)
    expect(config.busCoverageShare).toBe(0.75)
    // Continuity: worse tracked, and it collapses in the other direction.
    expect(config.intercityStaleAfterSeconds).toBe(180)
    expect(config.busStaleAfterSeconds).toBe(90)
    expect(config.intercityDarkAfterSeconds).toBe(600)
    expect(config.busDarkAfterSeconds).toBe(300)
  })

  it('criterion 72: reserved coverage exceeds ordinary, and ordinary is at or below the city bus', async () => {
    const reserved = coverageShareFor(defaultCoachProfiles.device, true)
    const ordinary = coverageShareFor(defaultCoachProfiles.device, false)
    expect(reserved).toBeGreaterThan(ordinary)
    expect(ordinary).toBeLessThanOrEqual(config.busCoverageShare)

    // "The mode contrast must be observable in the fleet, not only in the
    // config." Over the whole roster, the ordinary class produces untracked
    // observations and the reserved classes produce proportionally fewer.
    const { simulation } = await coachHarness(BOOT_AT)
    const counts = new Map<string, { total: number; untracked: number }>()
    for (const duty of simulation.duties) {
      const reservedClass = simulation.serviceClass(duty.serviceClassId)?.reserved ?? false
      const key = reservedClass ? 'reserved' : 'ordinary'
      for (const frame of runMinutes(simulation, duty.id, 540, 30)) {
        const bucket = counts.get(key) ?? { total: 0, untracked: 0 }
        bucket.total += 1
        if (frame.observation.tracking.state === 'untracked') bucket.untracked += 1
        counts.set(key, bucket)
      }
    }
    const reservedShare = 1 - counts.get('reserved')!.untracked / counts.get('reserved')!.total
    const ordinaryShare = 1 - counts.get('ordinary')!.untracked / counts.get('ordinary')!.total
    expect(reservedShare).toBeGreaterThan(ordinaryShare)
  })

  it('criterion 71: with reserved coverage at zero, every reserved coach is untracked with no position', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 0 },
    })
    let checked = 0
    for (const duty of simulation.duties) {
      if (!(simulation.serviceClass(duty.serviceClassId)?.reserved ?? false)) continue
      for (const frame of runMinutes(simulation, duty.id, 540, 60)) {
        checked += 1
        expect(frame.observation.tracking.state).toBe('untracked')
        expect(frame.observation.tracking.position).toBeNull()
        expect(frame.observation.tracking.reason).toBe('no_device_fitted')
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('criterion 73: two different coaches on the same corridor go dark over the same interval of route distance', async () => {
    // The geographic model's whole point, and a Poisson model keyed on
    // `rand(seed, bin, ...)` cannot pass it: that draw is uncorrelated across
    // vehicles by construction.
    const { simulation } = await coachHarness(BOOT_AT, {
      device: {
        ...defaultCoachProfiles.device,
        coverageShareReserved: 1,
        coverageShareOrdinary: 1,
        // Silence the urban Poisson process so the only thing left is
        // geography, which is exactly the comparison being made.
        urbanDropoutRatePerHour: 0,
      },
    })
    const zones = darkDistanceIntervals(simulation, pallakkiDuty(simulation).id)
    const other = darkDistanceIntervals(simulation, simulation.duties.find(
      (duty) => duty.serviceId === '2115BNGHMP' && duty.serviceDate === '20260905',
    )!.id)
    expect(zones.length).toBeGreaterThan(0)
    expect(other).toEqual(zones)
  })

  it('criterion 74: the same coach on two successive service dates goes dark over the same interval', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: {
        ...defaultCoachProfiles.device,
        coverageShareReserved: 1,
        coverageShareOrdinary: 1,
        urbanDropoutRatePerHour: 0,
      },
    })
    const first = darkDistanceIntervals(simulation, pallakkiDuty(simulation, '20260905').id)
    const second = darkDistanceIntervals(simulation, pallakkiDuty(simulation, '20260906').id)
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it('criterion 75: a dark coach inside a zone names the interval; one outside carries null and does not claim a dead zone', async () => {
    // The urban dropout bound is raised past the dark threshold on purpose.
    // At the shipped defaults a city dropout tops out at 420 s and the
    // intercity dark threshold is 600 s, so an urban gap ages to `stale` and
    // never to `dark` - which is a real property of the shipped model and is
    // asserted separately below. This test needs the other case to exist.
    const { simulation } = await coachHarness(BOOT_AT, {
      device: {
        ...defaultCoachProfiles.device,
        coverageShareReserved: 1,
        coverageShareOrdinary: 1,
        urbanDropoutRatePerHour: 12,
        urbanDropoutMinSeconds: 900,
        urbanDropoutMaxSeconds: 1_800,
      },
    })
    let insideNamed = 0
    let outsideNull = 0
    const causesOutside = new Set<string>()
    for (const duty of simulation.duties) {
      for (const frame of runMinutes(simulation, duty.id, 600)) {
        const tracking = frame.observation.tracking
        const snapshot = simulation.runSnapshot(duty, frame.at)
        // Each duty's own snapshot corridor, not one fixed reference corridor:
        // a `reverse` duty (§ bidirectional rosters) runs `reverseCorridor`'s
        // mirrored geometry, whose dead zones sit at different distances than
        // the forward corridor's - checking a reverse duty's cursor against
        // the forward corridor's zones would compare two different roads.
        const inside = deadZoneAt(snapshot.cursor.distanceMetres, snapshot.corridor.deadZones) !== null
        if (tracking.state !== 'dark') continue
        if (inside) {
          expect(tracking.deadZone).not.toBeNull()
          expect(tracking.deadZone?.corridorId).toBe('BNG-HSP')
          insideNamed += 1
        } else {
          expect(tracking.deadZone ?? null).toBeNull()
          outsideNull += 1
        }
      }
      for (const frame of runMinutes(simulation, duty.id, 600)) {
        const recovery = frame.observation.tracking.recovery
        if (recovery == null) continue
        if (recovery.cause !== 'dead_zone') causesOutside.add(recovery.cause)
      }
    }
    expect(insideNamed).toBeGreaterThan(0)
    expect(outsideNull).toBeGreaterThan(0)
    // §6.4: "the service does not guess at a cause it cannot distinguish."
    // A gap on an urban segment is the city model's Poisson dropout, and a
    // real backend looking at it cannot tell a dead SIM from a tunnel.
    expect([...causesOutside]).toEqual(['unknown'])
  })

  it('criterion 76: on recovery, gapMetres is the distance between the two published fixes and gapSeconds their difference', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 1, coverageShareOrdinary: 1 },
    })
    let checked = 0
    for (const duty of simulation.duties) {
      let previous: { position: { lat: number; lon: number }; observedAt: string } | null = null
      for (const frame of runMinutes(simulation, duty.id, 600)) {
        const tracking = frame.observation.tracking
        const recovery = tracking.recovery
        if (recovery != null && tracking.position !== null && tracking.observedAt !== null) {
          const measured = haversineMetres(recovery.fromPosition, tracking.position)
          expect(Math.abs(measured - recovery.gapMetres)).toBeLessThan(1)
          const seconds =
            (new Date(tracking.observedAt).getTime() - new Date(recovery.fromObservedAt).getTime()) /
            1_000
          expect(Math.abs(seconds - recovery.gapSeconds)).toBeLessThanOrEqual(1)
          checked += 1
        }
        if (tracking.position !== null && tracking.observedAt !== null) {
          previous = { position: tracking.position, observedAt: tracking.observedAt }
        }
      }
      expect(previous).not.toBeNull()
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('at the shipped defaults an urban dropout ages to stale and never to dark', async () => {
    // Not a coincidence worth hiding: BUS_DROPOUT_MAX_SECONDS is 420 and
    // INTERCITY_DARK_AFTER_SECONDS is 600, so the city failure mode running
    // on a corridor's urban segments cannot produce the intercity `dark`
    // state. Every `dark` a coach reaches at the defaults is geographic,
    // which is what makes `tracking.deadZone` reliable rather than usually
    // right.
    expect(config.busDropoutMaxSeconds).toBeLessThan(config.intercityDarkAfterSeconds)
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 1, coverageShareOrdinary: 1 },
    })
    for (const duty of simulation.duties) {
      for (const frame of runMinutes(simulation, duty.id, 600, 2)) {
        if (frame.observation.tracking.state !== 'dark') continue
        const snapshot = simulation.runSnapshot(duty, frame.at)
        // Each duty's own snapshot corridor - see the identical note on
        // criterion 75 above.
        expect(deadZoneAt(snapshot.cursor.distanceMetres, snapshot.corridor.deadZones)).not.toBeNull()
      }
    }
  })

  it('the urban Poisson process runs on urban segments and geography runs on the highway', async () => {
    // §6.3: "Both mechanisms run on the same corridor, on different parts of
    // it." With geography silenced there are still gaps, and they are in the
    // urban approach rather than in the authored zones.
    const { simulation } = await coachHarness(BOOT_AT, {
      device: {
        ...defaultCoachProfiles.device,
        coverageShareReserved: 1,
        coverageShareOrdinary: 1,
        urbanDropoutRatePerHour: 30,
      },
    })
    const duty = sarigeDuty(simulation)
    const corridor = simulation.runSnapshot(duty, BOOT_AT).corridor
    const urbanGaps = [...runMinutes(simulation, duty.id, 60)].filter((frame) => {
      const snapshot = simulation.runSnapshot(duty, frame.at)
      return (
        frame.observation.tracking.state !== 'live' &&
        deadZoneAt(snapshot.cursor.distanceMetres, corridor.deadZones) === null
      )
    })
    expect(urbanGaps.length).toBeGreaterThan(0)
  })
})

/**
 * The intervals of route distance over which a duty was dark, rounded to the
 * nearest kilometre. Rounding is what makes the comparison meaningful: two
 * coaches enter a zone at slightly different speeds and take their last fix
 * at slightly different points, so the raw metres differ while the *zone*
 * does not - which is the claim being tested.
 */
function darkDistanceIntervals(
  simulation: Awaited<ReturnType<typeof coachHarness>>['simulation'],
  dutyId: string,
): readonly string[] {
  const duty = simulation.duties.find((candidate) => candidate.id === dutyId)!
  const bin = binFor(simulation, dutyId)
  const intervals = new Set<string>()
  for (let minute = 0; minute <= 600; minute += 1) {
    const at = new Date(duty.departureAt.getTime() + minute * 60_000)
    const observation = simulation.observe(bin, at)
    if (observation === null) continue
    const zone = observation.tracking.deadZone
    if (zone != null) intervals.add(`${zone.fromMetres}-${zone.toMetres}`)
  }
  return [...intervals].sort()
}
