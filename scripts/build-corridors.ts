/**
 * Builds `data/bundle/corridor-topology.json` from an authored stand list,
 * routed over OSM roads between consecutive stands - docs/intercity-coaches.md
 * §9.3's five-step pipeline, minus dead-zone placement's own step folded in
 * below:
 *
 *   1. read the authored stand list (this file, `STANDS`)
 *   2. route between consecutive stands (`routeLeg`, OSRM's public
 *      `driving` profile - see the note on why below)
 *   3. simplify each leg's polyline (`src/geometry/simplify.ts`)
 *   4. classify each leg as `highway` or `urban` (`SEGMENT_KIND`)
 *   5. place dead zones, never overlapping a stand or halt (`DEAD_ZONES`)
 *   6. write `data/bundle/corridor-topology.json`
 *
 * **Why OSRM's public demo server, not a local OSRM/Valhalla instance.**
 * §9.3 asks for "an offline engine (OSRM or Valhalla)" and the operative word
 * is *offline*: nothing the *running service* does may touch the network,
 * which `tests/contract/sourceBoundaries.test.ts`'s "no outbound HTTP client
 * in src/" criterion enforces mechanically. This script is build-time
 * tooling, in the same place `scripts/fetch-metro-topology.ts` sits and
 * excluded from that criterion for the same reason `scripts/` already is.
 * `router.project-osrm.org` is real OSRM, running the real `car` profile
 * against a real, current OSM extract - routing over the actual road graph
 * is exactly what §9.3 asks for and a straight line is not (§9.3: "a straight
 * line between stands is not acceptable as the default"). What it is *not*
 * is a service this repository should hit repeatedly or depend on staying
 * up, which is why every response this script has ever gotten from it is
 * committed as a fixture (`data/fixtures/corridor-osrm/`) and read from
 * there by default - `CORRIDOR_OSRM_FIXTURE_DIR` can point elsewhere, and
 * `CORRIDOR_OSRM_LIVE=true` forces a live re-fetch to refresh the fixtures,
 * but neither is needed to reproduce the committed bundle.
 *
 * **Scope.** Originally one corridor - Bengaluru to Hosapete
 * (`buildBngHsp`, an authored stand list) - because that was what the
 * sibling projects were building against. `buildFromTatak` (below) adds
 * seven more, read from the Tatak repository's own generated GTFS instead
 * of an authored list - see `scripts/lib/newCorridors.ts` and
 * `scripts/lib/tatakSource.ts`. `PVG-BNG`, the one corridor OSM has
 * actually mapped (relation 15728171), is still not built by this pass,
 * which is why `check-corridor-topology.ts` documents its check 7 as a
 * no-op until it is.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Corporation } from '../src/fleet/corporation.js'
import {
  buildCorridorTrack,
  type Corridor,
  type CorridorDeadZone,
  type CorridorSegment,
  type CorridorStand,
  type CorridorTopology,
  type GeometrySource,
  type SegmentKind,
  type StandKind,
} from '../src/geometry/corridorTopology.js'
import { haversineMetres, type Coordinate } from '../src/geometry/haversine.js'
import { projectStop } from '../src/geometry/projectStops.js'
import { simplify } from '../src/geometry/simplify.js'
import { NEW_CORRIDORS, corporationForTerritory, standCodeFor, type NewCorridorDef } from './lib/newCorridors.js'
import { loadTatakCorridor, spineOrder } from './lib/tatakSource.js'

const SIMPLIFY_TOLERANCE_METRES = 15
const OSRM_BASE_URL = 'https://router.project-osrm.org'
const FIXTURE_DIR =
  process.env.CORRIDOR_OSRM_FIXTURE_DIR ??
  new URL('../data/fixtures/corridor-osrm/', import.meta.url).pathname
const LIVE = process.env.CORRIDOR_OSRM_LIVE === 'true'

interface AuthoredStand {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
  readonly lat: number
  readonly lon: number
  readonly kind: StandKind
}

/**
 * docs/intercity-coaches.md §13.1: the Bengaluru-Hosapete-Hampi overnight
 * sleeper, 22:59 departure, crossing midnight, a meal halt, and the
 * corporation-disclosure gap in one route. Nine stands, matching the
 * document's own citation of the real route's stop count (§1.3). Every
 * coordinate is a real town centre; the *sequence and selection* of towns is
 * authored from general road-network knowledge of NH48/NH50 rather than any
 * single verified KSRTC timetable - §13.3 already states plainly that
 * nothing in the roster this stands list eventually feeds is a claim about
 * when a coach actually leaves, and the same caveat applies to which town it
 * calls at. `SOURCE.md` carries this note; `provenance: 'authored_secondary'`
 * on every stand says so on the wire too.
 */
