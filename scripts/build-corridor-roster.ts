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
 * letters suggest), a trip becomes a `forward` roster departure only if all
 * of:
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
 * data for their chosen (`forward`) direction - their own generated
 * departures are rostered instead, `confidence: "invented"`, following the
 * exact convention BNG-HSP's own invented rows already use (serviceId
 * shaped like `<HHMM><ORIGIN><DEST>`) rather than pretending a generated
 * trip has a real number.
 *
 * **Bidirectional rosters.** Every real trip whose `direction_id` is the
 * *other* one used to be dropped outright, on every corridor, with no way
 * back in - the coach coverage pass's "single-direction roster mechanism"
 * gap. Where `NEW_CORRIDORS` names a `reverseHub` for a corridor, this
 * script now also rosters that corridor's real opposite-direction trips as
 * `direction: 'reverse'` departures, subject to the exact same four filters
 * above. `CoachSimulation` runs a `reverse` departure over
 * `reverseCorridor`'s mirrored geometry (`src/geometry/corridorTopology.ts`)
 * rather than a second corridor - the committed OSRM fixtures already cover
 * both directions of the same road, so nothing new is fetched. A corridor
 * with no `reverseHub` (DND-ANK) keeps its roster exactly as before: no
 * fixture hub exists for its far end, and inventing one to unlock a
 * direction with zero real numbers anyway would not have added a real coach.
 * No invented fallback is generated for the `reverse` direction - an
 * unrostered reverse leg is a gap this pass leaves open rather than a
 * fabricated one.
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

function realDeparturesFor(
  def: NewCorridorDef,
  source: TatakCorridorSource,
  tatakDirectionId: 0 | 1,
  hub: string,
  direction: 'forward' | 'reverse',
): RosterDeparture[] {
  const corporation = corporationFor(hub)
  const excluded = direction === 'reverse' ? def.reverseExcludedServiceNumbers : undefined
  const real = source.trips.filter(
    (trip) =>
      trip.directionId === tatakDirectionId &&
      trip.serviceNumber !== null &&
      !AMBIGUOUS_SERVICE_NUMBERS.has(trip.serviceNumber) &&
      !(excluded?.has(trip.serviceNumber) ?? false) &&
      (CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS[trip.serviceNumber] ?? def.id) === def.id &&
      CLASS_MAP[source.routes.get(trip.routeId)?.serviceClass ?? ''] !== undefined,
  )
  return real.map((trip) => {
    const serviceClass = CLASS_MAP[source.routes.get(trip.routeId)!.serviceClass]!
    return {
      serviceId: trip.serviceNumber!,
      number: trip.serviceNumber!,
      headsign: trip.headsign,
      departureTime: departureTimeOf(source, trip),
      serviceClass,
      hub,
      corporation,
      confidence: 'secondary_unverified',
      ...(direction === 'reverse' ? { direction } : {}),
      note: `scripts/build-corridor-roster.ts, from Tatak ${def.tatakId} (data/intercity/${def.tatakDir}/trips.txt, trip ${trip.tripId}), direction ${direction}. Tatak's own provenance for this service number is "${trip.provenance}", not primary-confirmed - see that repository's src/intercity/corridors/*.ts for the underlying source.`,
    }
  })
}

