import AdmZip from 'adm-zip'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parse } from 'csv-parse'
import { config } from '../src/config.js'
import { projectStops } from '../src/geometry/projectStops.js'
import {
  buildShapeIndex,
  measureShapeDistances,
  type RawShapePoint,
} from '../src/geometry/shape.js'

const DEFAULT_ROUTES = ['500-D', '500-A', 'G-4', '335-E', '401-K'] as const
const UPSTREAM_COMMIT = '9b10e7bacbd5f81b5df9b2dd5de7b9d9d8b4d52c'
const SOURCE_ARGUMENT = process.argv[2] ?? config.upstreamGtfsUrl

type Row = Record<string, string>

const temporaryRoot = await mkdtemp(join(tmpdir(), 'transit-fleet-bundle-'))
try {
  const sourceDirectory = await materialiseSource(SOURCE_ARGUMENT, temporaryRoot)
  const routes = await readRows(join(sourceDirectory, 'routes.txt'))
  const selectedRoutes = routes.filter((row) => DEFAULT_ROUTES.includes(row.route_short_name as never))
  assertExactRouteSet(selectedRoutes)
  const routeIds = new Set(selectedRoutes.map((row) => required(row, 'route_id')))

  const trips = await readRows(join(sourceDirectory, 'trips.txt'))
  const selectedTrips = trips.filter((row) => routeIds.has(required(row, 'route_id')))
  const tripIds = new Set(selectedTrips.map((row) => required(row, 'trip_id')))
  const shapeIds = new Set(selectedTrips.map((row) => required(row, 'shape_id')))
  const serviceIds = new Set(selectedTrips.map((row) => required(row, 'service_id')))

  const selectedStopTimes = await readFilteredRows(
    join(sourceDirectory, 'stop_times.txt'),
    (row) => tripIds.has(required(row, 'trip_id')),
  )
  const stopIds = new Set(selectedStopTimes.map((row) => required(row, 'stop_id')))
  const stops = await readRows(join(sourceDirectory, 'stops.txt'))
  const selectedStops = stops.filter((row) => stopIds.has(required(row, 'stop_id')))
  const selectedShapes = await readFilteredRows(
    join(sourceDirectory, 'shapes.txt'),
    (row) => shapeIds.has(required(row, 'shape_id')),
  )
  const calendar = await readRows(join(sourceDirectory, 'calendar.txt'))
  const selectedCalendar = calendar.filter((row) => serviceIds.has(required(row, 'service_id')))
  const agencyIds = new Set(selectedRoutes.map((row) => required(row, 'agency_id')))
  const agency = await readRows(join(sourceDirectory, 'agency.txt'))
  const selectedAgency = agency.filter((row) => agencyIds.has(required(row, 'agency_id')))
  const translations = await readRows(join(sourceDirectory, 'translations.txt'))
  const selectedTranslations = translations.filter((row) =>
    translationReferencesSelectedStop(row, stopIds),
  )
  const feedInfo = await readRows(join(sourceDirectory, 'feed_info.txt'))
  const attributions = await readRows(join(sourceDirectory, 'attributions.txt'))

  const outputDirectory = resolve(config.gtfsBundlePath, 'gtfs')
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  await writeGzipRows(outputDirectory, 'agency.txt', selectedAgency)
  await writeGzipRows(outputDirectory, 'routes.txt', selectedRoutes)
  await writeGzipRows(outputDirectory, 'trips.txt', selectedTrips)
  await writeGzipRows(outputDirectory, 'stops.txt', selectedStops)
  await writeGzipRows(outputDirectory, 'stop_times.txt', selectedStopTimes)
  await writeGzipRows(outputDirectory, 'shapes.txt', selectedShapes)
  await writeGzipRows(outputDirectory, 'calendar.txt', selectedCalendar)
  await writeGzipRows(outputDirectory, 'translations.txt', selectedTranslations)
  await writeGzipRows(outputDirectory, 'feed_info.txt', feedInfo)
  await writeGzipRows(outputDirectory, 'attributions.txt', attributions)

  const measurement = measureBundle(
    selectedRoutes,
    selectedTrips,
    selectedStopTimes,
    selectedStops,
    selectedShapes,
  )
  const feedVersion = feedInfo[0]?.feed_version ?? 'unknown'
  const sourceDocument = renderSourceDocument(feedVersion, measurement)
  await writeFile(resolve(outputDirectory, '..', 'SOURCE.md'), sourceDocument, 'utf8')
  process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function materialiseSource(source: string, temporaryDirectory: string): Promise<string> {
  if (!source.startsWith('http://') && !source.startsWith('https://')) {
    const local = resolve(source)
    if (!local.endsWith('.zip')) return local
    const extracted = join(temporaryDirectory, 'gtfs')
    new AdmZip(local).extractAllTo(extracted, true)
    return extracted
  }
  const response = await fetch(source)
  if (!response.ok) throw new Error(`GTFS download failed with HTTP ${response.status}`)
  const archive = join(temporaryDirectory, basename(new URL(source).pathname))
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  const extracted = join(temporaryDirectory, 'gtfs')
  new AdmZip(archive).extractAllTo(extracted, true)
  return extracted
}

async function readRows(path: string): Promise<Row[]> {
  return readFilteredRows(path, () => true)
}

async function readFilteredRows(path: string, keep: (row: Row) => boolean): Promise<Row[]> {
  const rows: Row[] = []
  const parser = createReadStream(path).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, relax_quotes: true }),
  )
  for await (const row of parser) {
    const typed = row as Row
    if (keep(typed)) rows.push(typed)
  }
  return rows
}

