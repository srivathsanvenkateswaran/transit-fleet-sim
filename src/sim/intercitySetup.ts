import { fixtureHub } from '../fleet/corporation.js'
import type { CoachRosterSlot } from '../fleet/generate.js'
import { loadServiceClasses, type ServiceClass, type ServiceClassId } from '../fleet/serviceClass.js'
import { loadCorridorTopology, type CorridorTopology } from '../geometry/corridorTopology.js'
import {
  buildRoster,
  loadCorridorRoster,
  poolSizeFor,
  rosterWindowFor,
  type CorridorRosterFile,
  type ScheduleProfile,
} from './corridorRoster.js'

/**
 * docs/intercity-coaches.md §12.1: what turning `INTERCITY_CORRIDORS` on
 * actually loads and checks, before anything is generated from it. A
 * misconfiguration - an unknown corridor id, an unknown hub, a service class
 * missing from the bundled table, a corridor with no roster entry - fails
 * startup loudly and names the offending value rather than booting into a
 * silently half-configured coach feature.
 */
export interface IntercitySetup {
  readonly topology: CorridorTopology
  readonly serviceClasses: readonly ServiceClass[]
  readonly roster: CorridorRosterFile
}

export interface IntercitySetupOptions {
  readonly corridors: readonly string[]
  readonly topologyPath: string
  readonly rosterPath: string
  readonly hubCodes: readonly string[]
  readonly serviceClassIds: readonly string[]
  readonly classesPath: string
}

/** Returns `null` when `corridors` is empty - the §14.1 default-off case. */
export async function loadIntercitySetup(options: IntercitySetupOptions): Promise<IntercitySetup | null> {
  if (options.corridors.length === 0) return null

  const topology = await loadCorridorTopology(options.topologyPath)
  const knownCorridorIds = new Set(topology.corridors.map((corridor) => corridor.id))
  const unknownCorridors = options.corridors.filter((id) => !knownCorridorIds.has(id))
  if (unknownCorridors.length > 0) {
    throw new Error(
      `INTERCITY_CORRIDORS names corridors missing from the bundled topology: ${unknownCorridors.join(', ')}`,
    )
  }

  const unknownHubs = options.hubCodes.filter((code) => fixtureHub(code) === null)
  if (unknownHubs.length > 0) {
    throw new Error(`INTERCITY_HUB_CODES names hubs with no known division or corporation: ${unknownHubs.join(', ')}`)
  }

  // loadServiceClasses itself fails, naming the missing ones, when
  // `serviceClassIds` is not a subset of the bundled table (§12.1).
  const serviceClasses = await loadServiceClasses(options.classesPath, options.serviceClassIds)
  const roster = await loadCorridorRoster(options.rosterPath, options.corridors)
  const known = new Set(serviceClasses.map((serviceClass) => serviceClass.id as string))
  const unknownClasses = roster.corridors
    .flatMap((corridor) => corridor.departures)
    .filter((departure) => !known.has(departure.serviceClass))
    .map((departure) => `${departure.serviceId}:${departure.serviceClass}`)
  if (unknownClasses.length > 0) {
    throw new Error(
      `The roster names service classes missing from the class table: ${unknownClasses.join(', ')}`,
    )
  }

  return { topology, serviceClasses, roster }
}

/**
 * How many coaches each corridor and class actually needs - §3.5: "the fleet
 * size falls out of the roster rather than being configured, which is how an
 * operator thinks about it and is the same move `METRO_TRAINS_PER_LINE`
 * already makes."
 *
 * `BUSES_PER_ROUTE` does not apply and there is deliberately no
 * `COACHES_PER_CORRIDOR` to replace it: the roster says what runs, peak
 * concurrency says how many vehicles that needs, and one spare per class is
 * what §12.5's substitution substitutes from.
 */
export function coachSlotsFor(
  setup: IntercitySetup,
  corridorIds: readonly string[],
  bootAt: Date,
  rosterDays: number,
  schedule: ScheduleProfile,
): readonly CoachRosterSlot[] {
  const corridors = setup.topology.corridors.filter((corridor) => corridorIds.includes(corridor.id))
  const window = rosterWindowFor(bootAt, rosterDays, schedule.timezone)
  const duties = buildRoster(corridors, setup.roster, window, schedule)
  const slots: CoachRosterSlot[] = []
  for (const corridor of corridors) {
    const classes = new Set(
      duties.filter((duty) => duty.corridorId === corridor.id).map((duty) => duty.serviceClassId),
    )
    for (const serviceClassId of [...classes].sort()) {
      const forClass = duties.filter(
        (duty) => duty.corridorId === corridor.id && duty.serviceClassId === serviceClassId,
      )
      const hub = forClass[0]?.hub ?? ''
      const corporation = fixtureHub(hub)?.corporation
      if (corporation === undefined) {
        throw new Error(`The roster names hub ${hub}, which has no known division or corporation`)
      }
      slots.push({
        hub,
        corporation,
        serviceClassId: serviceClassId as ServiceClassId,
        homeCorridorId: corridor.id,
        count: poolSizeFor(forClass),
      })
    }
  }
  return slots
}
