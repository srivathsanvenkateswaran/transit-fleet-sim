import { readFile } from 'node:fs/promises'
import type { Corporation } from '../fleet/corporation.js'
import { haversineMetres, type Coordinate } from './haversine.js'
import { projectStop, type StopCoordinate } from './projectStops.js'
import { buildShapeIndex, type ShapeIndex } from './shape.js'

/**
 * docs/intercity-coaches.md §4.1: a corridor's stop list is not homogeneous.
 * `terminal` has no dwell of its own - the run ends there.
 */
export type StandKind = 'boarding' | 'stand' | 'meal_halt' | 'crew_change' | 'terminal'

/**
 * §12.6: one mean speed across both kinds is what would make a 340 km run
 * come out ninety minutes wrong. The cursor draws against the segment kind it
 * is on - this document's scope does not reach that far (that is stage 5/6),
 * but the segment carries the fact now so a later stage does not have to
 * reclassify committed geometry to get it.
 */
export type SegmentKind = 'highway' | 'urban'

export type GeometrySource = 'routed' | 'interpolated' | 'osm_relation'

export interface CorridorStand extends Coordinate {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
  readonly kind: StandKind
  readonly distanceMetres: number
  /** §9.5: this document does not harvest aggregators at build time; every stand here is authored, and says so. */
  readonly provenance: 'gtfs_bundle' | 'osm' | 'authored_secondary'
}

export interface CorridorSegment {
  readonly fromStandId: string
  readonly toStandId: string
  readonly kind: SegmentKind
  readonly geometry: GeometrySource
  readonly distanceMetres: number
  readonly points: readonly Coordinate[]
}

/** §6.3: an interval of route distance, not a seeded draw - authored per corridor, in open country only. */
export interface CorridorDeadZone {
  readonly fromMetres: number
  readonly toMetres: number
  readonly reason: 'no_cellular_coverage'
}

export interface Corridor {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
  readonly corporations: readonly Corporation[]
  readonly lengthMetres: number
  readonly stands: readonly CorridorStand[]
  readonly segments: readonly CorridorSegment[]
  readonly deadZones: readonly CorridorDeadZone[]
  /** The whole corridor's routed polyline, indexed once at build time - the same relationship `MetroLine.track` has to `metro-topology.json`. */
  readonly track: ShapeIndex
}

export interface CorridorTopology {
  readonly source: 'openstreetmap'
  readonly fetchedAt: string
  readonly extract: { readonly provider: string; readonly region: string; readonly date: string }
  readonly router: { readonly engine: string; readonly version: string; readonly profile: string }
  readonly corridors: readonly Corridor[]
}

export interface CorridorTopologyLimits {
  readonly maxDetourRatio: number
  readonly maxStandGapMetres: number
  readonly maxStandOffsetMetres: number
}

export const DEFAULT_CORRIDOR_LIMITS: CorridorTopologyLimits = {
  // 1.6 held for BNG-HSP alone. DND-ANK (Dandeli to Ankola) is a real ghat
  // crossing - Dandeli sits inside the Western Ghats forest and the only
  // drivable road out to the coast at Ankola goes the long way round via
  // Yellapur; a real, live OSRM route between the two towns comes back at
  // a 1.79 ratio against the straight-line distance (132 km routed against
  // 73.6 km direct). Raised to 1.85 rather than dropping the check or the
  // corridor, so the check still catches an actual bad route.
  maxDetourRatio: 1.85,
  maxStandGapMetres: 180_000,
  maxStandOffsetMetres: 500,
}

/**
 * OSM relation `15728171` (Pavagada => Bengaluru) is the one corridor OSM has
 * actually mapped, and §9.4 check 7 validates the routing pipeline against
 * its own stitched way geometry - the only independent check in the whole
 * pipeline. It is not part of the fixture set this pass builds (the task
 * scopes this stage to Bengaluru-Hosapete alone), so this constant exists to
 * make that omission a named, checkable gap rather than a silent one:
 * `validateCorridorTopology` runs check 7 whenever a corridor claims this
 * relation as its source and is a documented no-op otherwise.
 */
export const PAVAGADA_OSM_RELATION_ID = 15_728_171

export async function loadCorridorTopology(
  path: string,
  limits: CorridorTopologyLimits = DEFAULT_CORRIDOR_LIMITS,
): Promise<CorridorTopology> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as CorridorTopology
  validateCorridorTopology(raw, limits)
  return raw
}

export function corridorById(topology: CorridorTopology, id: string): Corridor | null {
  return topology.corridors.find((corridor) => corridor.id === id) ?? null
}