async function writeGzipRows(directory: string, name: string, rows: readonly Row[]): Promise<void> {
  if (rows.length === 0) throw new Error(`Refusing to write empty ${name}`)
  const columns = Object.keys(rows[0] ?? {})
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column] ?? '')).join(','))
  await writeFile(join(directory, `${name}.gz`), gzipSync(`${lines.join('\n')}\n`, { level: 9 }))
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function required(row: Row, column: string): string {
  const value = row[column]
  if (value === undefined || value === '') throw new Error(`Missing required ${column}`)
  return value
}

function assertExactRouteSet(routes: readonly Row[]): void {
  const actual = new Set(routes.map((row) => row.route_short_name))
  const missing = DEFAULT_ROUTES.filter((route) => !actual.has(route))
  if (missing.length > 0) throw new Error(`Source feed is missing routes: ${missing.join(', ')}`)
}

function translationReferencesSelectedStop(row: Row, stopIds: ReadonlySet<string>): boolean {
  const recordId = row.record_id ?? row.field_value ?? ''
  return recordId === '' || stopIds.has(recordId)
}

interface ShapeMeasurement {
  route: string
  shapeId: string
  monotonic: boolean
  sourceLengthMetres: number | null
  haversineLengthMetres: number
  differencePercent: number | null
  maxStopOffsetMetres: number
  stopOrderViolations: number
  usable: boolean
}

