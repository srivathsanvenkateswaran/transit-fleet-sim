import type { MetroLine, MetroStation, MetroTopology } from '../geometry/metroTopology.js'
import type { MetroArrivalsQuery, MetroArrivalsResult } from '../world/port.js'
import { cachedDateTimeFormat } from './dateTimeFormatCache.js'
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
  readonly lastTrain: string
  readonly peakHeadwaySeconds: number
  readonly offPeakHeadwaySeconds: number
}

// Purple/Green: BMRCL frequency reporting cited by SPEC [metro-headway].
// Yellow: BMRCL's published line timetable and frequency reporting cited by
// SPEC [yellow-headway]. Times are terminal departure windows, in Bengaluru.
export const OPERATIONAL_METRO_SERVICE: Readonly<Record<string, LineService>> = {
  purple: { lastTrain: '23:05', peakHeadwaySeconds: 480, offPeakHeadwaySeconds: 720 },
  green: { lastTrain: '23:05', peakHeadwaySeconds: 480, offPeakHeadwaySeconds: 720 },
  yellow: { lastTrain: '23:55', peakHeadwaySeconds: 540, offPeakHeadwaySeconds: 840 },
}

/**
 * The first-train time, and the one part of the operating window that is not
 * the same every day. All three lines open on the same clock - the owner's
 * brief gave a single first-train schedule for "the three lines" rather than
 * one per line, and BMRCL runs all three to the same opening pattern in
 * practice - so this table is not keyed by line the way `lastTrain` is.
 *
 * Monday is genuinely earlier (04:15) than the rest of the working week
 * (05:00): BMRCL brings services up ahead of the Monday commute peak. Sunday
 * opens latest (07:00), reflecting the lighter early-Sunday demand. A rider
 * who queries "tomorrow" on a Sunday night therefore gets a different answer
 * from one who queries it on any other night, and `nextOpen` below is the
 * one place that has to get that lookahead right.
 *
 * Keyed by the short weekday name `Intl.DateTimeFormat` hands back, which is
 * also what `weekdayOfDay` below produces, so the two never have to agree on
 * a 0-indexed convention.
 */
const FIRST_TRAIN_BY_WEEKDAY: Readonly<Record<string, string>> = {
  Mon: '04:15',
  Tue: '05:00',
  Wed: '05:00',
  Thu: '05:00',
  Fri: '05:00',
  Sat: '05:00',
  Sun: '07:00',
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
          // `firstTrain` here is today's actual opening time - already
          // resolved against the day-of-week table below - and not the name
          // of a rule a client would have to re-implement. `nextOpensAt` is
          // the answer to the question a rider at 02:00 is actually asking:
          // not "when does the metro usually open" but "when does it open
          // next", which on a Sunday night is tomorrow's 04:15 Monday
          // opening and on any other night is tomorrow's 05:00.
          serviceHours: Object.fromEntries(simulatedLines.map((line) => [line.id, {
            firstTrain: firstTrainForDay(localDay(at, this.#profile.timezone)),
            lastTrain: OPERATIONAL_METRO_SERVICE[line.id]?.lastTrain,
            nextOpensAt: this.nextOpen(line.id, at).toISOString(),
          }])),
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
      let departureMs = localInstant(day, firstTrainForDay(day), this.#profile.timezone).getTime()
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
    const day = localDay(at, this.#profile.timezone)
    const minutes = localMinutes(at, this.#profile.timezone)
    return minutes >= parseTime(firstTrainForDay(day)) && minutes <= parseTime(service.lastTrain)
  }

  /**
   * The instant this line next opens, from `at`. Operating windows never
   * cross midnight (the latest close, Yellow's 23:55, is still well before
   * the earliest possible next open), so there are exactly two cases: `at`
   * is a small-hours query before today's first train, in which case today's
   * opening is still ahead of it, or `at` is after last train, in which case
   * the next opening is tomorrow's - on whatever schedule tomorrow's weekday
   * carries, not today's. This is the one place the day-of-week table has to
   * be consulted twice against two different days in the same call.
   */
  private nextOpen(lineId: string, at: Date): Date {
    const timezone = this.#profile.timezone
    const day = localDay(at, timezone)
    const todayOpen = localInstant(day, firstTrainForDay(day), timezone)
    if (at.getTime() < todayOpen.getTime()) return todayOpen
    const tomorrow = addDays(day, 1)
    return localInstant(tomorrow, firstTrainForDay(tomorrow), timezone)
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
  return Object.fromEntries(cachedDateTimeFormat('en-CA', {
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

/**
 * The short weekday name (`Mon`, `Tue`, ...) for a `YYYY-MM-DD` calendar day,
 * independent of any wall-clock time or timezone. `day` names a date, not an
 * instant, and asking what weekday a date falls on has one right answer
 * everywhere on Earth - so this deliberately anchors to noon UTC rather than
 * threading `this.#profile.timezone` through, which would risk a date whose
 * local midnight sits on the far side of the UTC day boundary reading back
 * as the wrong weekday.
 */
function weekdayOfDay(day: string): string {
  return cachedDateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(`${day}T12:00:00.000Z`),
  )
}

/** Today's first-train time, per `FIRST_TRAIN_BY_WEEKDAY` above. Falls back
 *  to the weekday default if a future weekday spelling ever surprises this
 *  build - Monday's earlier open is the exception, not the safe default, so
 *  the fallback deliberately is not it. */
function firstTrainForDay(day: string): string {
  return FIRST_TRAIN_BY_WEEKDAY[weekdayOfDay(day)] ?? '05:00'
}

/** `day` plus `n` calendar days, as another `YYYY-MM-DD`. Arithmetic stays in
 *  UTC throughout because `day` names a date rather than an instant - the
 *  same reasoning as `weekdayOfDay` above - so there is no timezone for a
 *  day-count addition to get wrong. */
function addDays(day: string, n: number): string {
  const next = new Date(`${day}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + n)
  return next.toISOString().slice(0, 10)
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