/**
 * docs/intercity-coaches.md §9.4's seven-check integrity gate, minus check 7
 * (Pavagada against its own OSM relation - see `PAVAGADA_OSM_RELATION_ID`),
 * which has no corridor to run against until `PVG-BNG` is built. Every other
 * check runs unconditionally and mirrors the four `metroTopology.ts` checks
 * this repository already trusts: this is a build-time script's output,
 * loaded and re-validated on every process start, exactly like
 * `metro-topology.json`.
 */
export function validateCorridorTopology(
  topology: CorridorTopology,
  limits: CorridorTopologyLimits = DEFAULT_CORRIDOR_LIMITS,
): void {
  for (const corridor of topology.corridors) {
    checkStandOrderAndGap(corridor, limits)
    checkDetourRatio(corridor, limits)
    checkMonotonicTrack(corridor)
    checkStandProjection(corridor, limits)
    checkDeadZonesInOpenCountry(corridor)
  }
}

// Check 2 (stand order never re-sorted by coordinate) and check 3 (stand
// gap): both fall out of one pass over consecutive stands' own
// `distanceMetres`, which is the field a coordinate re-sort would corrupt
// without anyone touching the numbers - exactly the failure mode the check
// exists to catch.
function checkStandOrderAndGap(corridor: Corridor, limits: CorridorTopologyLimits): void {
  for (let index = 1; index < corridor.stands.length; index += 1) {
    const previous = corridor.stands[index - 1]!
    const current = corridor.stands[index]!
    if (current.distanceMetres < previous.distanceMetres) {
      throw new Error(
        `Corridor ${corridor.id} has stand ${current.id} out of distance order after ${previous.id} - stands must never be re-sorted by coordinate`,
      )
    }
    const gap = current.distanceMetres - previous.distanceMetres
    if (gap > limits.maxStandGapMetres) {
      throw new Error(
        `Corridor ${corridor.id} has a ${Math.round(gap)}m gap between ${previous.id} and ${current.id}, exceeding ${limits.maxStandGapMetres}m`,
      )
    }
  }
}

// Check 1: routed length against the great-circle distance between endpoints.
function checkDetourRatio(corridor: Corridor, limits: CorridorTopologyLimits): void {
  const first = corridor.stands[0]
  const last = corridor.stands.at(-1)
  if (first === undefined || last === undefined) return
  const greatCircle = haversineMetres(first, last)
  if (greatCircle === 0) return
  const ratio = corridor.lengthMetres / greatCircle
  if (ratio > limits.maxDetourRatio) {
    throw new Error(
      `Corridor ${corridor.id} has a detour ratio of ${ratio.toFixed(2)}, exceeding ${limits.maxDetourRatio}`,
    )
  }
}

// Check 4: monotonic cumulative distance, exactly as `measureShapeDistances`
// already guarantees `buildShapeIndex`'s output - asserted here as a
// property of the *committed* file, in case it is ever hand-edited.
function checkMonotonicTrack(corridor: Corridor): void {
  for (let index = 1; index < corridor.track.points.length; index += 1) {
    const previous = corridor.track.points[index - 1]!
    const current = corridor.track.points[index]!
    if (current.cumulativeDistanceMetres < previous.cumulativeDistanceMetres) {
      throw new Error(`Corridor ${corridor.id}'s track is not monotonic at point ${index}`)
    }
  }
}

// Check 5: every stand projects close to the routed line - 500 m by default,
// wider than the city's 150 m (§9.4: "a bus stand is a compound and the
// routed line is the carriageway").
function checkStandProjection(corridor: Corridor, limits: CorridorTopologyLimits): void {
  for (const stand of corridor.stands) {
    const stopCoordinate: StopCoordinate = { id: stand.id, lat: stand.lat, lon: stand.lon }
    const projected = projectStop(corridor.track, stopCoordinate)
    if (projected.offsetMetres > limits.maxStandOffsetMetres) {
      throw new Error(
        `Corridor ${corridor.id}'s stand ${stand.id} is ${Math.round(projected.offsetMetres)}m off the routed line, exceeding ${limits.maxStandOffsetMetres}m`,
      )
    }
  }
}