function buildCorridorRoster(def: NewCorridorDef, source: TatakCorridorSource): RosterCorridor {
  const departures = realDeparturesFor(def, source, def.tatakDirectionId, def.hub, 'forward')

  if (departures.length === 0) {
    // DND-ANK and BNG-BDM: no usable real service number anywhere in
    // Tatak's data for this corridor's chosen direction. Roster its own
    // generated departures instead, invented and labelled as such - the
    // exact convention BNG-HSP's own invented rows already use - so the
    // corridor still has a coach to track. Never done for the `reverse`
    // direction - see this file's own top-of-file comment.
    const corporation = corporationFor(def.hub)
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

  if (def.reverseHub !== undefined) {
    const reverseDirectionId = def.tatakDirectionId === 0 ? 1 : 0
    departures.push(...realDeparturesFor(def, source, reverseDirectionId, def.reverseHub, 'reverse'))
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
 *
 * **Bidirectional rosters.** `KA-BNG-HMP` carries two real dir1 (Hampi- or
 * Hosapete-origin) numbers: `2001HMPBNG`, whose own stop_times genuinely
 * begin at Hampi (this corridor's own last stand, exactly the origin
 * `reverseCorridor` puts first), and `2030HSPBNG`, whose stop_times begin at
 * Hosapete instead - a mid-corridor town on this same road, not the
 * terminus. Rostering the second as a `reverse` departure would assert a
 * Hampi-to-Hosapete leg the coach never drove, the same mismatched-origin
 * problem `MNG-KWR`'s `reverseExcludedServiceNumbers` exists for - so only
 * `2001HMPBNG` is added, direction `reverse`, hub `HSP` (Hampi has no
 * fixture hub of its own; KKRTC's Hosapete division is the corridor's own
 * real split point past which it already runs KKRTC rather than KSRTC).
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

  const reverseCorporation = corporationFor('HSP')
  const reverseAdditions = source.trips.filter(
    (trip) =>
      trip.directionId === 1 &&
      trip.serviceNumber === '2001HMPBNG' &&
      !already.has(trip.serviceNumber) &&
      CLASS_MAP[source.routes.get(trip.routeId)?.serviceClass ?? ''] !== undefined,
  )
  const reverseDepartures: RosterDeparture[] = reverseAdditions.map((trip) => {
    const serviceClass = CLASS_MAP[source.routes.get(trip.routeId)!.serviceClass]!
    const headsign = trip.headsign.replace(/ Bus Stand$/, '')
    return {
      serviceId: trip.serviceNumber!,
      number: trip.serviceNumber!,
      headsign,
      departureTime: departureTimeOf(source, trip),
      serviceClass,
      hub: 'HSP',
      corporation: reverseCorporation,
      confidence: 'secondary_unverified',
      direction: 'reverse',
      note: `scripts/build-corridor-roster.ts, from Tatak KA-BNG-HMP (data/intercity/ka-bng-hmp/trips.txt, trip ${trip.tripId}), direction reverse - see withBngHspAdditions. Tatak's own provenance for this service number is "${trip.provenance}", not primary-confirmed.`,
    }
  })

  const departures = [...preservedBngHsp.departures, ...newDepartures, ...reverseDepartures].sort((a, b) =>
    a.departureTime.localeCompare(b.departureTime),
  )
  return { corridorId: 'BNG-HSP', departures }
}

/**
 * Three real Tatak service numbers the coverage pass's audit surfaced that
 * are sighted only on a generic state-highway feed (`KA-GEN-NH275`,
 * `KA-GEN-NH48`, `KA-GEN-NH50` - Tatak's own statewide sweep, sourced
 * independently of the town-pair corridor feeds `NEW_CORRIDORS` reads and
 * never cross-referenced against them) rather than on any town-pair
 * corridor feed this project already reads. None of the three is fixed by
 * bidirectional rostering: their own `direction_id` in the generic feed is
 * local to that feed and unrelated to any town-pair corridor's own
 * direction choice, and passing every filter `realDeparturesFor` runs would
 * still leave them rostered on a corridor id (`KA-GEN-NH*`) this simulator
 * has no topology for at all.
 *
 * Each is, on inspection of its own `stop_times.txt` rows, a real working
 * over a road this project already models under a different corridor id -
 * so rather than inventing a new highway-spanning corridor (the previous
 * pass's judgment on why these three looked unfixable), each is rostered as
 * an ordinary departure on the *existing* corridor whose stands its own
 * recorded stops fall on:
 *
 * - `0930BNGMRC`: `KA-GEN-NH275`'s stop_times call at Kempegowda (09:30),
 *   Mysuru Central (12:30) and Madikeri (16:00), in that order - exactly
 *   BNG-MYS followed by MYS-MDK, both already-built corridors, in their own
 *   already-rostered (`forward`) direction. One real coach making a single
 *   continuous run is not a different fact from the same coach making a
 *   same-numbered transfer at Mysuru - Tatak's own through-service
 *   convention already treats the two the same way (see
 *   `CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS`'s comment) - so it is rostered on
 *   both legs under the one serviceId, at the clock reading Tatak's own
 *   data gives each leg's own origin stand.
 * - `2130BJPBNG`: `KA-GEN-NH50`'s stop_times begin at Vijayapura (21:30)
 *   and end at Chitradurga, past midnight - NH50's own scope stops at
 *   Chitradurga, short of Bengaluru, but Chitradurga is already a
 *   mid-route stand on BNG-BJP, and the serviceId's own `BNG` suffix names
 *   the real destination NH50's feed does not reach. Rostered as a
 *   `reverse` BNG-BJP departure at 21:30, the clock reading its own feed
 *   records for Vijayapura - BNG-BJP's own already-built reverse geometry
 *   carries it the rest of the way, the same approximation
 *   `CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS` already accepts for a through-
 *   service whose feed does not reach its own destination.
 * - `1115BNGHSD`: `KA-GEN-NH48`'s stop_times begin at Kempegowda (11:15)
 *   and its only other recorded call is Tumakuru - short of even
 *   Chitradurga, let alone Hubballi-Dharwad (`HSD`), which is what the
 *   serviceId itself names and what BNG-HBL already models. Rostered as a
 *   `forward` BNG-HBL departure at 11:15, same reasoning.
 *
 * `2130BJPBNG` and `1115BNGHSD`'s true endpoint is not directly evidenced
 * past where their own generic feed stops recording them - it is read off
 * the serviceId's own `<ORIGIN><DEST>` convention, the same one every
 * other service number in this roster already uses to name itself, not a
 * second independent source. `confidence: "secondary_unverified"` on all
 * three, same as everything else Tatak-sourced here; nothing about this
 * cross-reference is primary-confirmed, and each note below says so.
 */
const GENERIC_HIGHWAY_THROUGH_SERVICES: readonly {
  readonly tatakDir: string
  readonly serviceNumber: string
  readonly corridorId: string
  readonly direction: 'forward' | 'reverse'
  /**
   * The generic feed's own stop id for *this leg's* origin - `0930BNGMRC`
   * rosters twice, once per corridor it passes through, and each row needs
   * the clock reading Tatak recorded at that leg's own boarding point
   * (Majestic for the BNG-MYS leg, Mysuru Central for the MYS-MDK leg), not
   * the trip's overall first stop both times.
   */
  readonly originStopId: string
}[] = [
  { tatakDir: 'ka-gen-nh275', serviceNumber: '0930BNGMRC', corridorId: 'BNG-MYS', direction: 'forward', originStopId: 'KA-BP-BNG-MAJESTIC' },
  { tatakDir: 'ka-gen-nh275', serviceNumber: '0930BNGMRC', corridorId: 'MYS-MDK', direction: 'forward', originStopId: 'KA-BP-MYSURU-CENTRAL' },
  { tatakDir: 'ka-gen-nh50', serviceNumber: '2130BJPBNG', corridorId: 'BNG-BJP', direction: 'reverse', originStopId: 'KA-BP-GEN-VIJAYAPURA-CENTRAL-BUS-STATION' },
  { tatakDir: 'ka-gen-nh48', serviceNumber: '1115BNGHSD', corridorId: 'BNG-HBL', direction: 'forward', originStopId: 'KA-BP-BNG-MAJESTIC' },
]

function departureTimeAtStop(source: TatakCorridorSource, trip: TatakTrip, stopId: string): string {
  const calls = source.stopTimesByTrip.get(trip.tripId) ?? []
  const call = calls.find((candidate) => candidate.stopId === stopId)
  if (call === undefined) {
    throw new Error(`Trip ${trip.tripId} has no stop_times row for ${stopId} - update GENERIC_HIGHWAY_THROUGH_SERVICES`)
  }
  return call.departureTime.slice(0, 5)
}

async function genericHighwayThroughDepartures(): Promise<ReadonlyMap<string, RosterDeparture[]>> {
  const byCorridor = new Map<string, RosterDeparture[]>()
  const sourceByDir = new Map<string, TatakCorridorSource>()
  for (const entry of GENERIC_HIGHWAY_THROUGH_SERVICES) {
    const def = NEW_CORRIDORS.find((candidate) => candidate.id === entry.corridorId)
    if (def === undefined) throw new Error(`GENERIC_HIGHWAY_THROUGH_SERVICES names unknown corridor ${entry.corridorId}`)
    const hub = entry.direction === 'forward' ? def.hub : def.reverseHub
    if (hub === undefined) {
      throw new Error(`${entry.corridorId} has no ${entry.direction} hub for ${entry.serviceNumber}`)
    }
    let source = sourceByDir.get(entry.tatakDir)
    if (source === undefined) {
      source = await loadTatakCorridor(entry.tatakDir)
      sourceByDir.set(entry.tatakDir, source)
    }
    const trip = source.trips.find((candidate) => candidate.serviceNumber === entry.serviceNumber)
    if (trip === undefined) {
      throw new Error(`${entry.serviceNumber} is no longer in Tatak's ${entry.tatakDir} feed - update GENERIC_HIGHWAY_THROUGH_SERVICES`)
    }
    const serviceClassKey = source.routes.get(trip.routeId)?.serviceClass ?? ''
    const serviceClass = CLASS_MAP[serviceClassKey]
    if (serviceClass === undefined) {
      throw new Error(`${entry.serviceNumber}'s class ${serviceClassKey} has no CLASS_MAP row`)
    }
    const departure: RosterDeparture = {
      serviceId: entry.serviceNumber,
      number: entry.serviceNumber,
      headsign: trip.headsign,
      departureTime: departureTimeAtStop(source, trip, entry.originStopId),
      serviceClass,
      hub,
      corporation: corporationFor(hub),
      confidence: 'secondary_unverified',
      ...(entry.direction === 'reverse' ? { direction: entry.direction } : {}),
      note: `scripts/build-corridor-roster.ts, GENERIC_HIGHWAY_THROUGH_SERVICES: from Tatak's generic highway feed data/intercity/${entry.tatakDir}/trips.txt (trip ${trip.tripId}), not from ${def.tatakId}'s own feed - see the comment on this table for why this corridor and direction. Tatak's own provenance for this service number is "${trip.provenance}", not primary-confirmed.`,
    }
    const list = byCorridor.get(entry.corridorId) ?? []
    list.push(departure)
    byCorridor.set(entry.corridorId, list)
  }
  return byCorridor
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

const throughByCorridor = await genericHighwayThroughDepartures()

const generated: RosterCorridor[] = []
const summary: { id: string; real: number; invented: number; classesDropped: string[] }[] = []
for (const def of NEW_CORRIDORS) {
  const source = await loadTatakCorridor(def.tatakDir)
  let corridor = buildCorridorRoster(def, source)
  const through = throughByCorridor.get(def.id)
  if (through !== undefined) {
    corridor = {
      corridorId: corridor.corridorId,
      departures: [...corridor.departures, ...through].sort((a, b) => a.departureTime.localeCompare(b.departureTime)),
    }
  }
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
