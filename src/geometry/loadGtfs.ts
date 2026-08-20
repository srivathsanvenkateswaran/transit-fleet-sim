import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { createGunzip, gunzipSync } from 'node:zlib'
import { parse } from 'csv-parse'
import { config, type GtfsSource } from '../config.js'
import { projectStop } from './projectStops.js'
import { buildShapeIndex, type RawShapePoint, type ShapeIndex } from './shape.js'

type Row = Record<string, string>

export interface GtfsStop {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
  readonly lat: number
  readonly lon: number
}

export interface GtfsStopTime {
  readonly stop: GtfsStop
  readonly sequence: number
  readonly arrivalTime: string
  readonly departureTime: string
  readonly stopDistanceMetres: number
}

export interface GtfsTrip {
  readonly id: string
  readonly routeId: string
  readonly serviceId: string
  readonly shapeId: string
  readonly directionId: 0 | 1
  readonly headsign: string
  readonly stops: readonly GtfsStopTime[]
}

export interface GtfsRoute {
  readonly id: string
  readonly number: string
  readonly name: string
  readonly trips: readonly GtfsTrip[]
}

export interface LoadedGtfs {
  readonly routes: ReadonlyMap<string, GtfsRoute>
  readonly trips: ReadonlyMap<string, GtfsTrip>
  readonly stops: ReadonlyMap<string, GtfsStop>
  readonly shapes: ReadonlyMap<string, ShapeIndex>
  readonly warnings: readonly string[]
}

export interface LoadGtfsOptions {
  readonly source?: GtfsSource
  readonly bundlePath?: string
  readonly path?: string | null
  readonly url?: string | null
  readonly cacheDirectory?: string
  readonly routeNumbers?: readonly string[]
  readonly maxStopOffsetMetres?: number
}

interface GtfsFiles {
  rows(name: string, keep?: (row: Row) => boolean): Promise<Row[]>
}

export async function loadGtfs(options: LoadGtfsOptions = {}): Promise<LoadedGtfs> {
  const source = options.source ?? config.gtfsSource
  const files = await openSource({
    source,
    bundlePath: options.bundlePath ?? config.gtfsBundlePath,
    path: options.path ?? config.gtfsPath,
    url: options.url ?? config.gtfsUrl,
    cacheDirectory: options.cacheDirectory ?? config.gtfsCacheDir,
  })
  const wantedRoutes = new Set(options.routeNumbers ?? config.busRoutes)
  const routeRows = await files.rows('routes.txt', (row) => wantedRoutes.has(required(row, 'route_short_name')))
  const actualRoutes = new Set(routeRows.map((row) => required(row, 'route_short_name')))
  const missingRoutes = [...wantedRoutes].filter((route) => !actualRoutes.has(route))
  if (missingRoutes.length > 0) {
    throw new Error(`GTFS source is missing configured routes: ${missingRoutes.join(', ')}`)
  }

  const routeIds = new Set(routeRows.map((row) => required(row, 'route_id')))
  const tripRows = await files.rows('trips.txt', (row) => routeIds.has(required(row, 'route_id')))
  const tripIds = new Set(tripRows.map((row) => required(row, 'trip_id')))
  const shapeIds = new Set(tripRows.map((row) => required(row, 'shape_id')))
  const stopTimeRows = await files.rows('stop_times.txt', (row) => tripIds.has(required(row, 'trip_id')))
  const stopIds = new Set(stopTimeRows.map((row) => required(row, 'stop_id')))
  const stopRows = await files.rows('stops.txt', (row) => stopIds.has(required(row, 'stop_id')))
  const shapeRows = await files.rows('shapes.txt', (row) => shapeIds.has(required(row, 'shape_id')))
  const translationRows = await files.rows(
    'translations.txt',
    (row) => row.table_name === 'stops' && row.field_name === 'stop_name' && stopIds.has(required(row, 'record_id')),
  )

  const localNameByStop = new Map(
    translationRows.map((row) => [required(row, 'record_id'), required(row, 'translation')]),
  )
  const stops = new Map<string, GtfsStop>()
  for (const row of stopRows) {
    const id = required(row, 'stop_id')
    stops.set(id, {
      id,
      name: required(row, 'stop_name'),
      nameLocal: localNameByStop.get(id) ?? null,
      lat: finiteNumber(row, 'stop_lat'),
      lon: finiteNumber(row, 'stop_lon'),
    })
  }

  const rawPointsByShape = new Map<string, RawShapePoint[]>()
  for (const row of shapeRows) {
    const shapeId = required(row, 'shape_id')
    const points = rawPointsByShape.get(shapeId) ?? []
    const sourceDistanceMetres = optionalFiniteNumber(row.shape_dist_traveled)
    points.push({
      lat: finiteNumber(row, 'shape_pt_lat'),
      lon: finiteNumber(row, 'shape_pt_lon'),
      sequence: finiteNumber(row, 'shape_pt_sequence'),
      ...(sourceDistanceMetres === undefined ? {} : { sourceDistanceMetres }),
    })
    rawPointsByShape.set(shapeId, points)
  }
  const shapes = new Map(
    [...rawPointsByShape].map(([shapeId, points]) => [shapeId, buildShapeIndex(shapeId, points)]),
  )

  const stopTimesByTrip = new Map<string, Row[]>()
  for (const row of stopTimeRows) {
    const tripId = required(row, 'trip_id')
    const rows = stopTimesByTrip.get(tripId) ?? []
    rows.push(row)
    stopTimesByTrip.set(tripId, rows)
  }
  const warnings: string[] = []
  const maxOffset = options.maxStopOffsetMetres ?? config.geometryMaxStopOffsetMetres
  const projectionCache = new Map<string, ReturnType<typeof projectStop>>()
  const trips = new Map<string, GtfsTrip>()
  for (const row of tripRows) {
    const id = required(row, 'trip_id')
    const shapeId = required(row, 'shape_id')
    const shape = shapes.get(shapeId)
    if (shape === undefined) throw new Error(`Trip ${id} references missing shape ${shapeId}`)
    const tripStops = (stopTimesByTrip.get(id) ?? [])
      .sort((a, b) => finiteNumber(a, 'stop_sequence') - finiteNumber(b, 'stop_sequence'))
      .map((stopTime): GtfsStopTime => {
        const stopId = required(stopTime, 'stop_id')
        const stop = stops.get(stopId)
        if (stop === undefined) throw new Error(`Trip ${id} references missing stop ${stopId}`)
        const cacheKey = `${shapeId}\u0000${stopId}`
        let projected = projectionCache.get(cacheKey)
        if (projected === undefined) {
          projected = projectStop(shape, stop)
          projectionCache.set(cacheKey, projected)
          if (projected.offsetMetres > maxOffset) {
            warnings.push(
              `Stop ${stopId} is ${projected.offsetMetres.toFixed(1)} m from shape ${shapeId}`,
            )
          }
        }
        return {
          stop,
          sequence: finiteNumber(stopTime, 'stop_sequence'),
          arrivalTime: required(stopTime, 'arrival_time'),
          departureTime: required(stopTime, 'departure_time'),
          stopDistanceMetres: projected.stopDistanceMetres,
        }
      })
    trips.set(id, {
      id,
      routeId: required(row, 'route_id'),
      serviceId: required(row, 'service_id'),
      shapeId,
      directionId: parseDirection(row.direction_id),
      headsign: row.trip_headsign ?? '',
      stops: tripStops,
    })
  }

  const tripsByRoute = new Map<string, GtfsTrip[]>()
  for (const trip of trips.values()) {
    const values = tripsByRoute.get(trip.routeId) ?? []
    values.push(trip)
    tripsByRoute.set(trip.routeId, values)
  }
  const routes = new Map<string, GtfsRoute>()
  for (const row of routeRows) {
    const id = required(row, 'route_id')
    routes.set(id, {
      id,
      number: required(row, 'route_short_name'),
      name: required(row, 'route_long_name'),
      trips: tripsByRoute.get(id) ?? [],
    })
  }
  return { routes, trips, stops, shapes, warnings }
}

