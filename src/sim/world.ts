import { config } from '../config.js'
import { loadGtfs, type GtfsStopTime, type LoadedGtfs } from '../geometry/loadGtfs.js'
import { positionAt } from '../geometry/shape.js'
import type {
  CreateWorld,
  DutyObservation,
  FleetMember,
  Progress,
  StopPrediction,
  TrackingObservation,
  VehicleObservation,
  WorldPort,
  WorldStatus,
} from '../world/port.js'
import { createClock, type SimClock } from './clock.js'
import { advanceCursor, createCursor } from './cursor.js'
import { dispatchInitialFleet, representativeTrip, type ActiveBus } from './dispatch.js'
import { defaultBusMotionProfile, type BusMotionProfile } from './profile.js'

export interface SimWorldOptions {
  readonly clock?: SimClock
  readonly tickMs?: number
  readonly speedup?: number
  readonly profile?: BusMotionProfile
}

export class SimWorld implements WorldPort {
  readonly #gtfs: LoadedGtfs
  readonly #clock: SimClock
  readonly #tickMs: number
  readonly #speedup: number
  readonly #profile: BusMotionProfile
  readonly #buses = new Map<string, ActiveBus>()
  #timer: NodeJS.Timeout | null = null
  #lastTickAt: Date
  #tickLagMs = 0

