/**
 * Reads Tatak's GTFS from the sibling Tatak checkout - both the generated
 * intercity feed (`data/intercity/<dir>/*.txt`) and, since the September
 * 2026 city-bus coverage expansion, Tatak's own copy of the full BMTC feed
 * at `data/gtfs/*.txt`. Shared by `build-corridors.ts` (topology),
 * `build-corridor-roster.ts` (roster) and `build-bundle.ts` (the city bus
 * route selection), so every script reads the exact same source rows rather
 * than each hand-copying its own snapshot of Tatak's data.
 *
 * Tatak's own `data/` tree is documented there as regenerable output ("npm
 * run build-intercity"), not a hand source - see that repo's
 * `src/intercity/index.ts`. Treat it as a snapshot: if Tatak's corridor
 * `.ts` sources change without a rebuild there, this reads whatever is on
 * disk, which may be stale. `TATAK_REPO_PATH` overrides the sibling path
 * the same way `FLEET_SIM_REPO` does in ondc-transit-bpp's own test harness.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'csv-parse/sync'

export function tatakRepoPath(): string {
  return process.env.TATAK_REPO_PATH?.trim() || resolve(import.meta.dirname, '../../../Tatak')
}

/**
 * Tatak's full, unfiltered BMTC city GTFS directory - the source of truth
 * this project's own `data/bundle/gtfs` is a route-filtered cache of.
 * `Vonter/bmtc-gtfs` commit `9b10e7bacbd5f81b5df9b2dd5de7b9d9d8b4d52c`, feed
 * version `20260712`, matching `data/bundle/SOURCE.md`'s own citation - both
 * projects' copies came from the same upstream fetch, so route ids and stop
 * ids agree between them with no remapping needed. `null` when the sibling
 * checkout (or this directory inside it) is not present, so a caller can
 * fall back to fetching the upstream feed directly instead of failing.
 */
export function tatakCityGtfsPath(): string | null {
  const directory = resolve(tatakRepoPath(), 'data/gtfs')
  return existsSync(resolve(directory, 'routes.txt')) ? directory : null
}

async function readCsv(path: string): Promise<Record<string, string>[]> {
  const raw = await readFile(path, 'utf8')
  return parse(raw, { columns: true, skip_empty_lines: true }) as Record<string, string>[]
}

export interface TatakStop {
  readonly stopId: string
  readonly name: string
  readonly lat: number
  readonly lon: number
  readonly territoryCorporation: string
}

export interface TatakTrip {
  readonly routeId: string
  readonly tripId: string
  readonly headsign: string
  readonly directionId: 0 | 1
  readonly serviceNumber: string | null
  readonly provenance: string
}

export interface TatakRoute {
  readonly routeId: string
  readonly serviceClass: string
}

export interface TatakStopTime {
  readonly tripId: string
  readonly arrivalTime: string
  readonly departureTime: string
  readonly stopId: string
  readonly stopSequence: number
}

export interface TatakCorridorSource {
  readonly stops: readonly TatakStop[]
  readonly stopById: ReadonlyMap<string, TatakStop>
  readonly routes: ReadonlyMap<string, TatakRoute>
  readonly trips: readonly TatakTrip[]
  readonly stopTimesByTrip: ReadonlyMap<string, readonly TatakStopTime[]>
}

/**
 * The corridor's own boarding-point order, origin-first, derived from the
 * trip with the most calls (ties broken by trip id) - the same order every
 * trip on the corridor is a sub-sequence of. Every corridor this project
 * reads from has full coverage from a single trip; a corridor where that
 * stops being true would need this function to change, not the caller.
 */
export function spineOrder(source: TatakCorridorSource): readonly TatakStop[] {
  let bestTripId: string | null = null
  let bestCalls: readonly TatakStopTime[] = []
  for (const [tripId, calls] of source.stopTimesByTrip) {
    if (calls.length > bestCalls.length || (calls.length === bestCalls.length && (bestTripId === null || tripId < bestTripId))) {
      bestTripId = tripId
      bestCalls = calls
    }
  }
  const ordered = [...bestCalls].sort((a, b) => a.stopSequence - b.stopSequence)
  const stops = ordered.map((call) => source.stopById.get(call.stopId)!)
  if (stops.length !== source.stops.length) {
    throw new Error(
      `Tatak corridor's longest trip (${bestTripId}) calls at ${stops.length} of ${source.stops.length} stops - spine order is incomplete`,
    )
  }
  return stops
}

export async function loadTatakCorridor(tatakDir: string): Promise<TatakCorridorSource> {
  const base = resolve(tatakRepoPath(), 'data/intercity', tatakDir)
  const [stopRows, routeRows, tripRows, stopTimeRows] = await Promise.all([
    readCsv(resolve(base, 'stops.txt')),
    readCsv(resolve(base, 'routes.txt')),
    readCsv(resolve(base, 'trips.txt')),
    readCsv(resolve(base, 'stop_times.txt')),
  ])

  const stops: TatakStop[] = stopRows.map((row) => ({
    stopId: row.stop_id!,
    name: row.stop_name!,
    lat: Number(row.stop_lat),
    lon: Number(row.stop_lon),
    territoryCorporation: row.tatak_territory_corporation ?? '',
  }))
  const stopById = new Map(stops.map((stop) => [stop.stopId, stop]))

  const routes = new Map<string, TatakRoute>(
    routeRows.map((row) => [row.route_id!, { routeId: row.route_id!, serviceClass: row.tatak_service_class! }]),
  )

  const trips: TatakTrip[] = tripRows.map((row) => ({
    routeId: row.route_id!,
    tripId: row.trip_id!,
    headsign: row.trip_headsign ?? '',
    directionId: row.direction_id === '1' ? 1 : 0,
    serviceNumber: row.tatak_service_number ? row.tatak_service_number : null,
    provenance: row.tatak_service_provenance ?? '',
  }))

  const stopTimesByTrip = new Map<string, TatakStopTime[]>()
  for (const row of stopTimeRows) {
    const call: TatakStopTime = {
      tripId: row.trip_id!,
      arrivalTime: row.arrival_time!,
      departureTime: row.departure_time!,
      stopId: row.stop_id!,
      stopSequence: Number(row.stop_sequence),
    }
    const list = stopTimesByTrip.get(call.tripId) ?? []
    list.push(call)
    stopTimesByTrip.set(call.tripId, list)
  }

  return { stops, stopById, routes, trips, stopTimesByTrip }
}
