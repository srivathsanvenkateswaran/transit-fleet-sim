import { readFileSync } from 'node:fs'
import { config } from '../config.js'
import type { MetroTopology } from '../geometry/metroTopology.js'

const topology = JSON.parse(readFileSync(config.metroTopologyPath, 'utf8')) as MetroTopology

export function metroArrivals(
  stationId: string | null,
  towardsId: string | null,
  lineId: string | null,
  limitRaw: string | null,
  _now: Date,
): { status: number; body: unknown } {
  if (stationId === null || stationId === '') return { status: 400, body: invalid('station is required') }
  const limit = limitRaw === null ? 3 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) return { status: 400, body: invalid('limit must be an integer from 1 to 10') }
  const candidateLines = topology.lines.filter((line) =>
    (lineId === null || line.id === lineId) && line.stations.some((station) => station.id === stationId),
  )
  if (candidateLines.length === 0) return { status: 404, body: invalid('station was not found') }
  const station = candidateLines[0]?.stations.find((item) => item.id === stationId)
  if (station === undefined) return { status: 404, body: invalid('station was not found') }
  return {
    status: 503,
    body: {
      error: 'metro_not_simulated',
      message: 'Metro trains are not simulated yet, so arrivals cannot be calculated.',
      station: { id: station.id, name: station.name, nameLocal: station.nameLocal },
      line: lineId,
    },
  }
}

function invalid(message: string) {
  return { error: 'invalid_request', message }
}
