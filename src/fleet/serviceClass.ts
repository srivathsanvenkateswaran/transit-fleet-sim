import { readFile } from 'node:fs/promises'
import type { Corporation } from './corporation.js'

/**
 * docs/intercity-coaches.md §1.2: "Reservation is a property of the service
 * class, not of the corporation and not of the distance." Every rule that
 * turns on reservation - the occupancy refusal (§7) chief among them - reads
 * `serviceClass.reserved`, never the corporation and never the corridor
 * length. This union is the closed set of classes the fixture roster can
 * name; `INTERCITY_SERVICE_CLASSES` (config.ts) is checked against it at
 * startup rather than trusted to agree.
 */
export type ServiceClassId =
  | 'karnataka_sarige'
  | 'rajahamsa_executive'
  | 'airavat'
  | 'airavat_club_class'
  | 'ambaari_utsav'
  | 'pallakki'

/**
 * `capacitySource` is not decoration (§2.2): a manifest's `seatsTotal`
 * (docs/intercity-coaches.md §7) comes from `capacity`, and a figure sourced
 * from an aggregator's blurb must not read alike a figure sourced from an
 * operator's spec sheet. Every row here is `"secondary"` today, and that is a
 * fact about the research this document did, not a placeholder waiting to be
 * upgraded on a schedule.
 */
export interface ServiceClass {
  readonly id: ServiceClassId
  readonly name: string
  readonly reserved: boolean
  readonly ac: boolean
  readonly layout: string
  readonly berths: boolean
  readonly capacity: number
  readonly capacitySource: 'primary' | 'secondary' | 'assumed'
  readonly corporations: readonly Corporation[]
}

/**
 * The service-class table is data, not code, and lives beside the corridor
 * bundle (§2.2) so a class can be added without a release. This is that
 * data's in-repository source of truth; `data/bundle/corridor-classes.json`
 * is generated from it once and committed, the same relationship
 * `metro-topology.json` has to `scripts/fetch-metro-topology.ts` - a script
 * produces the bundle, the bundle is what ships, and the two are kept in
 * step by `tests/geometry/corridorTopology.test.ts` rather than by hand.
 */
export const SERVICE_CLASSES: readonly ServiceClass[] = [
  {
    id: 'karnataka_sarige',
    name: 'Karnataka Sarige',
    reserved: false,
    ac: false,
    layout: '3+2',
    berths: false,
    capacity: 62,
    capacitySource: 'secondary',
    corporations: ['KSRTC', 'NWKRTC', 'KKRTC'],
  },
  {
    id: 'rajahamsa_executive',
    name: 'Rajahamsa Executive',
    reserved: true,
    ac: false,
    layout: '2+2',
    berths: false,
    capacity: 45,
    capacitySource: 'secondary',
    corporations: ['KSRTC', 'NWKRTC', 'KKRTC'],
  },
  {
    id: 'airavat',
    name: 'Airavat',
    reserved: true,
    ac: true,
    layout: '2+2',
    berths: false,
    capacity: 41,
    capacitySource: 'secondary',
    corporations: ['KSRTC', 'NWKRTC', 'KKRTC'],
  },
  {
    id: 'airavat_club_class',
    name: 'Airavat Club Class',
    reserved: true,
    ac: true,
    layout: '2+2',
    berths: true,
    capacity: 53,
    capacitySource: 'secondary',
    corporations: ['KSRTC', 'NWKRTC', 'KKRTC'],
  },
  {
    id: 'ambaari_utsav',
    name: 'Ambaari Utsav',
    reserved: true,
    ac: true,
    layout: '2+1',
    berths: true,
    capacity: 40,
    capacitySource: 'secondary',
    corporations: ['KSRTC'],
  },
  {
    id: 'pallakki',
    name: 'Pallakki',
    reserved: true,
    ac: false,
    layout: '2+1',
    berths: true,
    capacity: 30,
    capacitySource: 'secondary',
    corporations: ['KSRTC', 'NWKRTC', 'KKRTC'],
  },
]

export function serviceClassById(id: string): ServiceClass | null {
  return SERVICE_CLASSES.find((serviceClass) => serviceClass.id === id) ?? null
}

/**
 * Loads and validates `data/bundle/corridor-classes.json` - the committed
 * bundle a running service actually reads, mirroring `loadMetroTopology`'s
 * relationship to `metro-topology.json`. `requiredIds` is
 * `INTERCITY_SERVICE_CLASSES` (config.ts): §12.1 requires startup to fail,
 * naming the missing ones, if the configured set is not a subset of what the
 * bundle actually defines.
 */
export async function loadServiceClasses(
  path: string,
  requiredIds: readonly string[] = [],
): Promise<readonly ServiceClass[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as readonly ServiceClass[]
  validateServiceClasses(raw, requiredIds)
  return raw
}

export function validateServiceClasses(
  classes: readonly ServiceClass[],
  requiredIds: readonly string[] = [],
): void {
  const ids = new Set(classes.map((serviceClass) => serviceClass.id))
  if (ids.size !== classes.length) throw new Error('Duplicate service class id in the class table')
  const missing = requiredIds.filter((id) => !ids.has(id as ServiceClassId))
  if (missing.length > 0) {
    throw new Error(`INTERCITY_SERVICE_CLASSES names classes missing from the class table: ${missing.join(', ')}`)
  }
  for (const serviceClass of classes) {
    if (serviceClass.capacity <= 0) {
      throw new Error(`Service class ${serviceClass.id} must have a positive capacity`)
    }
    if (serviceClass.corporations.length === 0) {
      throw new Error(`Service class ${serviceClass.id} names no corporation that runs it`)
    }
  }
}
