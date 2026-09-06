/**
 * Appends roster entries for the eleven `NEW_CORRIDORS` (see
 * `scripts/lib/newCorridors.ts`) to `data/bundle/corridor-roster.json`,
 * read from the same Tatak GTFS `scripts/build-corridors.ts` reads for
 * topology. BNG-HSP's existing block is preserved rather than replaced -
 * its topology stays the hand-authored one with the meal halt, the crew
 * change and the three dead zones, none of which Tatak's own plainer stop
 * list carries - but it is no longer byte-for-byte untouched: `withBngHsp
 * Additions` below tops it up with whatever real BNG-HSP service numbers
 * Tatak's `KA-BNG-HMP` feed carries that the hand-authored block does not
 * already have a serviceId for. See that function's own comment for why an
 * addition rather than a replacement.
 *
 * For every corridor and its chosen physical direction (see
 * `NEW_CORRIDORS`'s own comment on why some are reversed from what the id's
 * letters suggest), a trip becomes a roster departure only if all of:
 *
 *   - its Tatak `direction_id` matches the corridor's chosen direction,
 *   - it carries a real (non-null) `tatak_service_number`,
 *   - that number is not one of the three Tatak assigns to two different
 *     corridors at once with no way to tell which is real
 *     (`AMBIGUOUS_SERVICE_NUMBERS` - both occurrences are dropped), and is
 *     not exclusively reserved for a different corridor than this one
 *     (`CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS` - a real through-service Tatak
 *     legitimately sights on more than one feed, kept on the one it
 *     physically belongs to and skipped on every other),
 *   - its class maps to a `ServiceClassId` this simulator actually has
 *     (`CLASS_MAP`) - `karnataka_sarige` included, since this simulator
 *     tracks the unreserved class even though ondc-transit-bpp will not
 *     sell a seat on it.
 *
 * DND-ANK and BNG-BDM both have zero usable real service numbers in Tatak's
 * data for their chosen direction - their own generated departures are
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
import {
  AMBIGUOUS_SERVICE_NUMBERS,
  CLASS_MAP,
  CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS,
  NEW_CORRIDORS,
  type NewCorridorDef,
} from './lib/newCorridors.js'
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
      (CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS[trip.serviceNumber] ?? def.id) === def.id &&
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
    // DND-ANK and BNG-BDM: no usable real service number anywhere in
    // Tatak's data for this corridor's chosen direction. Roster its own
    // generated departures instead, invented and labelled as such - the
    // exact convention BNG-HSP's own invented rows already use - so the
    // corridor still has a coach to track.
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

/**
 * BNG-HSP is not one of `NEW_CORRIDORS`: its topology is the hand-authored
 * nine-stand fixture with the meal halt, the crew change and the three
 * dead zones (`buildBngHsp` in `build-corridors.ts`), not Tatak's plainer
 * `KA-BNG-HMP` stop list, and rebuilding it from Tatak the way the other
 * ten corridors are built would throw all three away for no gain - the
 * roster's serviceId does not need the topology to match the source it
 * came from.
 *
 * So this corridor's roster is topped up rather than rebuilt: everything
 * already in the bundle (the three invented departures and the one
 * sourced `2259BNGHMP`) is kept exactly as it is, and every dir0
 * KARNATAKA_SARIGE, RAJAHAMSA_EXECUTIVE, AIRAVAT, AIRAVAT_CLUB_CLASS,
 * AMBAARI_UTSAV or PALLAKKI real service number `KA-BNG-HMP` carries that
 * this block does not already have a serviceId for is added beside it,
 * `confidence: "secondary_unverified"` like every other Tatak-sourced
 * departure this project rosters. `AC_SEATER_EXECUTIVE_CHAIR` and
 * `NON_AC_SLEEPER` real numbers on this corridor (0545BNGHSP, 1535BNGHSP,
 * 2314BNGHSP) are skipped by the same `CLASS_MAP` gap every other corridor
 * here has - this simulator has no fleet class for either.
 */
function withBngHspAdditions(preservedBngHsp: RosterCorridor, source: TatakCorridorSource): RosterCorridor {
  const corporation = corporationFor('KBS')
  const already = new Set(preservedBngHsp.departures.map((departure) => departure.serviceId))
  const additions = source.trips.filter(
    (trip) =>
      trip.directionId === 0 &&
      trip.serviceNumber !== null &&
      !already.has(trip.serviceNumber) &&
      CLASS_MAP[source.routes.get(trip.routeId)?.serviceClass ?? ''] !== undefined,
  )
  const newDepartures: RosterDeparture[] = additions.map((trip) => {
    const serviceClass = CLASS_MAP[source.routes.get(trip.routeId)!.serviceClass]!
    // "Hosapete Bus Stand" / "Hampi Bus Stand" -> "Hosapete" / "Hampi",
    // matching the one-word headsigns this corridor's own preserved rows
    // already use rather than introducing a second style.
    const headsign = trip.headsign.replace(/ Bus Stand$/, '')
    return {
      serviceId: trip.serviceNumber!,
      number: trip.serviceNumber!,
      headsign,
      departureTime: departureTimeOf(source, trip),
      serviceClass,
      hub: 'KBS',
      corporation,
      confidence: 'secondary_unverified',
      note: `scripts/build-corridor-roster.ts, from Tatak KA-BNG-HMP (data/intercity/ka-bng-hmp/trips.txt, trip ${trip.tripId}), added to BNG-HSP's existing roster rather than replacing it - see withBngHspAdditions. Tatak's own provenance for this service number is "${trip.provenance}", not primary-confirmed.`,
    }
  })
  const departures = [...preservedBngHsp.departures, ...newDepartures].sort((a, b) =>
    a.departureTime.localeCompare(b.departureTime),
  )
  return { corridorId: 'BNG-HSP', departures }
}

const rosterPath = new URL('../data/bundle/corridor-roster.json', import.meta.url)
const existing = JSON.parse(await readFile(rosterPath, 'utf8')) as {
  note: string
  provenance: { departures: string; stands: string }
  corridors: RosterCorridor[]
}

const newIds = new Set(NEW_CORRIDORS.map((def) => def.id))
const preserved = existing.corridors.filter((corridor) => !newIds.has(corridor.corridorId) && corridor.corridorId !== 'BNG-HSP')

const existingBngHsp = existing.corridors.find((corridor) => corridor.corridorId === 'BNG-HSP')
if (existingBngHsp === undefined) throw new Error('data/bundle/corridor-roster.json has no BNG-HSP block to top up')
const bngHspSource = await loadTatakCorridor('ka-bng-hmp')
const bngHsp = withBngHspAdditions(existingBngHsp, bngHspSource)
const bngHspAdded = bngHsp.departures.length - existingBngHsp.departures.length

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
  corridors: [...preserved, bngHsp, ...generated],
}

await writeFile(rosterPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify({ output: rosterPath.pathname, bngHspAdded, summary }, null, 2))
