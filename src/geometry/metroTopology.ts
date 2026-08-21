import { readFile } from 'node:fs/promises'
import { haversineMetres, type Coordinate } from './haversine.js'
import { buildShapeIndex, type ShapeIndex } from './shape.js'

export interface MetroStation extends Coordinate {
  readonly id: string
  readonly name: string
  readonly nameLocal: string | null
  readonly platforms: readonly string[]
  readonly isInterchange: boolean
  readonly interchangeWith: readonly string[]
}

export interface MetroSegment {
  readonly fromStopId: string
  readonly toStopId: string
  readonly geometry: 'osm' | 'interpolated'
  readonly distanceMetres: number
  readonly points: readonly Coordinate[]
}

export interface MetroLine {
  readonly id: string
  readonly ref: string
  readonly name: string
  readonly nameLocal: string
  readonly colour: string
  readonly osmRelationId: number
  readonly stations: readonly MetroStation[]
  readonly segments: readonly MetroSegment[]
  readonly track: ShapeIndex
}

export interface MetroTopology {
  readonly source: 'openstreetmap'
  readonly fetchedAt: string
  readonly overpassEndpoint: string
  readonly lines: readonly MetroLine[]
}

export async function loadMetroTopology(path: string, maxStationGapMetres = 4000): Promise<MetroTopology> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MetroTopology
  validateMetroTopology(raw, maxStationGapMetres)
  return raw
}

export function validateMetroTopology(topology: MetroTopology, maxStationGapMetres = 4000): void {
  const minimums: Record<string, number> = { purple: 37, green: 32, yellow: 16 }
  for (const line of topology.lines) {
    const minimum = minimums[line.id]
    if (minimum !== undefined && line.stations.length < minimum) {
      throw new Error(`Metro line ${line.id} has ${line.stations.length} stations, needs ${minimum}`)
    }
    const ids = new Set<string>()
    for (const station of line.stations) {
      if (ids.has(station.id)) throw new Error(`Duplicate metro station ${station.id} on ${line.id}`)
      ids.add(station.id)
    }
    for (let index = 1; index < line.stations.length; index += 1) {
      const previous = line.stations[index - 1]
      const current = line.stations[index]
      if (previous === undefined || current === undefined) continue
      if (haversineMetres(previous, current) > maxStationGapMetres) {
        throw new Error(`Metro station gap exceeds ${maxStationGapMetres}m on ${line.id}`)
      }
    }
  }
}

export function topologyForLine(topology: MetroTopology, lineId: string): MetroLine | null {
  return topology.lines.find((line) => line.id === lineId) ?? null
}

export function buildTrack(points: readonly Coordinate[], id: string): ShapeIndex {
  return buildShapeIndex(
    id,
    points.map((point, sequence) => ({ ...point, sequence })),
  )
}