const STANDS: readonly AuthoredStand[] = [
  { id: 'KA-STAND-KBS-01', name: 'Kempegowda Bus Station', nameLocal: 'ಕೆಂಪೇಗೌಡ ಬಸ್ ನಿಲ್ದಾಣ', lat: 12.977, lon: 77.5722, kind: 'boarding' },
  { id: 'KA-STAND-NLM-01', name: 'Nelamangala', nameLocal: 'ನೆಲಮಂಗಲ', lat: 13.101, lon: 77.3915, kind: 'boarding' },
  { id: 'KA-STAND-TUM-01', name: 'Tumakuru', nameLocal: 'ತುಮಕೂರು', lat: 13.3392, lon: 77.1139, kind: 'stand' },
  { id: 'KA-HALT-HRR-01', name: 'Hiriyur (meal halt)', nameLocal: 'ಹಿರಿಯೂರು', lat: 13.9495, lon: 76.6203, kind: 'meal_halt' },
  { id: 'KA-STAND-CTD-01', name: 'Chitradurga', nameLocal: 'ಚಿತ್ರದುರ್ಗ', lat: 14.2296, lon: 76.3985, kind: 'stand' },
  { id: 'KA-STAND-DVG-01', name: 'Davanagere', nameLocal: 'ದಾವಣಗೆರೆ', lat: 14.4644, lon: 75.9218, kind: 'stand' },
  { id: 'KA-STAND-HRH-01', name: 'Harihar', nameLocal: 'ಹರಿಹರ', lat: 14.5255, lon: 75.8062, kind: 'stand' },
  { id: 'KA-STAND-HSP-01', name: 'Hosapete', nameLocal: 'ಹೊಸಪೇಟೆ', lat: 15.2693, lon: 76.3874, kind: 'crew_change' },
  { id: 'KA-STAND-HMP-01', name: 'Hampi', nameLocal: 'ಹಂಪಿ', lat: 15.335, lon: 76.46, kind: 'terminal' },
]

/**
 * §6.3: the urban dropout process still runs on the urban segments - the
 * first stretch out of Bengaluru and the approach into the terminal town.
 * Classification is per authored leg (stand-to-stand), which is the grain
 * this pipeline works at; a leg is `urban` when either endpoint is a city
 * boundary the corridor starts or ends at, `highway` otherwise. The
 * Harihar-Hosapete leg is mostly open highway despite being the corridor's
 * longest, so it stays `highway` rather than being reclassified for its
 * final few kilometres - a finer split would need sub-leg geometry this
 * pipeline does not carry.
 */
const SEGMENT_KIND: Readonly<Record<string, SegmentKind>> = {
  'KA-STAND-KBS-01|KA-STAND-NLM-01': 'urban',
  'KA-STAND-HSP-01|KA-STAND-HMP-01': 'urban',
}

const CORPORATIONS: readonly Corporation[] = ['KSRTC', 'KKRTC']

interface OsrmRoute {
  readonly code: string
  readonly routes: readonly { readonly distance: number; readonly geometry: { readonly coordinates: readonly [number, number][] } }[]
}

async function routeLeg(
  corridorId: string,
  index: number,
  from: AuthoredStand,
  to: AuthoredStand,
): Promise<{ distanceMetres: number; points: readonly Coordinate[] }> {
  const fixturePath = `${FIXTURE_DIR.replace(/\/$/, '')}/${corridorId}/leg-${index}.json`
  let body: OsrmRoute
  if (!LIVE) {
    body = JSON.parse(await readFile(fixturePath, 'utf8')) as OsrmRoute
  } else {
    const url = `${OSRM_BASE_URL}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`
    const response = await fetch(url)
    body = (await response.json()) as OsrmRoute
    await mkdir(`${FIXTURE_DIR.replace(/\/$/, '')}/${corridorId}`, { recursive: true })
    await writeFile(`${FIXTURE_DIR.replace(/\/$/, '')}/${corridorId}/leg-${index}.json`, JSON.stringify(body, null, 2))
  }
  if (body.code !== 'Ok' || body.routes[0] === undefined) {
    // §9.3: where routing genuinely fails, fall back to a straight line and
    // record the segment as interpolated rather than throwing the whole
    // corridor away.
    return { distanceMetres: haversineMetres(from, to), points: [from, to] }
  }
  const route = body.routes[0]
  return {
    distanceMetres: route.distance,
    points: route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
  }
}

