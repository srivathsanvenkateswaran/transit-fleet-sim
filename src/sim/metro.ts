import type { MetroLine, MetroStation, MetroTopology } from '../geometry/metroTopology.js'
import type { MetroArrivalsQuery, MetroArrivalsResult } from '../world/port.js'
import { rand } from './rand.js'

export interface MetroServiceProfile {
  readonly seed: number
  readonly timezone: string
  readonly peakWindows: readonly { startMinutes: number; endMinutes: number }[]
  readonly predictionHorizonSeconds: number
  readonly dwellSeconds: number
  readonly uncertaintyBaseSeconds: number
  readonly uncertaintyPerStopSeconds: number
  readonly headwayJitterSeconds: number
}

interface LineService {
  readonly firstTrain: string
  readonly lastTrain: string
  readonly peakHeadwaySeconds: number
  readonly offPeakHeadwaySeconds: number
}

// Purple/Green: BMRCL frequency reporting cited by SPEC [metro-headway].
// Yellow: BMRCL's published line timetable and frequency reporting cited by
// SPEC [yellow-headway]. Times are terminal departure windows, in Bengaluru.
export const OPERATIONAL_METRO_SERVICE: Readonly<Record<string, LineService>> = {
  purple: { firstTrain: '05:00', lastTrain: '23:05', peakHeadwaySeconds: 480, offPeakHeadwaySeconds: 720 },
  green: { firstTrain: '05:00', lastTrain: '23:05', peakHeadwaySeconds: 480, offPeakHeadwaySeconds: 720 },
  yellow: { firstTrain: '06:00', lastTrain: '23:55', peakHeadwaySeconds: 540, offPeakHeadwaySeconds: 840 },
}

interface CandidateArrival {
  readonly arrivalMs: number
  readonly departureMs: number
  readonly line: MetroLine
  readonly direction: 0 | 1
  readonly stationIndex: number
  readonly terminal: MetroStation
  readonly runNumber: number
}

export class MetroSimulation {
  readonly #topology: MetroTopology
  readonly #profile: MetroServiceProfile

  constructor(topology: MetroTopology, profile: MetroServiceProfile) {
    this.#topology = topology
    this.#profile = profile
  }

  arrivals(query: MetroArrivalsQuery, at: Date): MetroArrivalsResult {
    const lines = this.#topology.lines.filter((line) =>
      (query.lineId === null || line.id === query.lineId) &&
      line.stations.some((station) => station.id === query.stationId),
    )
    const simulatedLines = lines.filter((line) => OPERATIONAL_METRO_SERVICE[line.id] !== undefined)
    if (simulatedLines.length === 0) {
      return { state: 'not_simulated', body: { error: 'metro_not_simulated', message: 'This metro line is not simulated.' } }
    }
    const station = simulatedLines[0]?.stations.find((item) => item.id === query.stationId)
    if (station === undefined) throw new Error(`Validated metro station disappeared: ${query.stationId}`)
    if (!simulatedLines.some((line) => this.isWithinService(line.id, at))) {
      return {
        state: 'closed',
        body: {
          error: 'metro_service_closed',
          message: 'Metro service is closed at this time.',
          station: stationRef(station),
          serviceHours: Object.fromEntries(simulatedLines.map((line) => [line.id, OPERATIONAL_METRO_SERVICE[line.id]])),
          arrivals: [],
          meta: this.meta(at),
        },
      }
    }

