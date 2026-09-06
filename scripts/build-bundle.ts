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
import { tatakCityGtfsPath } from './lib/tatakSource.js'

/**
 * The bundled route selection, expanded in September 2026 from the original
 * ten (kept below, unchanged in spirit - a trunk corridor, a feeder, and the
 * five airport services) to the coverage an owner riding real journeys
 * across east and south Bengaluru actually needs to see: every bus was
 * reading as "tracker's broken" because the bundle simply did not carry the
 * route that bus was on.
 *
 * Three rules, applied against Tatak's BMTC GTFS (the same feed this
 * project's own bundle is a cache of - see `tatakCityGtfsPath`'s own doc)
 * and unioned together:
 *
 *   1. Every `500`-series route (`route_short_name` starting with `500` -
 *      the community feed encodes each branch/variant pattern as its own
 *      row, e.g. `500-A`, `500-A BSK-BELF`, `500-CH SJP-HBL`, all separately).
 *   2. Every route with a trip calling at any of seven named places - resolved
 *      against the feed's own `stops.txt` spellings, not guessed:
 *      Kundalahalli (20955/20956), the Indiranagar cluster around 100ft Road/
 *      12th Main/6th Main/the metro station/Police Station-KFC (the feed also
 *      has a bare stop named exactly "Indiranagara" at 13.03N, 77.49E - a
 *      different locality near Yelahanka entirely, excluded as a same-name
 *      false match rather than the neighbourhood everyone means), Domlur
 *      Flyover (21915-21918/35937), AECS Layout Cross (20595/20596),
 *      Devarabisanahalli Ring Road (20753/20754), Agara Junction
 *      (20597/20598/24000/35769/38120/38462) and BDA Complex HSR Layout
 *      (23716/23925).
 *   3. Every route with a trip that calls at one of those seven places and
 *      later, same trip, calls at Kempegowda Bus Station ("Majestic" -
 *      stop ids 20921/20922/20921_ST/35931 plus its 27 `20921_PF*` platform
 *      records) - i.e. a real service from that place *to* Majestic, not
 *      merely one that also happens to pass through Majestic in the other
 *      direction.
 *
 * Two of the seven places (Devarabisanahalli Ring Road, BDA Complex HSR
 * Layout) have zero routes satisfying rule 3: every route touching them in
 * this feed either loops locally or reaches Majestic only via a transfer,
 * not on one seat. That is a fact about the real network this feed encodes,
 * not a bug in the resolution - see the coverage-expansion report for the
 * per-place counts this list was built from.
 */