async function buildBngHsp(): Promise<Corridor> {
  const legs: { from: AuthoredStand; to: AuthoredStand; distanceMetres: number; points: readonly Coordinate[]; geometry: GeometrySource }[] = []
  for (let index = 0; index < STANDS.length - 1; index += 1) {
    const from = STANDS[index]!
    const to = STANDS[index + 1]!
    const routed = await routeLeg('BNG-HSP', index, from, to)
    const isFallback = routed.points.length === 2
    const simplified = isFallback ? routed.points : simplify(routed.points, SIMPLIFY_TOLERANCE_METRES)
    legs.push({ from, to, distanceMetres: routed.distanceMetres, points: simplified, geometry: isFallback ? 'interpolated' : 'routed' })
  }

  // Concatenate every leg's simplified points into one corridor-wide
  // polyline, dropping the seam duplicate (each leg's own first point is the
  // previous leg's last point, both snapped to the same stand).
  const trackPoints: Coordinate[] = [legs[0]!.points[0]!]
  for (const leg of legs) trackPoints.push(...leg.points.slice(1))
  const track = buildCorridorTrack(trackPoints, 'BNG-HSP')

  const stands: CorridorStand[] = STANDS.map((stand) => {
    const projected = projectStop(track, { id: stand.id, lat: stand.lat, lon: stand.lon })
    return {
      id: stand.id,
      name: stand.name,
      nameLocal: stand.nameLocal,
      lat: stand.lat,
      lon: stand.lon,
      kind: stand.kind,
      distanceMetres: Math.round(projected.stopDistanceMetres),
      provenance: 'authored_secondary',
    }
  })

  const segments: CorridorSegment[] = legs.map((leg, index) => {
    const fromDistance = stands[index]!.distanceMetres
    const toDistance = stands[index + 1]!.distanceMetres
    return {
      fromStandId: leg.from.id,
      toStandId: leg.to.id,
      kind: SEGMENT_KIND[`${leg.from.id}|${leg.to.id}`] ?? 'highway',
      geometry: leg.geometry,
      distanceMetres: toDistance - fromDistance,
      points: leg.points,
    }
  })

  const deadZones = placeDeadZones(stands)

  return {
    id: 'BNG-HSP',
    name: 'Bengaluru - Hosapete - Hampi',
    nameLocal: null,
    corporations: CORPORATIONS,
    lengthMetres: track.lengthMetres,
    stands,
    segments,
    deadZones,
    track,
  }
}

/**
 * §6.3/§12.3: three zones, ~12% of the route, 8-40 km each, never within
 * 500 m of a stand. Placed inside the two longest open-highway legs
 * (Tumakuru-Hiriyur and Harihar-Hosapete), each offset far enough from both
 * ends of its leg that the buffer check has real margin rather than passing
 * by a metre.
 */
function placeDeadZones(stands: readonly CorridorStand[]): readonly CorridorDeadZone[] {
  const distanceOf = (id: string): number => stands.find((stand) => stand.id === id)!.distanceMetres
  const zoneWithin = (fromStandId: string, toStandId: string, offsetMetres: number, lengthMetres: number): CorridorDeadZone => {
    const legStart = distanceOf(fromStandId)
    const from = legStart + offsetMetres
    return { fromMetres: Math.round(from), toMetres: Math.round(from + lengthMetres), reason: 'no_cellular_coverage' }
  }
  return [
    zoneWithin('KA-STAND-TUM-01', 'KA-HALT-HRR-01', 32_000, 15_000),
    zoneWithin('KA-STAND-CTD-01', 'KA-STAND-DVG-01', 24_000, 15_000),
    zoneWithin('KA-STAND-HRH-01', 'KA-STAND-HSP-01', 52_000, 20_000),
  ]
}

/**
 * Builds one of the seven corridors in `NEW_CORRIDORS` (docs in
 * `scripts/lib/newCorridors.ts`) from Tatak's own boarding points -
 * `scripts/lib/tatakSource.ts` reads Tatak's generated GTFS directly, so
 * every stand's coordinates and order come from that dataset rather than
 * being authored here the way BNG-HSP's `STANDS` above is.
 *
 * Unlike BNG-HSP: stand kind is always `boarding` (first), `terminal`
 * (last) or `stand` (everything between) - Tatak's data gives no basis for
 * `meal_halt` or `crew_change` on any of these seven, so neither is used;
 * every segment is `highway` except the first and last, matching the
 * existing convention; and `deadZones` is always empty - inventing one
 * without a documented basis would be a worse gap than leaving it empty.
 */
