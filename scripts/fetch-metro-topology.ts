import { readFile, writeFile } from 'node:fs/promises'
import { loadConfig } from '../src/config.js'
import { haversineMetres, type Coordinate } from '../src/geometry/haversine.js'
import { buildTrack, type MetroLine, type MetroStation, type MetroTopology } from '../src/geometry/metroTopology.js'
import { projectStop } from '../src/geometry/projectStops.js'

interface OsmElement { type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string>; members?: OsmMember[] }
interface OsmMember { type: string; ref: number; role: string }

const config = loadConfig()
const output = new URL('../data/bundle/metro-topology.json', import.meta.url)
const relationIds: Record<string, number> = { purple: 7841331, green: 7842287, yellow: 19421944 }
const refs: Record<string, string> = { purple: 'Purple', green: 'Green', yellow: 'Yellow' }
const prefixes: Record<string, string> = { purple: 'PPL', green: 'GNL', yellow: 'YLL' }
const colours: Record<string, string> = { purple: '#9C27B0', green: '#2E7D32', yellow: '#F9A825' }
const localLineNames: Record<string, string> = { purple: 'ನೇರಳೆ ಮಾರ್ಗ', green: 'ಹಸಿರು ಮಾರ್ಗ', yellow: 'ಹಳದಿ ಮಾರ್ಗ' }

async function fetchRelation(id: number): Promise<OsmElement[]> {
  const fixtureDir = process.env.METRO_OSM_FIXTURE_DIR
  const fixtureName: Record<number, string> = { 7841331: 'purple-osm.json', 7842287: 'green-osm.json', 19421944: 'yellow-osm.json' }
  if (fixtureDir !== undefined && fixtureName[id] !== undefined) {
    const body = JSON.parse(await readFile(`${fixtureDir}/${fixtureName[id]}`, 'utf8')) as { elements: OsmElement[] }
    return body.elements
  }
  let response = await fetch(`${config.osmApiBaseUrl}/relation/${id}/full.json`)
  for (let attempt = 1; response.status === 429 && attempt <= 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15000))
    response = await fetch(`${config.osmApiBaseUrl}/relation/${id}/full.json`)
  }
  if (!response.ok) throw new Error(`OSM relation ${id} failed: ${response.status}`)
  const body = (await response.json()) as { elements: OsmElement[] }
  return body.elements
}

function stitch(ways: OsmElement[]): number[] | null {
  const first = ways[0]?.nodes
  if (first === undefined || first.length < 2) return null
  const path = [...first]
  for (const way of ways.slice(1)) {
    const nodes = way.nodes ?? []
    const start = nodes[0]
    const end = nodes.at(-1)
    const pathStart = path[0]
    const pathEnd = path.at(-1)
    if (start === pathEnd) path.push(...nodes.slice(1))
    else if (end === pathEnd) path.push(...nodes.slice(0, -1).reverse())
    else if (end === pathStart) path.unshift(...nodes.slice(0, -1))
    else if (start === pathStart) path.unshift(...nodes.slice(1).reverse())
    else return null
  }
  return path
}

function makeLine(id: string, elements: OsmElement[]): MetroLine {
  const relation = elements.find((element) => element.type === 'relation')
  if (relation?.members === undefined || relation.tags === undefined) throw new Error(`Missing relation for ${id}`)
  const nodes = new Map(elements.filter((element) => element.type === 'node').map((element) => [element.id, element]))
  const stationMembers = relation.members.filter((member) => member.type === 'node' && member.role === 'stop')
  const stations: MetroStation[] = stationMembers.map((member, index) => {
    const node = nodes.get(member.ref)
    if (node?.lat === undefined || node.lon === undefined || node.tags?.name === undefined) throw new Error(`Missing station node ${member.ref}`)
    return {
      id: `MTR-${prefixes[id]}-${String(index + 1).padStart(3, '0')}`,
      name: node.tags.name,
      nameLocal: node.tags['name:kn'] ?? null,
      lat: node.lat,
      lon: node.lon,
      platforms: ['1', '2'],
      isInterchange: false,
      interchangeWith: [],
    }
  })
  const ways = relation.members
    .filter((member) => member.type === 'way' && member.role !== 'stop')
    .map((member) => elements.find((element) => element.type === 'way' && element.id === member.ref))
    .filter((way): way is OsmElement => way !== undefined)
  const nodeIds = stitch(ways)
  const osmPoints = nodeIds?.map((nodeId) => {
    const node = nodes.get(nodeId)
    if (node?.lat === undefined || node.lon === undefined) throw new Error(`Missing track node ${nodeId}`)
    return { lat: node.lat, lon: node.lon }
  })
  const points = osmPoints ?? stations.map(({ lat, lon }) => ({ lat, lon }))
  const track = buildTrack(points, `metro-${id}`)
  let distances = stations.map((station) => projectStop(track, station).stopDistanceMetres)
  if ((distances.at(-1) ?? 0) < (distances[0] ?? 0)) {
    stations.reverse()
    const reversed = buildTrack([...points].reverse(), `metro-${id}`)
    distances = stations.map((station) => projectStop(reversed, station).stopDistanceMetres)
  }
  const segments = stations.slice(1).map((station, index) => {
    const from = stations[index]
    const start = distances[index] ?? 0
    const end = distances[index + 1] ?? start
    const interpolated = end <= start
    return {
      fromStopId: from?.id ?? '',
      toStopId: station.id,
      geometry: interpolated || osmPoints === undefined ? 'interpolated' as const : 'osm' as const,
      distanceMetres: interpolated ? haversineMetres(from ?? station, station) : end - start,
      points: interpolated ? [from ?? station, station] : [from ?? station, station],
    }
  })
  return {
    id,
    ref: refs[id] ?? id,
    name: `${refs[id] ?? id} Line`,
    nameLocal: localLineNames[id] ?? id,
    colour: colours[id] ?? '#666666',
    osmRelationId: relation.id,
    stations,
    segments,
    track,
  }
}

const lines: MetroLine[] = []
for (const id of Object.keys(relationIds)) {
  lines.push(makeLine(id, await fetchRelation(relationIds[id] ?? 0)))
}
const interchangePairs = lines.flatMap((line, lineIndex) =>
  line.stations.flatMap((station) =>
    lines.slice(lineIndex + 1).flatMap((other) =>
      other.stations
        .filter((candidate) => haversineMetres(station, candidate) <= 400)
        .map((candidate) => [line.id, station.id, other.id, candidate.id] as const),
    ),
  ),
)
const markedLines = lines.map((line) => ({
  ...line,
  stations: line.stations.map((station) => {
    const peers = interchangePairs.flatMap(([lineId, stationId, otherLineId, otherStationId]) =>
      lineId === line.id && stationId === station.id
        ? [otherStationId]
        : otherLineId === line.id && otherStationId === station.id
          ? [stationId]
          : [],
    )
    return { ...station, isInterchange: peers.length > 0, interchangeWith: peers }
  }),
}))
const topology: MetroTopology = {
  source: 'openstreetmap',
  fetchedAt: new Date().toISOString().slice(0, 10),
  overpassEndpoint: config.overpassUrl,
  lines: markedLines,
}
await writeFile(output, `${JSON.stringify(topology, null, 2)}\n`)
console.log(JSON.stringify({ lines: lines.length, stations: lines.reduce((sum, line) => sum + line.stations.length, 0), output: output.pathname }))