  constructor(gtfs: LoadedGtfs, fleet: readonly FleetMember[], options: SimWorldOptions = {}) {
    this.#gtfs = gtfs
    this.#clock = options.clock ?? createClock(config.simClock)
    this.#tickMs = options.tickMs ?? config.simTickMs
    this.#speedup = options.speedup ?? config.simSpeedup
    this.#profile = options.profile ?? defaultBusMotionProfile
    this.#lastTickAt = this.#clock.now()
    for (const bus of dispatchInitialFleet(fleet, gtfs, this.#profile, this.#lastTickAt)) {
      this.#buses.set(bus.member.bin, bus)
    }
  }

  now(): Date {
    return this.#clock.now()
  }

  observe(bin: string, at: Date): VehicleObservation | null {
    const bus = this.#buses.get(bin)
    if (bus === undefined) return null
    return {
      bin,
      class: bus.member.class,
      duty: this.duty(bus),
      tracking: this.tracking(bus, at),
      overridden: false,
    }
  }

  predictNextStops(bin: string, _at: Date, limit: number): readonly StopPrediction[] {
    const bus = this.#buses.get(bin)
    if (bus === undefined || bus.cursor.layoverUntilMs !== null) return []
    const metresPerSecond = bus.cursor.speedKph / 3.6
    return bus.trip.stops
      .slice(bus.cursor.nextStopIndex, bus.cursor.nextStopIndex + limit)
      .map((stop, index) => ({
        stop: stopRef(stop),
        seconds: Math.max(0, Math.round((stop.stopDistanceMetres - bus.cursor.distanceMetres) / metresPerSecond)),
        uncertaintySeconds: 45 + index * 30,
      }))
  }

  status(): WorldStatus {
    return {
      geometryLoaded: true,
      routes: this.#gtfs.routes.size,
      metroLines: 0,
      vehicles: this.#buses.size,
      lastTickAt: this.#lastTickAt.toISOString(),
      tickLagMs: this.#tickLagMs,
      seed: this.#profile.seed,
    }
  }

  async start(): Promise<void> {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => this.tickAt(this.#clock.now()), this.#tickMs)
  }

  async stop(): Promise<void> {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  tickAt(at: Date): void {
    const realElapsedSeconds = Math.max(0, (at.getTime() - this.#lastTickAt.getTime()) / 1000)
    const elapsedSeconds = realElapsedSeconds * this.#speedup
    const expectedAt = this.#lastTickAt.getTime() + this.#tickMs
    this.#tickLagMs = Math.max(0, at.getTime() - expectedAt)
    for (const bus of this.#buses.values()) this.advanceBus(bus, this.#lastTickAt, elapsedSeconds)
    this.#lastTickAt = new Date(at)
  }

  snapshot(at: Date = this.#lastTickAt): readonly VehicleObservation[] {
    return [...this.#buses.keys()]
      .sort()
      .map((bin) => this.observe(bin, at))
      .filter((observation) => observation !== null)
  }

  private advanceBus(bus: ActiveBus, from: Date, elapsedSeconds: number): void {
    let remaining = elapsedSeconds
    let current = new Date(from)
    while (remaining > 1e-9) {
      if (bus.cursor.layoverUntilMs !== null) {
        const layoverRemaining = Math.max(0, (bus.cursor.layoverUntilMs - current.getTime()) / 1000)
        if (layoverRemaining > remaining) return
        remaining -= layoverRemaining
        current = new Date(current.getTime() + layoverRemaining * 1000)
        const nextDirection: 0 | 1 = bus.trip.directionId === 0 ? 1 : 0
        bus.trip = representativeTrip(bus.route, nextDirection)
        bus.cursor = createCursor(bus.trip, 0, this.#profile, bus.member.bin, current)
        bus.tripStartedAt = new Date(current)
        continue
      }
      const shape = this.#gtfs.shapes.get(bus.trip.shapeId)
      if (shape === undefined) throw new Error(`Missing active shape ${bus.trip.shapeId}`)
      const result = advanceCursor(
        bus.cursor,
        bus.trip,
        shape,
        current,
        remaining,
        this.#profile,
        bus.member.bin,
      )
      remaining -= result.consumedSeconds
      current = new Date(current.getTime() + result.consumedSeconds * 1000)
      if (!result.reachedTerminal) return
      bus.cursor.layoverUntilMs = current.getTime() + this.#profile.terminalLayoverSeconds * 1000
    }
  }

  private duty(bus: ActiveBus): DutyObservation {
    const firstStop = bus.trip.stops[0]
    return {
      status: 'confirmed',
      confidence: null,
      route: {
        id: bus.route.id,
        number: bus.route.number,
        name: bus.route.name,
        nameLocal: null,
      },
      headsign: bus.trip.headsign,
      directionId: bus.trip.directionId,
      trip: {
        id: bus.trip.id,
        startTime: firstStop?.departureTime ?? '00:00:00',
        startDate: serviceDate(bus.tripStartedAt, config.simTimezone),
        startedAt: bus.tripStartedAt.toISOString(),
      },
      since: bus.tripStartedAt.toISOString(),
      source: 'roster',
      alternatives: [],
      reason: null,
    }
  }

  private tracking(bus: ActiveBus, at: Date): TrackingObservation {
    const shape = this.#gtfs.shapes.get(bus.trip.shapeId)
    if (shape === undefined) throw new Error(`Missing active shape ${bus.trip.shapeId}`)
    const interpolated = positionAt(shape, bus.cursor.distanceMetres)
    const stopped = bus.cursor.dwellUntilMs !== null || bus.cursor.layoverUntilMs !== null
    return {
      state: 'live',
      observedAt: at.toISOString(),
      position: {
        ...interpolated,
        speedKph: stopped ? 0 : bus.cursor.speedKph,
        accuracyMetres: 0,
      },
      progress: this.progress(bus, shape.lengthMetres),
      source: 'simulated_gnss',
      reason: null,
      recoveredFromDropout: false,
    }
  }

  private progress(bus: ActiveBus, routeLengthMetres: number): Progress {
    const next = bus.trip.stops[bus.cursor.nextStopIndex]
    return {
      nextStop: next === undefined ? null : stopRef(next),
      currentStatus:
        bus.cursor.dwellUntilMs !== null
          ? 'STOPPED_AT'
          : next !== undefined && next.stopDistanceMetres - bus.cursor.distanceMetres < 50
            ? 'INCOMING_AT'
            : 'IN_TRANSIT_TO',
      distanceAlongRouteMetres: bus.cursor.distanceMetres,
      routeLengthMetres,
    }
  }
}

function stopRef(stopTime: GtfsStopTime) {
  return {
    id: stopTime.stop.id,
    name: stopTime.stop.name,
    nameLocal: stopTime.stop.nameLocal,
    sequence: stopTime.sequence,
  }
}

function serviceDate(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}${value('month')}${value('day')}`
}

export const createWorld: CreateWorld = async (fleet) => {
  const gtfs = await loadGtfs()
  return new SimWorld(gtfs, fleet)
}
