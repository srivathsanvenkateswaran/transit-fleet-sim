/**
 * Appends roster entries for the seven `NEW_CORRIDORS` (see
 * `scripts/lib/newCorridors.ts`) to `data/bundle/corridor-roster.json`,
 * read from the same Tatak GTFS `scripts/build-corridors.ts` reads for
 * topology. BNG-HSP's existing block is preserved byte-for-byte; this
 * script only ever replaces the entries for the seven new corridor ids.
 *
 * For every corridor and its chosen physical direction (see
 * `NEW_CORRIDORS`'s own comment on why some are reversed from what the id's
 * letters suggest), a trip becomes a roster departure only if all of:
 *
 *   - its Tatak `direction_id` matches the corridor's chosen direction,
 *   - it carries a real (non-null) `tatak_service_number`,
 *   - that number is not one of the four Tatak assigns to two different
 *     corridors at once (`AMBIGUOUS_SERVICE_NUMBERS` - both occurrences are
 *     dropped, since Tatak's data does not say which corridor is real),
 *   - its class maps to a `ServiceClassId` this simulator actually has
 *     (`CLASS_MAP`) - `karnataka_sarige` included, since this simulator
 *     tracks the unreserved class even though ondc-transit-bpp will not
 *     sell a seat on it.
 *
 * DND-ANK has zero real service numbers in Tatak's data in either
 * direction - its own three generated Dandeli-to-Ankola departures are
 * rostered instead, `confidence: "invented"`, following the exact
 * convention BNG-HSP's own invented rows already use (serviceId shaped
 * like `<HHMM><ORIGIN><DEST>`) rather than pretending a generated trip has
 * a real number.
 *
 * Regenerate with: `npx tsx scripts/build-corridor-roster.ts`
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fixtureHub } from '../src/fleet/corporation.js'
import type { RosterCorridor, RosterDeparture } from '../src/sim/corridorRoster.js'
import { AMBIGUOUS_SERVICE_NUMBERS, CLASS_MAP, NEW_CORRIDORS, type NewCorridorDef } from './lib/newCorridors.js'
import { loadTatakCorridor, type TatakCorridorSource, type TatakTrip } from './lib/tatakSource.js'

function departureTimeOf(source: TatakCorridorSource, trip: TatakTrip): string {
  const calls = source.stopTimesByTrip.get(trip.tripId) ?? []
  const first = [...calls].sort((a, b) => a.stopSequence - b.stopSequence)[0]
  if (first === undefined) throw new Error(`Trip ${trip.tripId} has no stop_times rows`)
  // HH:MM, dropping the GTFS :SS - the origin call is always same-day (<24:00).
  return first.departureTime.slice(0, 5)
}

function corporationFor(hub: string): string {
  const registered = fixtureHub(hub)
  if (registered === null) throw new Error(`Hub ${hub} is not in FIXTURE_HUBS`)
  return registered.corporation
}

function buildCorridorRoster(def: NewCorridorDef, source: TatakCorridorSource): RosterCorridor {
  const corporation = corporationFor(def.hub)
  const real = source.trips.filter(
    (trip) =>
      trip.directionId === def.tatakDirectionId &&
      trip.serviceNumber !== null &&
      !AMBIGUOUS_SERVICE_NUMBERS.has(trip.serviceNumber) &&
      CLASS_MAP[source.routes.get(trip.routeId)?.serviceClass ?? ''] !== undefined,
  )

  const departures: RosterDeparture[] = real.map((trip) => {
    const serviceClass = CLASS_MAP[source.routes.get(trip.routeId)!.serviceClass]!
    return {
      serviceId: trip.serviceNumber!,
      number: trip.serviceNumber!,
      headsign: trip.headsign,
      departureTime: departureTimeOf(source, trip),
      serviceClass,
      hub: def.hub,
      corporation,
      confidence: 'secondary_unverified',
      note: `scripts/build-corridor-roster.ts, from Tatak ${def.tatakId} (data/intercity/${def.tatakDir}/trips.txt, trip ${trip.tripId}). Tatak's own provenance for this service number is "${trip.provenance}", not primary-confirmed - see that repository's src/intercity/corridors/*.ts for the underlying source.`,
    }
  })

  if (departures.length === 0) {
    // DND-ANK: no real service number anywhere in Tatak's data for this
    // corridor. Roster its own generated departures instead, invented and
    // labelled as such - the exact convention BNG-HSP's own invented rows
    // already use - so the corridor still has a coach to track.
    const generated = source.trips.filter(
      (trip) => trip.directionId === def.tatakDirectionId && CLASS_MAP[source.routes.get(trip.routeId)?.serviceClass ?? ''] !== undefined,
    )
    for (const trip of generated) {
      const serviceClass = CLASS_MAP[source.routes.get(trip.routeId)!.serviceClass]!
      const time = departureTimeOf(source, trip)
      const placeholderId = `${time.replace(':', '')}${def.id.replace('-', '')}`
      departures.push({
        serviceId: placeholderId,
        number: placeholderId,
        headsign: trip.headsign,
        departureTime: time,
        serviceClass,
        hub: def.hub,
        corporation,
        confidence: 'invented',
        note: `scripts/build-corridor-roster.ts. Tatak (data/intercity/${def.tatakDir}/trips.txt, trip ${trip.tripId}) carries no real service number for this corridor in either direction, so this id is fabricated in the same shape BNG-HSP's own invented rows use (<HHMM><ORIGIN><DEST>), not a claim about a real KSRTC working.`,
      })
    }
  }

  departures.sort((a, b) => a.departureTime.localeCompare(b.departureTime))
  return { corridorId: def.id, departures }
}

const rosterPath = new URL('../data/bundle/corridor-roster.json', import.meta.url)
const existing = JSON.parse(await readFile(rosterPath, 'utf8')) as {
  note: string
  provenance: { departures: string; stands: string }
  corridors: RosterCorridor[]
}

const newIds = new Set(NEW_CORRIDORS.map((def) => def.id))
const preserved = existing.corridors.filter((corridor) => !newIds.has(corridor.corridorId))

const generated: RosterCorridor[] = []
const summary: { id: string; real: number; invented: number; classesDropped: string[] }[] = []
for (const def of NEW_CORRIDORS) {
  const source = await loadTatakCorridor(def.tatakDir)
  const corridor = buildCorridorRoster(def, source)
  generated.push(corridor)
  const real = corridor.departures.filter((d) => d.confidence === 'secondary_unverified').length
  const invented = corridor.departures.filter((d) => d.confidence === 'invented').length
  const droppedClasses = [...new Set(source.trips.map((trip) => source.routes.get(trip.routeId)?.serviceClass ?? '').filter((cls) => CLASS_MAP[cls] === undefined))]
  summary.push({ id: def.id, real, invented, classesDropped: droppedClasses })
}

const output = {
  ...existing,
  corridors: [...preserved, ...generated],
}

await writeFile(rosterPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify({ output: rosterPath.pathname, summary }, null, 2))
