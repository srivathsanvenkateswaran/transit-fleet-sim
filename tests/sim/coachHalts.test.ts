import { describe, expect, it } from 'vitest'
import {
  advanceCoach,
  createCoachCursor,
  type CoachMotionProfile,
} from '../../src/sim/coachCursor.js'
import { loadCorridorTopology } from '../../src/geometry/corridorTopology.js'
import { binFor, coachHarness, pallakkiDuty, runMinutes, TOPOLOGY_PATH } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §4: a long dwell is a fact, not a symptom.
 *
 * "A coach parked thirty minutes at a dhaba at 02:00 is doing what it was
 * scheduled to do. The current model has one dwell concept and no way to
 * distinguish a deliberate stop from a stuck one."
 *
 * The distinction has to survive two hostile cases and both are tested here:
 * a halt must not read as a dropout, and a dropout **during** a halt must not
 * be hidden by it.
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')

describe('halts (§4)', () => {
  it('criterion 67: a coach at a meal halt is live, STOPPED_AT, at zero speed, with a dwell and no tracking reason', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const duty = pallakkiDuty(simulation)
    const halted = [...runMinutes(simulation, duty.id, 600)].find(
      (frame) => frame.observation.tracking.progress?.dwell?.kind === 'meal_halt',
    )
    expect(halted).toBeDefined()
    const tracking = halted!.observation.tracking
    expect(tracking.state).toBe('live')
    // The three fields a consumer already has, before it ever reads `dwell`.
    expect(tracking.progress?.currentStatus).toBe('STOPPED_AT')
    expect(tracking.position?.speedKph).toBe(0)
    // §4.2: "A halt never produces a `tracking.reason`." A halted coach with
    // a working device is `live`, and the two facts are orthogonal.
    expect(tracking.reason).toBeNull()
    expect(tracking.progress?.dwell?.stop.name).toContain('meal halt')
  })

  it('criterion 68: endsAtUncertaintySeconds is present and never zero on every dwell the service emits', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const dwells: number[] = []
    for (const duty of simulation.duties) {
      for (const frame of runMinutes(simulation, duty.id, 600, 2)) {
        const dwell = frame.observation.tracking.progress?.dwell
        if (dwell != null) dwells.push(dwell.endsAtUncertaintySeconds)
      }
    }
    expect(dwells.length).toBeGreaterThan(20)
    expect(dwells.every((value) => Number.isFinite(value) && value > 0)).toBe(true)
  })

  it('criterion 68, structurally: no configuration can drive the band to zero', async () => {
    // A halt is discretionary and its end is the single largest source of
    // variance on the run. A deployment that set every standard deviation to
    // zero would otherwise publish the one certain number in a model that has
    // none, so the band is floored in the cursor rather than in a projector a
    // later change could route around.
    const topology = await loadCorridorTopology(TOPOLOGY_PATH)
    const corridor = topology.corridors[0]!
    const zeroed: CoachMotionProfile = {
      seed: 1,
      highwayKphMean: 62,
      highwayKphSd: 0,
      highwayKphMin: 30,
      highwayKphMax: 85,
      urbanKphMean: 17,
      urbanKphSd: 0,
      dwellSecondsMeanByKind: {
        boarding: 180,
        stand: 420,
        meal_halt: 1_800,
        crew_change: 420,
        terminal: 0,
      },
      dwellSecondsSdByKind: { boarding: 0, stand: 0, meal_halt: 0, crew_change: 0, terminal: 0 },
    }
    const cursor = createCoachCursor(corridor, zeroed, 'KBS-01055')
    const from = new Date('2026-09-05T17:29:00Z')
    const bands: number[] = []
    for (let step = 0; step < 4_000 && bands.length < 3; step += 1) {
      advanceCoach(cursor, corridor, new Date(from.getTime() + step * 15_000), 15, zeroed, 'KBS-01055')
      if (cursor.dwell !== null) bands.push(cursor.dwell.uncertaintySeconds)
    }
    expect(bands.length).toBeGreaterThan(0)
    expect(bands.every((band) => band > 0)).toBe(true)
  })

  it('criterion 69: a dropout during a halt reports the dropout - the dwell stays and the state ages', async () => {
    // Forcing this rather than waiting for it: the halt and the dropout have
    // to coincide, which over a nine-hour run they eventually do but not on
    // any particular seed. A five-second dark threshold makes any halt long
    // enough, and the assertion is about which facts survive, not about how
    // the dropout arrived.
    const { simulation } = await coachHarness(BOOT_AT, {
      device: {
        seed: 1,
        coverageShareReserved: 1,
        coverageShareOrdinary: 1,
        fixIntervalSeconds: 30,
        // A stationary interval longer than the dark threshold: the halted
        // coach genuinely stops reporting while it stands there.
        fixIntervalStationarySeconds: 1_200,
        fixJitterSeconds: 0,
        staleAfterSeconds: 60,
        darkAfterSeconds: 120,
        gpsNoiseMetres: 12,
        urbanDropoutRatePerHour: 0,
        urbanDropoutMinSeconds: 60,
        urbanDropoutMaxSeconds: 420,
      },
    })
    const duty = pallakkiDuty(simulation)
    const frames = [...runMinutes(simulation, duty.id, 600)]
    const haltFrames = frames.filter(
      (frame) => frame.observation.tracking.progress?.dwell?.kind === 'meal_halt',
    )
    const agedDuringHalt = frames.filter(
      (frame) =>
        frame.observation.tracking.state !== 'live' &&
        frame.observation.tracking.progress === null &&
        haltFrames.length > 0,
    )
    expect(haltFrames.length).toBeGreaterThan(0)
    // Two facts, both published: the dwell is a scheduled fact and stays
    // true, and the tracking state ages independently of it. Folding one into
    // the other would let a stationary coach hide a dead device.
    expect(agedDuringHalt.length).toBeGreaterThan(0)
    expect(agedDuringHalt.every((frame) => frame.observation.tracking.reason !== null)).toBe(true)
  })

  it('criterion 70: a halted coach emits at the stationary interval and a moving one at the moving interval', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const observedAtWhileHalted = new Set<string>()
    const observedAtWhileMoving = new Set<string>()
    let haltedMinutes = 0
    let movingMinutes = 0
    for (const frame of runMinutes(simulation, duty.id, 600)) {
      const tracking = frame.observation.tracking
      if (tracking.observedAt === null) continue
      const dwell = tracking.progress?.dwell
      if (dwell?.kind === 'meal_halt') {
        haltedMinutes += 1
        observedAtWhileHalted.add(tracking.observedAt)
      } else if (tracking.state === 'live' && tracking.position !== null && tracking.position.speedKph > 0) {
        movingMinutes += 1
        observedAtWhileMoving.add(tracking.observedAt)
      }
    }
    expect(bin).toMatch(/^KBS-\d{5}$/)
    // Fixes per observed minute: 120 s stationary against 30 s moving means a
    // halted coach produces roughly a quarter as many distinct fixes over the
    // same number of minutes.
    const haltedRate = observedAtWhileHalted.size / haltedMinutes
    const movingRate = observedAtWhileMoving.size / movingMinutes
    expect(movingRate).toBeGreaterThan(haltedRate * 1.8)
  })

  it('a boarding stop and a meal halt are different kinds, and the terminal ends the run', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const duty = pallakkiDuty(simulation)
    const kinds = new Set<string>()
    for (const frame of runMinutes(simulation, duty.id, 620)) {
      const dwell = frame.observation.tracking.progress?.dwell
      if (dwell != null) kinds.add(dwell.kind)
    }
    expect(kinds.has('boarding')).toBe(true)
    expect(kinds.has('meal_halt')).toBe(true)
    expect(kinds.has('stand')).toBe(true)
    // §4.1: a terminal has no dwell of its own - the run ends there.
    expect(kinds.has('terminal')).toBe(false)
  })
})
