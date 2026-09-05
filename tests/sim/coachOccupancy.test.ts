import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import { occupancyFor, projectOccupancy } from '../../src/sim/occupancy.js'
import { binFor, coachHarness, pallakkiDuty, runMinutes, sarigeDuty } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §7: the occupancy refusal.
 *
 * "A reserved coach's load is knowable and this service does not know it, and
 * it says nothing rather than something plausible." §17.1 calls it the most
 * faithful thing in the document, and §18's risk table gives softening it by
 * a later well-meaning change a **high** impact - which is why criteria 82,
 * 83 and 84 exist and why the guard is the type rather than these tests.
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')

const FULL_COVERAGE = {
  ...defaultCoachProfiles.device,
  coverageShareReserved: 1,
  coverageShareOrdinary: 1,
}

describe('the occupancy refusal (§7)', () => {
  it('criterion 82: over a full-day sweep, with a manifest held for every reserved duty, no reserved observation carries an occupancy key', async () => {
    const { simulation } = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    // The sweep runs **with** manifests precisely so the criterion cannot be
    // passed by having nothing to publish.
    for (const duty of simulation.duties) {
      if (!(simulation.serviceClass(duty.serviceClassId)?.reserved ?? false)) continue
      simulation.putManifest(
        {
          serviceId: duty.serviceId,
          travelDate: duty.travelDate,
          seats: { total: 30, booked: 30, held: 0, simulated: 0 },
          asOf: duty.departureAt.toISOString(),
          ttlSeconds: 86_400,
        },
        duty.departureAt,
      )
    }
    let reservedObservations = 0
    let withManifest = 0
    for (const duty of simulation.duties) {
      if (!(simulation.serviceClass(duty.serviceClassId)?.reserved ?? false)) continue
      for (const frame of runMinutes(simulation, duty.id, 600)) {
        reservedObservations += 1
        expect('occupancy' in frame.observation).toBe(false)
        expect(JSON.stringify(frame.observation)).not.toContain('occupancy')
        if (frame.observation.duty.reservation?.manifest !== undefined) withManifest += 1
      }
    }
    expect(reservedObservations).toBeGreaterThan(3_000)
    // A sold-out manifest was genuinely held over hundreds of those
    // observations - the first hour of each run, until each push ages past
    // INTERCITY_MANIFEST_MAX_AGE_SECONDS - so the refusal was tested against
    // something to publish rather than against nothing.
    expect(withManifest).toBeGreaterThan(400)
  })

  it('criterion 89: FULL, STANDING_ROOM_ONLY and CRUSHED_STANDING_ROOM_ONLY are never emitted for a reserved duty at any manifest value', async () => {
    const { simulation } = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const at = new Date(duty.departureAt.getTime() + 60 * 60_000)
    for (const booked of [0, 1, 15, 29, 30]) {
      simulation.putManifest(
        {
          serviceId: duty.serviceId,
          travelDate: duty.travelDate,
          seats: { total: 30, booked, held: 0, simulated: 0 },
          asOf: new Date(at.getTime() - booked * 1_000 - 1_000).toISOString(),
          ttlSeconds: 3_600,
        },
        at,
      )
      const observation = simulation.observe(bin, at)!
      expect('occupancy' in observation).toBe(false)
    }
    // `FULL` is a claim about the vehicle rather than about a sales channel,
    // and nobody stands on a sleeper. The whole enum is simply absent.
  })

  it('criterion 83: occupancyFor returns withheld for a reserved duty before any demand-model function runs', () => {
    // A reserved input with values that would otherwise produce a large
    // headcount: mid-route, at the evening peak, on a long-distance run.
    const outcome = occupancyFor(
      {
        bin: 'KBS-01055',
        trackingState: 'live',
        routeId: 'BNG-HSP',
        routeNumber: '2259BNGHMP',
        directionId: 0,
        distanceAlongRouteMetres: 200_000,
        routeLengthMetres: 417_658,
        at: new Date('2026-09-05T13:00:00Z'),
        tripStartedAtMs: Date.parse('2026-09-05T17:29:00Z'),
        reservation: { required: true },
        longDistance: true,
      },
      defaultCoachProfiles.occupancy,
    )
    expect(outcome).toEqual({ kind: 'withheld', reason: 'reserved_no_onboard_count' })
    // §7.2: omission, not `NO_DATA_AVAILABLE`. That value would assert an
    // on-vehicle counting capability which does not exist.
    expect(projectOccupancy(outcome)).toBeUndefined()
  })

  it('criterion 83: the refusal is checked before the tracking short-circuit, so it does not depend on where the coach is', () => {
    for (const trackingState of ['live', 'stale', 'dark', 'untracked'] as const) {
      const outcome = occupancyFor(
        {
          bin: 'KBS-01055',
          trackingState,
          routeId: 'BNG-HSP',
          routeNumber: '2259BNGHMP',
          directionId: 0,
          distanceAlongRouteMetres: 200_000,
          routeLengthMetres: 417_658,
          at: new Date('2026-09-05T13:00:00Z'),
          tripStartedAtMs: 0,
          reservation: { required: true },
        },
        defaultCoachProfiles.occupancy,
      )
      expect(outcome).toEqual({ kind: 'withheld', reason: 'reserved_no_onboard_count' })
    }
  })

  it('criterion 83: OccupancyOutcome has no arm that could carry a measured figure, and the manifest is not a parameter to occupancyFor', async () => {
    // The type is the real guard; the tests catch the route around it. An arm
    // that *could* carry a measured number would be an invitation for a later
    // change to fill it in "just this once"; an arm that structurally cannot
    // has nothing to fill in.
    const source = await readFile(new URL('../../src/sim/occupancy.ts', import.meta.url), 'utf8')
    const outcomeType = stripComments(
      source.slice(
        source.indexOf('export type OccupancyOutcome'),
        source.indexOf('/** A whole-route demand hump'),
      ),
    )
    expect(outcomeType).toContain("kind: 'modelled'")
    expect(outcomeType).toContain("kind: 'withheld'")
    expect(outcomeType).not.toMatch(/measured|seatsBooked|manifest/i)
    // And `OccupancyInput` has nowhere for a seat count to arrive.
    const inputType = stripComments(
      source.slice(
        source.indexOf('export interface OccupancyInput'),
        source.indexOf('export type OccupancyOutcome'),
      ),
    )
    expect(inputType).not.toMatch(/seats|manifest|booked/i)
  })

  it('criterion 84: no configuration surface, scenario target or manifest push emits an occupancy for a reserved duty', async () => {
    // A config-surface scan: there is deliberately no variable that enables an
    // occupancy for a reserved duty, "because a knob that turns the refusal
    // off would be a knob that turns the fabrication on, and a deployment
    // could set it by accident".
    const configSource = await readFile(new URL('../../src/config.ts', import.meta.url), 'utf8')
    const names = [...configSource.matchAll(/validation\.\w+(?:<[^>]+>)?\(\s*'([A-Z][A-Z0-9_]+)'/g)].map(
      (match) => match[1]!,
    )
    // `BUS_SEATED_CAPACITY` and friends are the *bus* demand model's design
    // capacities and are not a switch: no variable anywhere names occupancy,
    // crowding, or publishing a seat count, for a reserved duty or otherwise.
    expect(names.filter((name) => /OCCUPANCY|CROWD|SEATS_(BOOKED|SOLD)|PUBLISH_SEAT/.test(name))).toEqual([])
    expect(names.filter((name) => /RESERVED/.test(name))).toEqual(['INTERCITY_COVERAGE_SHARE__RESERVED'])

    // And an exhaustive sweep of the manifest endpoint's accepted bodies.
    const { simulation } = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const at = new Date(duty.departureAt.getTime() + 45 * 60_000)
    let pushes = 0
    for (const total of [1, 30, 53]) {
      for (const booked of [0, 1, total]) {
        for (const held of [0, 1]) {
          for (const simulated of [0, 1]) {
            if (booked + held + simulated > total) continue
            pushes += 1
            simulation.putManifest(
              {
                serviceId: duty.serviceId,
                travelDate: duty.travelDate,
                seats: { total, booked, held, simulated },
                asOf: new Date(at.getTime() - 100_000 + pushes * 1_000).toISOString(),
                ttlSeconds: 3_600,
              },
              at,
            )
            expect('occupancy' in simulation.observe(bin, at)!).toBe(false)
          }
        }
      }
    }
    expect(pushes).toBeGreaterThan(10)
  })

  it('criterion 92: an unreserved intercity duty does carry a modelled occupancy', async () => {
    // "The refusal is about reservation, not about distance, and this is the
    // test that proves it." Same corridor, same day, same simulator.
    const { simulation } = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const duty = sarigeDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const modelled = [...runMinutes(simulation, duty.id, 540)]
      .map((frame) => frame.observation.occupancy)
      .filter((occupancy) => occupancy !== undefined && occupancy.status !== 'NO_DATA_AVAILABLE')
    expect(modelled.length).toBeGreaterThan(100)
    expect(modelled.every((occupancy) => typeof occupancy!.percentage === 'number')).toBe(true)
    expect(simulation.observe(bin, duty.departureAt)!.duty.reservation).toBeNull()
  })

  it('§3.7: the unreserved intercity curve is not the city curve - an overnight coach is not at the floor', () => {
    // The city model returns its overnight floor at 02:00 for a coach that is
    // genuinely full of sleeping passengers. Neither shape is fitted to
    // anything (open question 11) and both are marked `modelled`, but one of
    // them is visibly wrong and the other is not.
    const base = {
      bin: 'KBS-01032',
      trackingState: 'live' as const,
      routeId: 'BNG-HSP',
      routeNumber: '1030BNGHMP',
      directionId: 0 as const,
      distanceAlongRouteMetres: 200_000,
      routeLengthMetres: 417_658,
      at: new Date('2026-09-05T20:44:00Z'), // 02:14 IST
      tripStartedAtMs: 0,
      reservation: null,
    }
    const city = occupancyFor(base, defaultCoachProfiles.occupancy)
    const corridor = occupancyFor({ ...base, longDistance: true }, defaultCoachProfiles.occupancy)
    expect(city.kind).toBe('modelled')
    expect(corridor.kind).toBe('modelled')
    if (city.kind !== 'modelled' || corridor.kind !== 'modelled') throw new Error('unreachable')
    expect(corridor.observation.percentage!).toBeGreaterThan(city.observation.percentage!)
  })
})

/** Comment prose necessarily discusses the words the scan forbids in code. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '')
}