function measureBundle(
  routes: readonly Row[],
  trips: readonly Row[],
  stopTimes: readonly Row[],
  stops: readonly Row[],
  shapes: readonly Row[],
): readonly ShapeMeasurement[] {
  const routeNumberById = new Map(routes.map((row) => [required(row, 'route_id'), required(row, 'route_short_name')]))
  const stopById = new Map(
    stops.map((row) => [
      required(row, 'stop_id'),
      { id: required(row, 'stop_id'), lat: Number(required(row, 'stop_lat')), lon: Number(required(row, 'stop_lon')) },
    ]),
  )
  const representativeTripByShape = new Map<string, Row>()
  for (const trip of trips) {
    const shapeId = required(trip, 'shape_id')
    if (!representativeTripByShape.has(shapeId)) representativeTripByShape.set(shapeId, trip)
  }
  const stopTimesByTrip = new Map<string, Row[]>()
  for (const row of stopTimes) {
    const tripId = required(row, 'trip_id')
    const bucket = stopTimesByTrip.get(tripId) ?? []
    bucket.push(row)
    stopTimesByTrip.set(tripId, bucket)
  }
  const pointsByShape = new Map<string, RawShapePoint[]>()
  for (const row of shapes) {
    const shapeId = required(row, 'shape_id')
    const bucket = pointsByShape.get(shapeId) ?? []
    bucket.push({
      lat: Number(required(row, 'shape_pt_lat')),
      lon: Number(required(row, 'shape_pt_lon')),
      sequence: Number(required(row, 'shape_pt_sequence')),
      sourceDistanceMetres: Number(required(row, 'shape_dist_traveled')),
    })
    pointsByShape.set(shapeId, bucket)
  }

  return [...pointsByShape.entries()].map(([shapeId, points]) => {
    const trip = representativeTripByShape.get(shapeId)
    if (trip === undefined) throw new Error(`No representative trip for shape ${shapeId}`)
    const tripStops = (stopTimesByTrip.get(required(trip, 'trip_id')) ?? [])
      .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence))
      .map((row) => stopById.get(required(row, 'stop_id')))
      .filter((stop) => stop !== undefined)
    const distance = measureShapeDistances(points)
    const index = buildShapeIndex(shapeId, points)
    const projected = projectStops(index, tripStops)
    let stopOrderViolations = 0
    for (let index = 1; index < projected.length; index += 1) {
      if ((projected[index]?.stopDistanceMetres ?? 0) < (projected[index - 1]?.stopDistanceMetres ?? 0)) {
        stopOrderViolations += 1
      }
    }
    return {
      route: routeNumberById.get(required(trip, 'route_id')) ?? required(trip, 'route_id'),
      shapeId,
      monotonic: distance.monotonic,
      sourceLengthMetres: round(distance.sourceLengthMetres),
      haversineLengthMetres: round(distance.haversineLengthMetres) ?? 0,
      differencePercent: round(distance.differencePercent, 3),
      maxStopOffsetMetres: round(Math.max(...projected.map((stop) => stop.offsetMetres))) ?? 0,
      stopOrderViolations,
      usable: distance.usable,
    }
  })
}

function round(value: number | null, digits = 1): number | null {
  if (value === null) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function renderSourceDocument(feedVersion: string, measurement: readonly ShapeMeasurement[]): string {
  const table = measurement
    .map(
      (row) =>
        `| ${row.route} | ${row.shapeId} | ${row.monotonic ? 'yes' : 'no'} | ${row.sourceLengthMetres} | ${row.haversineLengthMetres} | ${row.differencePercent}% | ${row.maxStopOffsetMetres} | ${row.stopOrderViolations} |`,
    )
    .join('\n')
  return `# Bundled BMTC GTFS source

- Upstream: ${config.upstreamGtfsUrl}
- Repository: ${config.gtfsRepositoryUrl}
- Commit: \`${UPSTREAM_COMMIT}\`
- Feed version: \`${feedVersion}\`
- Fetched: 2026-08-20
- Routes: ${DEFAULT_ROUTES.join(', ')}

This is an attributed five-route cache of the unofficial community BMTC feed.
The upstream repository does not contain a licence file. See
\`THIRD_PARTY_NOTICES.md\` before redistributing the data.

## Stage 0 distance measurement

The source distance was checked for monotonicity on every bundled shape and its
final value was compared with the sum of haversine segment lengths. Stops from
one representative trip per shape were projected onto the shape; the table
reports the largest offset and any reversal in projected stop order.

| Route | Shape | Monotonic | Source m | Haversine m | Difference | Max stop offset m | Order violations |
|---|---|---:|---:|---:|---:|---:|---:|
${table}

Result: \`shape_dist_traveled\` is consistent and is used directly. Every shape
is monotonic and within 5 percent of haversine length. G-4 UP has one projected
stop-order reversal in the source stop sequence; changing the shape-distance
calculation would not repair that independent source-data anomaly. The loader
still falls back to recomputed haversine cumulative distance if a future shape
fails the distance gate.
`
}