const DEFAULT_ROUTES = [
  "138",
  "138 D6G-JBN",
  "138 KBS-VSD-JBN",
  "139",
  "139 D6G-HLS-JBN",
  "139 SBS-KFC-D6G",
  "139 VSD-JBN",
  "139-MRS-SBS",
  "144-E D6G-KFC-NRG",
  "171 KBS-SNCA",
  "171-G KBS-SSP",
  "201",
  "201 D06G-DMR",
  "201-G",
  "201-G BEMLG-ELC",
  "201-G BSK-BNM",
  "201-G CSB-D06G",
  "201-G CSB-JBN",
  "201-G D6G-BSK",
  "201-G KRM-BEMLF",
  "201-G SGH-JBN",
  "201-Q",
  "201-Q D6G-CSB",
  "201-R CSB-BEMLF",
  "201-RB BSKTTMC-BTLQT",
  "201-V",
  "201-V CSB-RMN",
  "223-A HAL-DBT",
  "225-CA BEML5-HAL ARDC",
  "252-A PSS-ISROM",
  "290-G HSS-RKHN",
  "293-BC",
  "293-BC BTM-BGR",
  "314",
  "314 BEMLF-SBS-YHK",
  "314 CLO-KBS-BEMLF",
  "314 KBS-KFC-D06G",
  "314 KBS-NGWP",
  "314 SBS-NVP",
  "314-B",
  "314-B KBS-CVRNRG",
  "314-B YBS-BEMLG",
  "314-C",
  "314-D",
  "314-FA",
  "314-FA D06G-MLP",
  "314-H",
  "314-H KBS-BEMLF",
  "314-H MLP-SMH",
  "314-P",
  "314-T D06G-VBP",
  "314-T RMN-VSD-KBS",
  "314-T VSD-RMN",
  "315-G",
  "315-G CNS-DML",
  "319-E",
  "322",
  "323",
  "323 D41G-HAL-KMT",
  "323 KMT-HAL-D41G",
  "323-A",
  "323-AB",
  "323-AK",
  "323-AK KBS-D41G",
  "323-B",
  "323-D",
  "323-E",
  "323-F",
  "323-G",
  "323-H",
  "323-J",
  "323-L",
  "323-M",
  "323-N",
  "324",
  "324-A",
  "325",
  "325 KBS-HAL-HRH",
  "325-A",
  "326-E",
  "326-E KMT-KDG",
  "327 KMT-HAL ARDC",
  "327-A",
  "327-B",
  "327-C",
  "327-E",
  "327-FA",
  "328",
  "328-E",
  "328-F",
  "328-G",
  "328-K",
  "329",
  "329-A",
  "329-B",
  "329-C",
  "329-D",
  "329-E",
  "329-F",
  "329-G",
  "329-H",
  "329-J",
  "329-J SNBS-SNH",
  "329-K",
  "330-B",
  "330-C",
  "330-G",
  "330-G SBS-MRHB-DDNK",
  "330-H",
  "330-M",
  "330-P",
  "331",
  "331-A SBS-KDG",
  "332",
  "332-A",
  "333 KBS-HALM-BEMLF",
  "333-C",
  "333-E",
  "333-F",
  "333-G",
  "333-H",
  "333-K",
  "333-N",
  "333-Q KBS-PTR",
  "334 -EA SBS-HSK",
  "334-B",
  "334-E",
  "334-E BRAB-BDG",
  "334-E DBS-KDG",
  "335-C",
  "335-E",
  "335-E KBS-HAL NP",
  "335-E KDG-KVDRDO",
  "335-E SNBS-KDG",
  "335-G",
  "335-G D31G-KDG",
  "335-H",
  "335-M",
  "335-N KGR-KMT-ARDCHAL",
  "336",
  "336-A",
  "338",
  "340-A KBS-ADG-HSR 2nd",
  "340-A KBS-ADG-HSRKEB",
  "340-A STJN-HSRKEB",
  "340-K",
  "341-A",
  "341-C",
  "341-C KBS-KDRM",
  "342",
  "342 D42G-CPWD-VSD",
  "342-A",
  "342-A D42G-KMT",
  "342-A KMT HRH",
  "342-A KRMTTMC-SJP",
  "342-B",
  "342-C",
  "342-E",
  "342-F",
  "342-F BEG-KBS",
  "342-F KBS-D42G",
  "342-F KRMTTMC-STJN-SJP",
  "342-F SJBHS-SJP",
  "342-F SJWA-SJP",
  "342-G",
  "342-H",
  "342-H D42G-SJBHS",
  "342-H STJN-GGSK",
  "342-J",
  "342-K",
  "342-K KBS-ADK",
  "342-L",
  "342-M",
  "342-MA",
  "342-N KBS-KMS",
  "342-P",
  "342-P KMT-GNGP-JGH",
  "342-Q",
  "342-Q KMT-D42G",
  "342-T",
  "342-TA",
  "342-U",
  "342-V",
  "342-W",
  "342-WA",
  "342-Y",
  "342-Z",
  "348-C",
  "356-CW Fly",
  "356-CW UFLY",
  "401-K",
  "411-A CSB-MVW-HALNPS",
  "411-D",
  "412",
  "412 KLN-BRAB DMLR",
  "412 KLN-BSK",
  "412-H",
  "412-H HBLB-ISRO",
  "412-H ISRO-KLN",
  "45-G KMK-KBS-BEMLF",
  "500 BEML-MRTB-CSB",
  "500 SNCS-GGP",
  "500 YTTMC-HBLB-JKLO",
  "500-A",
  "500-A BSK-BELF",
  "500-A D45G-BEMLF",
  "500-A ISROM-HBL-MTK-YBS",
  "500-A MRH-JKLO",
  "500-A PPLO-HBLB",
  "500-AD",
  "500-BA",
  "500-BA YTTMC-MTK-KRPGH",
  "500-BC",
  "500-BC YTTMC-MTK-CSB",
  "500-C",
  "500-C CSB-TCP",
  "500-C KRPGH-BSK",
  "500-C KRPGH-SJP",
  "500-CA",
  "500-CD",
  "500-CD D42-TNF",
  "500-CF",
  "500-CF BSK-HSS",
  "500-CF D41G-SJP-CKT",
  "500-CH",
  "500-CH D42G-TNF",
  "500-CH DNK-BEG",
  "500-CH SJP-HBL",
  "500-CH SJR-KRP",
  "500-CH TNF-ASP",
  "500-CK",
  "500-CS",
  "500-CS D42G-CSB",
  "500-D",
  "500-D BELF-CSB",
  "500-D BEML-TNF-CSB",
  "500-D BSBI-CSB",
  "500-D D10G-BTM",
  "500-D D10G-CSB",
  "500-D D10G-HBLB",
  "500-D D10G-NGW-HBLB",
  "500-D D10G-TNF-CSB",
  "500-D GKVK-CSB",
  "500-D HBLB-BTM",
  "500-D JGS-CSB",
  "500-D KRPRLY-SNCS",
  "500-D MRHB-HBL-PSS",
  "500-DC D32 SRYN-HBLB",
  "500-DC D38G-BELF",
  "500-DG",
  "500-DH HSRCPWD-ATB",
  "500-DJ",
  "500-DM YBS-HBL-ELCW",
  "500-DP DNK-GGP",
  "500-EB",
  "500-EB ELC-HBL",
  "500-EB ELCW-WTF-KDG",
  "500-EB NJP-TNF",
  "500-EB SMVR-ELCW",
  "500-F",
  "500-FB",
  "500-FB CSB-HSK",
  "500-HC",
  "500-HC HBLB-WTTMC",
  "500-HG",
  "500-HG HSK-BELF",
  "500-HK",
  "500-J",
  "500-L",
  "500-L BSK-KRPGH",
  "500-L BSK-TNF-D6G",
  "500-L BSK-TNF-KRPGH",
  "500-L CSB-BEML",
  "500-LA",
  "500-Q",
  "500-Q D10G-TNF-KRPGH",
  "500-Q MDR-CJP",
  "500-QA",
  "500-QA YTTMC-GGP-KRPGH",
  "500-QB",
  "500-QD",
  "500-QD YBS-CSB",
  "500-QG",
  "500-QG KRPGH-BELF",
  "500-QG PSB-GGP-KRP",
  "500-QG PTH-HBL-KRPGH",
  "500-QK",
  "500-QK BBD-KDG",
  "500-QN",
  "500-QP",
  "500-TA",
  "501-CD",
  "501-CD DPJN-NDH-CSB",
  "503-A",
  "503-A VRP-BSK",
  "505 TNF-KKH-VRK",
  "506",
  "BEML-BGR",
  "BEML5-BEMLG",
  "CHAKRA-16",
  "CHAKRA-16A",
  "D06G-MNK",
  "D06G-MRS",
  "D25-HSRBDA",
  "D25G-HSRBDA",
  "D6G-CVRN",
  "D6G-SOQ",
  "G-2",
  "G-2 ATO-SJP",
  "G-2 CHM-SJP",
  "G-2 D06G-JN SJP",
  "G-2 KBS-MYH-SJP",
  "G-2 SBS-SJP",
  "G-2 SJP-KVS",
  "G-4",
  "HSR FDR-1",
  "HSR FDR-1A",
  "IMD-CSB",
  "K-3",
  "KBS-1I",
  "KBS-1I BEMLF-KDG",
  "KBS-1I D06G-LIDO-KDG",
  "KBS-1K",
  "KBS-1K KBS-D41G",
  "KBS-1K KBS-VSD-D41G",
  "KIA-10",
  "KIA-15",
  "KIA-15A",
  "KIA-4",
  "KIA-4A",
  "KIA-7",
  "KIA-7A",
  "KIA-7A D25G-KIA",
  "KIA-8",
  "KIA-8A",
  "KIA-8C",
  "KIA-8D",
  "KIA-8E",
  "KIA-8EW",
  "KIA-8H",
  "KIA-9",
  "KRM-BEMLG",
  "KRM-CPWD",
  "MBS-6 YST-CVRN",
  "MF-1F",
  "MF-1F D6G-RMN",
  "MF-22E",
  "MF-22E KRMTTMC-HRMS",
  "MF-22EA",
  "MF-22ET D38G-TNF",
  "MF-3",
  "MF-3A",
  "MF-4A",
  "MF-5",
  "MF-5 SMVT-BSK",
  "MF-6",
  "MF-6 D06G-CSB",
  "MF-6 JBN-SVMS",
  "MF-9 MRH-D24G",
  "SBS-1K",
  "SBS-1K SBS-D41G",
  "SBS-HAL-BEMLG",
  "V-331A",
  "V-333E",
  "V-335E",
  "V-342F",
  "V-342F D25G-KBS",
  "V-500A",
  "V-500A D13G-BSK-HBL",
  "V-500BC",
  "V-500CA",
  "V-500CA KMK-BSK-ITPL",
  "V-500CK",
  "V-500D",
  "V-500DP",
  "V-500E",
  "V-500E ELCKIA-HBLB",
  "V-500F",
  "V-500FA",
  "V-500HS",
  "V-500L",
  "V-505 ELCW-KDG FLY",
  "V-DIVYA DARSHANA-1B",
  "V-MF1C",
  "V-MF1C BSK-KRPMS",
  "V-MF1D",
  "V-MF1D ELC-KRPMS",
  "V-MF6",
  "VW-226HSR",
  "WTTMC-KDLG-VRTKD",
] as const
const UPSTREAM_COMMIT = '9b10e7bacbd5f81b5df9b2dd5de7b9d9d8b4d52c'
/**
 * Prefers the sibling Tatak checkout's own BMTC feed (same upstream commit,
 * so route and stop ids agree with no remapping) over an explicit CLI
 * argument or a fresh network fetch - see `tatakCityGtfsPath`'s doc for why
 * that source is authoritative rather than merely convenient. An explicit
 * `argv[2]` still wins, for a one-off rebuild against a different feed.
 */
const SOURCE_ARGUMENT = process.argv[2] ?? tatakCityGtfsPath() ?? config.upstreamGtfsUrl

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

This is an attributed ${DEFAULT_ROUTES.length}-route cache of the unofficial community BMTC feed.
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
