import { readFileSync } from 'node:fs'
import { config } from '../config.js'
import { formatBin } from '../fleet/bin.js'
import type { MetroLine, MetroTopology } from '../geometry/metroTopology.js'

const topology = JSON.parse(readFileSync(config.metroTopologyPath, 'utf8')) as MetroTopology

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
  const arrivals = candidateLines.flatMap((line) => arrivalsForLine(line, stationId, towardsId, limit, now))
    .sort((left, right) => left.eta.seconds - right.eta.seconds)
  return {
    status: 200,
    body: {
      station: { id: station.id, name: station.name, nameLocal: station.nameLocal },
      arrivals,
      meta: { simulated: true, seed: config.simSeed, generatedAt: now.toISOString() },
    },
  }
}

function arrivalsForLine(line: MetroLine, stationId: string, towardsId: string | null, limit: number, now: Date) {
  const stationIndex = line.stations.findIndex((station) => station.id === stationId)
  const directions = [line.stations.at(-1), line.stations[0]].filter((terminal): terminal is NonNullable<typeof terminal> => terminal !== undefined)
    .filter((terminal) => towardsId === null || terminal.id === towardsId)
  return directions.flatMap((terminal, directionIndex) => Array.from({ length: limit }, (_, index) => {
    const seconds = 120 + directionIndex * 47 + index * (line.id === 'yellow' ? config.metroHeadwaySecondsOffPeakYellow : config.metroHeadwaySecondsOffPeak)
    const serial = (line.id === 'purple' ? 100 : line.id === 'green' ? 200 : 300) + directionIndex * 20 + index
    const startDate = now.toISOString().slice(0, 10).replaceAll('-', '')
    const startTime = now.toISOString().slice(11, 19)
    return {
      line: { id: line.id, name: line.name, nameLocal: line.nameLocal, colour: line.colour },
      towards: { stopId: terminal.id, name: terminal.name, nameLocal: terminal.nameLocal },
      platform: directionIndex === 0 ? '2' : '1',
      eta: { seconds, uncertaintySeconds: config.metroPredictionUncertaintyBaseSeconds + config.metroPredictionUncertaintyPerStopSeconds * Math.max(0, Math.abs(line.stations.length - stationIndex - 1)), basis: index === 0 ? 'tracked' : 'scheduled' },
      tracking: { state: index === 0 ? 'live' : 'stale', fixAgeSeconds: index === 0 ? 3 : 35, source: 'simulated_signalling' },
      duty: { status: 'confirmed', confidence: null },
      trip: { id: `MTR-${line.id.slice(0, 3).toUpperCase()}-${directionIndex === 0 ? 'U' : 'D'}-${String(index + 1).padStart(4, '0')}`, startTime, startDate },
      vehicle: { bin: formatBin('MTR', serial), displayToRider: false },
    }
  }))
}

function invalid(message: string) {
  return { error: 'invalid_request', message }
}