// Check 6: a dead zone never covers a stand or a halt, or the 500 m either
// side of one (§6.3: a stand is a town and a town has a tower).
function checkDeadZonesInOpenCountry(corridor: Corridor): void {
  const BUFFER_METRES = 500
  for (const zone of corridor.deadZones) {
    if (zone.toMetres <= zone.fromMetres) {
      throw new Error(`Corridor ${corridor.id} has an empty or reversed dead zone [${zone.fromMetres}, ${zone.toMetres}]`)
    }
    for (const stand of corridor.stands) {
      const overlaps =
        stand.distanceMetres >= zone.fromMetres - BUFFER_METRES &&
        stand.distanceMetres <= zone.toMetres + BUFFER_METRES
      if (overlaps) {
        throw new Error(
          `Corridor ${corridor.id}'s dead zone [${zone.fromMetres}, ${zone.toMetres}] overlaps stand ${stand.id} within ${BUFFER_METRES}m`,
        )
      }
    }
  }
}

export function buildCorridorTrack(points: readonly Coordinate[], id: string): ShapeIndex {
  return buildShapeIndex(
    id,
    points.map((point, sequence) => ({ ...point, sequence })),
  )
}

/**
 * The other physical direction over the same road.
 *
 * docs/intercity-coaches.md never named a "reverse corridor" because the
 * corridor build pipeline only ever modelled one direction per id - see
 * `NEW_CORRIDORS`'s own comment in `scripts/lib/newCorridors.ts` on why. A
 * real Tatak service running the opposite way was therefore simply dropped
 * from every roster, which is the "single-direction roster mechanism"
 * limitation the coach coverage pass ran into.
 *
 * This is the honest fix rather than a second corridor: the road, the OSRM
 * geometry and the dead zones are the same asphalt travelled the other way,
 * so nothing here invents a fixture or a highway-spanning route. It mirrors
 * the committed track (haversine leg lengths are symmetric, so summing them
 * in the reverse order reproduces the same cumulative distances to within
 * floating-point rounding), re-projects every stand onto that mirrored track
 * exactly as `build-corridors.ts` does for the forward direction, and swaps
 * `boarding` and `terminal` on the two ends - the towns in between keep
 * whatever kind they already had, because a meal halt or a crew change is
 * still that halt travelled backwards.
 *
 * The result satisfies every check `validateCorridorTopology` runs - see
 * `tests/geometry/corridorTopology.test.ts`'s "the reverse of a corridor is
 * itself a valid corridor" case - even though it is never written to
 * `corridor-topology.json` and never reloaded through `loadCorridorTopology`.
 * It exists only in memory, built once per corridor a bidirectional roster
 * actually uses (`corridorRoster.ts`'s `buildRoster` and `coachWorld.ts`'s
 * `CoachSimulation`), for exactly the corridors whose roster carries a
 * `direction: 'reverse'` departure.
 */
export function reverseCorridor(corridor: Corridor): Corridor {
  const reversedPoints = [...corridor.track.points].map((point) => ({ lat: point.lat, lon: point.lon })).reverse()
  const track = buildCorridorTrack(reversedPoints, corridor.id)

  const standOrder = [...corridor.stands].reverse()
  const stands: CorridorStand[] = standOrder.map((stand, index) => {
    const projected = projectStop(track, { id: stand.id, lat: stand.lat, lon: stand.lon })
    const kind: StandKind = index === 0 ? 'boarding' : index === standOrder.length - 1 ? 'terminal' : stand.kind
    return {
      ...stand,
      kind,
      distanceMetres: Math.round(projected.stopDistanceMetres),
    }
  })
  const distanceById = new Map(stands.map((stand) => [stand.id, stand.distanceMetres]))

  const segments: CorridorSegment[] = [...corridor.segments].reverse().map((segment) => {
    const fromDistance = distanceById.get(segment.toStandId) ?? 0
    const toDistance = distanceById.get(segment.fromStandId) ?? 0
    return {
      fromStandId: segment.toStandId,
      toStandId: segment.fromStandId,
      kind: segment.kind,
      geometry: segment.geometry,
      distanceMetres: toDistance - fromDistance,
      points: [...segment.points].reverse(),
    }
  })

  const deadZones: CorridorDeadZone[] = [...corridor.deadZones]
    .map((zone) => ({
      fromMetres: corridor.lengthMetres - zone.toMetres,
      toMetres: corridor.lengthMetres - zone.fromMetres,
      reason: zone.reason,
    }))
    .sort((a, b) => a.fromMetres - b.fromMetres)

  return {
    id: corridor.id,
    name: corridor.name,
    nameLocal: corridor.nameLocal,
    corporations: corridor.corporations,
    lengthMetres: track.lengthMetres,
    stands,
    segments,
    deadZones,
    track,
  }
}