async function openSource(options: {
  source: GtfsSource
  bundlePath: string
  path: string | null
  url: string | null
  cacheDirectory: string
}): Promise<GtfsFiles> {
  if (options.source === 'bundled') return new DirectoryGtfsFiles(resolve(options.bundlePath, 'gtfs'))
  if (options.source === 'path') {
    if (options.path === null) throw new Error('GTFS_PATH is required when GTFS_SOURCE=path')
    return openPath(options.path)
  }
  if (options.url === null) throw new Error('GTFS_URL is required when GTFS_SOURCE=url')
  const archive = await cachedDownload(options.url, options.cacheDirectory)
  return new ZipGtfsFiles(archive)
}

function openPath(path: string): GtfsFiles {
  return path.toLowerCase().endsWith('.zip') ? new ZipGtfsFiles(path) : new DirectoryGtfsFiles(path)
}

class DirectoryGtfsFiles implements GtfsFiles {
  constructor(private readonly directory: string) {}

  async rows(name: string, keep: (row: Row) => boolean = () => true): Promise<Row[]> {
    const plainPath = resolve(this.directory, name)
    const gzipPath = `${plainPath}.gz`
    if (existsSync(plainPath)) return parseRows(createReadStream(plainPath), keep)
    if (existsSync(gzipPath)) return parseRows(createReadStream(gzipPath).pipe(createGunzip()), keep)
    throw new Error(`GTFS source is missing ${name}`)
  }
}

class ZipGtfsFiles implements GtfsFiles {
  private readonly zip: AdmZip

  constructor(path: string) {
    this.zip = new AdmZip(path)
  }

  async rows(name: string, keep: (row: Row) => boolean = () => true): Promise<Row[]> {
    const plain = this.zip.getEntry(name)
    const gzip = this.zip.getEntry(`${name}.gz`)
    if (plain !== null) return parseRows(Readable.from(plain.getData()), keep)
    if (gzip !== null) return parseRows(Readable.from(gunzipSync(gzip.getData())), keep)
    throw new Error(`GTFS archive is missing ${name}`)
  }
}

async function parseRows(stream: Readable, keep: (row: Row) => boolean): Promise<Row[]> {
  const rows: Row[] = []
  const parser = stream.pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, relax_quotes: true }),
  )
  for await (const row of parser) {
    const typed = row as Row
    if (keep(typed)) rows.push(typed)
  }
  return rows
}

async function cachedDownload(url: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16)
  const target = join(directory, `gtfs-${hash}.zip`)
  if (existsSync(target)) return target
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GTFS download failed with HTTP ${response.status}`)
  const temporary = join(directory, `.gtfs-${hash}.tmp`)
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()))
  new AdmZip(temporary).getEntries()
  await rename(temporary, target)
  return target
}

function required(row: Row, name: string): string {
  const value = row[name]
  if (value === undefined || value === '') throw new Error(`Missing required GTFS field ${name}`)
  return value
}

function finiteNumber(row: Row, name: string): number {
  const raw = required(row, name)
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`GTFS field ${name} is not numeric: ${raw}`)
  return value
}

function optionalFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function parseDirection(raw: string | undefined): 0 | 1 {
  if (raw === '1') return 1
  return 0
}
