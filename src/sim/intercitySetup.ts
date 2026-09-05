import { fixtureHub } from '../fleet/corporation.js'
import { loadServiceClasses, type ServiceClass } from '../fleet/serviceClass.js'
import { loadCorridorTopology, type CorridorTopology } from '../geometry/corridorTopology.js'

/**
 * docs/intercity-coaches.md §12.1: what turning `INTERCITY_CORRIDORS` on
 * actually loads and checks, before anything is generated from it. This is
 * intentionally the whole of what this pass wires into a running process -
 * the roster that would turn a loaded topology into ticking coaches
 * (`#roster`/`#active`, dispatch by departure, `/readyz`'s `coachesRostered`
 * and `coachesActive`) is not built here. See the README's scope note. What
 * *is* built and real: the geometry loads, is validated, and a
 * misconfiguration - an unknown corridor id, an unknown hub, a service class
 * missing from the bundled table - fails startup loudly and names the
 * offending value, exactly as §12.1 requires, rather than booting into a
 * silently half-configured coach feature.
 */
export interface IntercitySetup {
  readonly topology: CorridorTopology
  readonly serviceClasses: readonly ServiceClass[]
}

export interface IntercitySetupOptions {
  readonly corridors: readonly string[]
  readonly topologyPath: string
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

  return { topology, serviceClasses }
}