    const horizonMs = at.getTime() + this.#profile.predictionHorizonSeconds * 1000
    const candidates = simulatedLines.flatMap((line) => this.candidates(line, query, at, horizonMs))
      .sort((left, right) => left.arrivalMs - right.arrivalMs)
      .slice(0, query.limit)
    if (candidates.length === 0) {
      return {
        state: 'no_arrivals',
        body: {
          error: 'no_train_within_horizon',
          message: 'No train is predicted within the configured horizon.',
          station: stationRef(station),
          horizonSeconds: this.#profile.predictionHorizonSeconds,
          arrivals: [],
          meta: this.meta(at),
        },
      }
    }
    return {
      state: 'open',
      body: {
        station: stationRef(station),
        arrivals: candidates.map((candidate) => this.responseArrival(candidate, at)),
        meta: this.meta(at),
      },
    }
  }

  private candidates(line: MetroLine, query: MetroArrivalsQuery, at: Date, horizonMs: number): CandidateArrival[] {
    const service = OPERATIONAL_METRO_SERVICE[line.id]
    if (service === undefined || !this.isWithinService(line.id, at)) return []
    const result: CandidateArrival[] = []
    const day = localDay(at, this.#profile.timezone)
    for (const direction of [0, 1] as const) {
      const terminal = direction === 0 ? line.stations.at(-1) : line.stations[0]
      if (terminal === undefined || (query.towardsId !== null && terminal.id !== query.towardsId)) continue
      const rawIndex = line.stations.findIndex((station) => station.id === query.stationId)
      const stationIndex = direction === 0 ? rawIndex : line.stations.length - 1 - rawIndex
      const travelSeconds = this.travelSecondsTo(line, rawIndex, direction)
      let departureMs = localInstant(day, service.firstTrain, this.#profile.timezone).getTime()
      const lastDepartureMs = localInstant(day, service.lastTrain, this.#profile.timezone).getTime()
      let runNumber = 0
      while (departureMs <= lastDepartureMs) {
        const jitter = Math.round((rand(this.#profile.seed, `${line.id}-${direction}`, 'metro-dispatch-jitter', runNumber) * 2 - 1) * this.#profile.headwayJitterSeconds)
        const jitteredDepartureMs = departureMs + jitter * 1000
        const arrivalMs = jitteredDepartureMs + travelSeconds * 1000
        if (arrivalMs >= at.getTime() && arrivalMs <= horizonMs) {
          result.push({ arrivalMs, departureMs: jitteredDepartureMs, line, direction, stationIndex, terminal, runNumber })
        }
        const departureDate = new Date(departureMs)
        const headway = isPeak(departureDate, this.#profile.timezone, this.#profile.peakWindows)
          ? service.peakHeadwaySeconds
          : service.offPeakHeadwaySeconds
        departureMs += headway * 1000
        runNumber += 1
      }
    }
    return result
  }

  private responseArrival(candidate: CandidateArrival, at: Date) {
    const etaSeconds = Math.max(0, Math.round((candidate.arrivalMs - at.getTime()) / 1000))
    const active = candidate.departureMs <= at.getTime()
    const stopsAway = Math.max(0, candidate.stationIndex)
    return {
      line: { id: candidate.line.id, name: candidate.line.name, nameLocal: candidate.line.nameLocal, colour: candidate.line.colour },
      towards: stationRef(candidate.terminal),
      platform: candidate.line.stations[candidate.direction === 0 ? 0 : candidate.line.stations.length - 1]?.platforms[candidate.direction] ?? null,
      predictedArrival: new Date(candidate.arrivalMs).toISOString(),
      eta: {
        seconds: etaSeconds,
        uncertaintySeconds: this.#profile.uncertaintyBaseSeconds + Math.min(4, stopsAway) * this.#profile.uncertaintyPerStopSeconds,
        basis: active ? 'tracked' : 'scheduled',
      },
      // No `occupancy` here, deliberately. This sim has no per-train demand
      // model - the seven-level ladder needs boardings, alightings and a
      // headway to draw from, and a metro run today has none of the three.
      // `FEW_SEATS_AVAILABLE` at a flat 62% used to sit on this object
      // regardless of line, direction, station or time of day, which was not
      // a coarse measurement, it was a number nobody computed. The wire
      // contract already treats a vehicle observation with no `occupancy`
      // field as the ordinary case (`VehicleObservation.occupancy?` in
      // `src/world/port.ts`), so omitting the key is the whole fix: a
      // consumer that already handles "this service publishes no crowding"
      // needs nothing else from this endpoint.
      tracking: {
        state: 'live',
        fixAgeSeconds: active ? 0 : null,
        source: 'simulated_signalling',
        positionConfidence: active ? 0.98 : null,
      },
      duty: { status: 'confirmed', confidence: null },
      trip: {
        id: `MTR-${candidate.line.id.toUpperCase()}-${candidate.direction}-${candidate.runNumber.toString().padStart(3, '0')}`,
        startTime: localTime(new Date(candidate.departureMs), this.#profile.timezone),
        startDate: localDay(new Date(candidate.departureMs), this.#profile.timezone).replaceAll('-', ''),
      },
      vehicle: { bin: `MTR-${candidate.line.id.toUpperCase()}-${candidate.direction}-${candidate.runNumber.toString().padStart(3, '0')}`, displayToRider: false },
    }
  }

  private travelSecondsTo(line: MetroLine, stationIndex: number, direction: 0 | 1): number {
    const segmentDistances = line.segments.map((segment) => segment.distanceMetres)
    const distance = direction === 0
      ? segmentDistances.slice(0, stationIndex).reduce((sum, value) => sum + value, 0)
      : segmentDistances.slice(stationIndex).reduce((sum, value) => sum + value, 0)
    // Published 35 km/h is end-to-end average and already includes station dwell.
    return Math.round(distance / (35 / 3.6))
  }

  private isWithinService(lineId: string, at: Date): boolean {
    const service = OPERATIONAL_METRO_SERVICE[lineId]
    if (service === undefined) return false
    const minutes = localMinutes(at, this.#profile.timezone)
    return minutes >= parseTime(service.firstTrain) && minutes <= parseTime(service.lastTrain)
  }

  private meta(at: Date) {
    return { simulated: true, seed: this.#profile.seed, generatedAt: at.toISOString() }
  }
}

function stationRef(station: MetroStation) {
  return { id: station.id, name: station.name, nameLocal: station.nameLocal }
}

function parseTime(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function localParts(at: Date, timezone: string) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((part) => [part.type, part.value]))
}

function localMinutes(at: Date, timezone: string): number {
  const parts = localParts(at, timezone)
  return Number(parts.hour) * 60 + Number(parts.minute)
}

function localDay(at: Date, timezone: string): string {
  const parts = localParts(at, timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function localTime(at: Date, timezone: string): string {
  const parts = localParts(at, timezone)
  return `${parts.hour}:${parts.minute}:${parts.second}`
}

function localInstant(day: string, time: string, timezone: string): Date {
  // Asia/Kolkata is the configured/default zone and has no DST. Derive its
  // offset through Intl so tests remain correct if SIM_TIMEZONE is changed.
  const tentative = new Date(`${day}T${time}:00.000Z`)
  const desiredMinutes = parseTime(time)
  const observedMinutes = localMinutes(tentative, timezone)
  return new Date(tentative.getTime() + (desiredMinutes - observedMinutes) * 60_000)
}

function isPeak(at: Date, timezone: string, windows: readonly { startMinutes: number; endMinutes: number }[]): boolean {
  const minutes = localMinutes(at, timezone)
  return windows.some((window) => minutes >= window.startMinutes && minutes < window.endMinutes)
}
