import { readFileSync } from 'node:fs'
import { config } from '../config.js'
import type { MetroTopology } from '../geometry/metroTopology.js'
import { MetroSimulation } from '../sim/metro.js'

const topology = JSON.parse(readFileSync(config.metroTopologyPath, 'utf8')) as MetroTopology
const simulation = new MetroSimulation(topology, { seed: config.simSeed, timezone: config.simTimezone, peakWindows: [{ startMinutes: 420, endMinutes: 660 }, { startMinutes: 1020, endMinutes: 1260 }], predictionHorizonSeconds: 3600, dwellSeconds: 30, uncertaintyBaseSeconds: 30, uncertaintyPerStopSeconds: 8, headwayJitterSeconds: 30 })

export function metroArrivals(
  stationId: string | null,
  towardsId: string | null,
  lineId: string | null,
  limitRaw: string | null,
  now: Date,
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
  const result = simulation.arrivals({ stationId, towardsId, lineId, limit }, now)
  const status = result.state === 'not_simulated' ? 503 : 200
  return { status, body: result.body }
}

function invalid(message: string) {
  return { error: 'invalid_request', message }
}