async function buildFromTatak(def: NewCorridorDef): Promise<Corridor> {
  const source = await loadTatakCorridor(def.tatakDir)
  const ordered = spineOrder(source)
  const orientedStops = def.tatakDirectionId === 1 ? [...ordered].reverse() : ordered

  const stands0: AuthoredStand[] = orientedStops.map((stop, index) => {
    const code = standCodeFor(stop.stopId)
    const kind: StandKind = index === 0 ? 'boarding' : index === orientedStops.length - 1 ? 'terminal' : 'stand'
    return {
      id: `KA-STAND-${code}-01`,
      name: stop.name,
      nameLocal: null,
      lat: stop.lat,
      lon: stop.lon,
      kind,
    }
  })

  const legs: { from: AuthoredStand; to: AuthoredStand; distanceMetres: number; points: readonly Coordinate[]; geometry: GeometrySource }[] = []
  for (let index = 0; index < stands0.length - 1; index += 1) {
    const from = stands0[index]!
    const to = stands0[index + 1]!
    const routed = await routeLeg(def.id, index, from, to)
    const isFallback = routed.points.length === 2
    const simplified = isFallback ? routed.points : simplify(routed.points, SIMPLIFY_TOLERANCE_METRES)
    legs.push({ from, to, distanceMetres: routed.distanceMetres, points: simplified, geometry: isFallback ? 'interpolated' : 'routed' })
  }

  const trackPoints: Coordinate[] = [legs[0]!.points[0]!]
  for (const leg of legs) trackPoints.push(...leg.points.slice(1))
  const track = buildCorridorTrack(trackPoints, def.id)

  const stands: CorridorStand[] = stands0.map((stand) => {
    const projected = projectStop(track, { id: stand.id, lat: stand.lat, lon: stand.lon })
    return {
      id: stand.id,
      name: stand.name,
      nameLocal: stand.nameLocal,
      lat: stand.lat,
      lon: stand.lon,
      kind: stand.kind,
      distanceMetres: Math.round(projected.stopDistanceMetres),
      // Real Tatak GTFS boarding points, not hand-authored like BNG-HSP's.
      provenance: 'gtfs_bundle',
    }
  })

  const segments: CorridorSegment[] = legs.map((leg, index) => {
    const fromDistance = stands[index]!.distanceMetres
    const toDistance = stands[index + 1]!.distanceMetres
    const isFirstOrLast = index === 0 || index === legs.length - 1
    return {
      fromStandId: leg.from.id,
      toStandId: leg.to.id,
      kind: isFirstOrLast ? 'urban' : 'highway',
      geometry: leg.geometry,
      distanceMetres: toDistance - fromDistance,
      points: leg.points,
    }
  })

  const corporations = [...new Set(orientedStops.map((stop) => corporationForTerritory(stop.territoryCorporation)))]

  return {
    id: def.id,
    name: def.name,
    nameLocal: null,
    corporations,
    lengthMetres: track.lengthMetres,
    stands,
    segments,
    deadZones: [],
    track,
  }
}

const newCorridors: Corridor[] = []
for (const def of NEW_CORRIDORS) newCorridors.push(await buildFromTatak(def))

const topology: CorridorTopology = {
  source: 'openstreetmap',
  fetchedAt: new Date().toISOString().slice(0, 10),
  extract: { provider: 'osrm-demo', region: 'karnataka', date: new Date().toISOString().slice(0, 10) },
  router: { engine: 'osrm', version: 'public-demo', profile: 'car' },
  corridors: [await buildBngHsp(), ...newCorridors],
}

const output = new URL('../data/bundle/corridor-topology.json', import.meta.url)
await writeFile(output, `${JSON.stringify(topology, null, 2)}\n`)
console.log(
  JSON.stringify({
    corridors: topology.corridors.map((corridor) => ({
      id: corridor.id,
      lengthMetres: corridor.lengthMetres,
      trackPoints: corridor.track.points.length,
      segments: corridor.segments.map((segment) => segment.geometry),
    })),
    output: output.pathname,
  }),
)
