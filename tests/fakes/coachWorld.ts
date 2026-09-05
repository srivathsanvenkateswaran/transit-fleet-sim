import { fileURLToPath } from 'node:url'
import { generateCoachFleet } from '../../src/fleet/generate.js'
import type { FleetVehicle } from '../../src/fleet/registry.js'
import { loadServiceClasses } from '../../src/fleet/serviceClass.js'
import { loadCorridorTopology } from '../../src/geometry/corridorTopology.js'
import { defaultCoachProfiles, defaultScheduleProfile } from '../../src/sim/coachProfiles.js'
import { CoachSimulation, type CoachWorldProfiles } from '../../src/sim/coachWorld.js'
import { loadCorridorRoster } from '../../src/sim/corridorRoster.js'
import { coachSlotsFor } from '../../src/sim/intercitySetup.js'

/**
 * A real `CoachSimulation` over the committed bundle, at a chosen instant.
 *
 * The coach tests drive the real geometry, the real roster and the real
 * seeded draws rather than a fake, because almost every criterion in
 * docs/intercity-coaches.md §15 is a statement about what the model actually
 * produces over a run - a dead zone in the same place for two vehicles, a
 * band that only narrows, a refusal that holds at 03:40 as well as at noon.
 * A fake would assert the test's own arithmetic back at itself.
 *
 * `INTERCITY_CORRIDORS` is never set in the test environment, so nothing here
 * goes through `loadIntercity`: the files are read directly and the
 * simulation is constructed with explicit options. That keeps §14.1's
 * default-off guarantee genuinely untested-around - the suite proves the
 * feature works when it is switched on, and separately proves that switching
 * it off changes nothing.
 */

export const TOPOLOGY_PATH = fileURLToPath(
  new URL('../../data/bundle/corridor-topology.json', import.meta.url),
)
export const ROSTER_PATH = fileURLToPath(
  new URL('../../data/bundle/corridor-roster.json', import.meta.url),
)
export const CLASSES_PATH = fileURLToPath(
  new URL('../../data/bundle/corridor-classes.json', import.meta.url),
)

export const CORRIDOR_IDS = ['BNG-HSP'] as const

export interface CoachHarness {
  readonly simulation: CoachSimulation
  readonly coaches: readonly FleetVehicle[]
  readonly bootAt: Date
}

export async function coachHarness(
  bootAt: Date,
  overrides: Partial<CoachWorldProfiles> = {},
): Promise<CoachHarness> {
  const topology = await loadCorridorTopology(TOPOLOGY_PATH)
  const serviceClasses = await loadServiceClasses(CLASSES_PATH)
  const roster = await loadCorridorRoster(ROSTER_PATH, CORRIDOR_IDS)
  const profiles: CoachWorldProfiles = { ...defaultCoachProfiles, ...overrides }
  const slots = coachSlotsFor(
    { topology, serviceClasses, roster },
    CORRIDOR_IDS,
    bootAt,
    profiles.rosterDays,
    defaultScheduleProfile,
  )
  const coaches = generateCoachFleet({ seed: profiles.seed, slots })
  const simulation = new CoachSimulation({
    topology,
    serviceClasses,
    roster,
    fleet: coaches,
    corridorIds: CORRIDOR_IDS,
    profiles,
    bootAt,
  })
  return { simulation, coaches, bootAt }
}

/** The Pallakki sleeper the whole document is shaped around. */
export function pallakkiDuty(simulation: CoachSimulation, serviceDate = '20260905') {
  const duty = simulation.duties.find(
    (candidate) => candidate.serviceId === '2259BNGHMP' && candidate.serviceDate === serviceDate,
  )
  if (duty === undefined) throw new Error(`No 2259BNGHMP duty on ${serviceDate}`)
  return duty
}

/** The unreserved counter-example: walk-up, nobody counts, the demand model applies. */
export function sarigeDuty(simulation: CoachSimulation, serviceDate = '20260905') {
  const duty = simulation.duties.find(
    (candidate) => candidate.serviceId === '1030BNGHMP' && candidate.serviceDate === serviceDate,
  )
  if (duty === undefined) throw new Error(`No 1030BNGHMP duty on ${serviceDate}`)
  return duty
}

export function binFor(simulation: CoachSimulation, dutyId: string): string {
  const assignment = simulation.assignmentFor(dutyId)
  if (assignment === null) throw new Error(`No assignment for ${dutyId}`)
  return assignment.bin
}

/** Every minute of a duty, from departure, as observations. */
export function* runMinutes(
  simulation: CoachSimulation,
  dutyId: string,
  minutes: number,
  stepMinutes = 1,
) {
  const duty = simulation.duties.find((candidate) => candidate.id === dutyId)
  if (duty === undefined) throw new Error(`No duty ${dutyId}`)
  const bin = binFor(simulation, dutyId)
  for (let minute = 0; minute <= minutes; minute += stepMinutes) {
    const at = new Date(duty.departureAt.getTime() + minute * 60_000)
    const observation = simulation.observe(bin, at)
    if (observation !== null) yield { at, minute, observation }
  }
}

/**
 * A `WorldPort` over a `CoachSimulation` alone, for the endpoint tests.
 *
 * The HTTP layer is written against the port and never against a concrete
 * simulator (`src/world/port.ts`'s whole reason to exist), so a coach-only
 * world is a legitimate world: it has no buses, which is what lets these
 * tests run without parsing the GTFS bundle. The bus half of every endpoint
 * is already covered by `tests/api/resolve.test.ts` and the goldens.
 */
export function coachWorldPort(
  simulation: CoachSimulation,
  now: Date,
): import('../../src/world/port.js').WorldPort {
  return {
    now: () => now,
    observe: (bin, at) => simulation.observe(bin, at),
    predictNextStops: (bin, at, limit) => simulation.predictNextStops(bin, at, limit),
    scheduleUpdates: (bin, at) => simulation.scheduleUpdates(bin, at),
    status: (at) => ({
      geometryLoaded: true,
      routes: 0,
      metroLines: 0,
      vehicles: 8,
      lastTickAt: now.toISOString(),
      tickLagMs: 0,
      seed: defaultCoachProfiles.seed,
      corridors: simulation.corridorCount,
      coachesRostered: simulation.rosteredCount,
      coachesActive: simulation.activeCount(at),
      rosterWindow: { from: simulation.rosterWindow.from, to: simulation.rosterWindow.to },
      rosterWindowStale: simulation.rosterWindowStale(at),
    }),
    start: async () => {},
    stop: async () => {},
  }
}
