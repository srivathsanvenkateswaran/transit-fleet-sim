import { resolve } from 'node:path'
import { config } from '../config.js'
import { loadGtfs, type GtfsStopTime, type LoadedGtfs } from '../geometry/loadGtfs.js'
import { loadMetroTopology, type MetroTopology } from '../geometry/metroTopology.js'
import { positionAt } from '../geometry/shape.js'
import type {
  CreateWorld,
  FleetMember,
  Progress,
  ScheduleUpdate,
  StopPrediction,
  VehicleObservation,
  WorldPort,
  WorldStatus,
} from '../world/port.js'
import { createClock, type SimClock } from './clock.js'
import { advanceCursor, createCursor } from './cursor.js'
import {
  addGpsNoise,
  createDeviceState,
  defaultBusDeviceProfile,
  trackingObservation,
  updateDevice,
  type BusDeviceProfile,
  type DeviceState,
  type FixSnapshot,
} from './device.js'
import { dispatchInitialFleet, representativeTrip, type ActiveBus } from './dispatch.js'
import {
  createDutyState,
  defaultBusDutyProfile,
  dutyObservation,
  maybeSwapDuty,
  type BusDutyProfile,
  type DutyState,
} from './duty.js'
import { coachSlotsFor, loadIntercitySetup } from './intercitySetup.js'
import { CoachSimulation, type CoachWorldProfiles } from './coachWorld.js'
import { defaultCoachProfiles } from './coachProfiles.js'
import { defaultBusOccupancyProfile, occupancyFor, projectOccupancy, type BusOccupancyProfile } from './occupancy.js'
import { defaultBusMotionProfile, type BusMotionProfile } from './profile.js'
import { serviceDate } from './serviceDate.js'
import { MetroSimulation, OPERATIONAL_METRO_SERVICE } from './metro.js'
import type { MetroArrivalsQuery, MetroArrivalsResult } from '../world/port.js'

/**
 * How the initial fleet is placed onto the road. Defaults to
 * `dispatchInitialFleet`, which spreads every bus evenly around its route at
 * `at` (SPEC 8.4's documented simplification). Tests override this to place a
 * bus's `tripStartedAt` somewhere other than the construction instant - the
 * only way to exercise the fix for docs/intercity-coaches.md section 3.1
 * without a full corridor roster, since under the default dispatcher the two
 * instants are always equal and the bug this seam exists to catch is
 * invisible by construction.
 */
export type DispatchFleet = (
  fleet: readonly FleetMember[],
  gtfs: LoadedGtfs,
  profile: BusMotionProfile,
  at: Date,
) => readonly ActiveBus[]

export interface SimWorldOptions {
  readonly metroLines?: number
  readonly clock?: SimClock
  readonly tickMs?: number
  readonly speedup?: number
  readonly profile?: BusMotionProfile
  readonly deviceProfile?: BusDeviceProfile
  readonly dutyProfile?: BusDutyProfile
  readonly occupancyProfile?: BusOccupancyProfile
  readonly metroTopology?: MetroTopology
  readonly dispatch?: DispatchFleet
  /**
   * docs/intercity-coaches.md §10.7: how many corridors `INTERCITY_CORRIDORS`
   * actually loaded, surfaced on `/readyz` when set. `undefined` (the
   * default) means the feature is off and `status()` omits the field
   * entirely - see `WorldStatus.corridors`'s own comment for what this
   * option deliberately does not also carry.
   */
  readonly corridorCount?: number
  /**
   * docs/intercity-coaches.md §11.3's `#roster`/`#active` split, as a whole
   * object rather than a flag. `undefined` (the default) is §14.1's
   * coaches-off case: nothing below is constructed, `tickAt` iterates exactly
   * the vehicles it does today, and no new field appears on any response.
   */
  readonly coaches?: CoachSimulation
}

export class SimWorld implements WorldPort {
  readonly #gtfs: LoadedGtfs
  readonly #clock: SimClock
  readonly #tickMs: number
  readonly #speedup: number
  readonly #profile: BusMotionProfile
  readonly #deviceProfile: BusDeviceProfile
  readonly #dutyProfile: BusDutyProfile
  readonly #occupancyProfile: BusOccupancyProfile
  readonly #corridorCount: number | null
  readonly #coaches: CoachSimulation | null
  readonly #metro: MetroSimulation
  readonly #buses = new Map<string, ActiveBus>()
  readonly #devices = new Map<string, DeviceState>()
  readonly #duties = new Map<string, DutyState>()
  #timer: NodeJS.Timeout | null = null
  #lastTickAt: Date
  #tickLagMs = 0
  /**
   * The clock every seeded time-bucketed draw lives on - docs/intercity-coaches.md
   * §3.6. Advances by `elapsedSeconds` (already multiplied by `#speedup`)
   * every tick, so at `SIM_SPEEDUP=1` it tracks `#lastTickAt` exactly and at
   * any other speedup it runs ahead of the wall clock at the same rate the
   * cursor does. `maybeSwapDuty` and the device's dropout process bucket on
   * this; fix timestamps, `since`, and everything the API reports as an
   * instant stay on the real clock.
   */
  #simulatedAt: Date

  constructor(
    gtfs: LoadedGtfs,
    fleet: readonly FleetMember[],
    options: SimWorldOptions = {},
  ) {
    this.#gtfs = gtfs
    this.#clock = options.clock ?? createClock(config.simClock)
    this.#tickMs = options.tickMs ?? config.simTickMs
    this.#speedup = options.speedup ?? config.simSpeedup
    this.#profile = options.profile ?? defaultBusMotionProfile
    this.#deviceProfile = options.deviceProfile ?? defaultBusDeviceProfile
    this.#dutyProfile = options.dutyProfile ?? defaultBusDutyProfile
    this.#occupancyProfile = options.occupancyProfile ?? defaultBusOccupancyProfile
    this.#corridorCount = options.corridorCount ?? null
    this.#coaches = options.coaches ?? null
    this.#metro = new MetroSimulation(options.metroTopology ?? { lines: [], source: 'openstreetmap', fetchedAt: '', overpassEndpoint: '' }, { seed: config.simSeed, timezone: config.simTimezone, peakWindows: [{ startMinutes: 7 * 60, endMinutes: 11 * 60 }, { startMinutes: 17 * 60, endMinutes: 21 * 60 }], predictionHorizonSeconds: 3600, dwellSeconds: 30, uncertaintyBaseSeconds: 30, uncertaintyPerStopSeconds: 8, headwayJitterSeconds: 30 })
    this.#metroLines = options.metroLines ?? 0
    this.#lastTickAt = this.#clock.now()
    this.#simulatedAt = new Date(this.#lastTickAt)
    const dispatch = options.dispatch ?? dispatchInitialFleet
    for (const bus of dispatch(fleet, gtfs, this.#profile, this.#lastTickAt)) {
      this.#buses.set(bus.member.bin, bus)
      this.#duties.set(
        bus.member.bin,
        createDutyState(
          bus.member.bin,
          this.#lastTickAt,
          // Keyed on the duty's own start instant, not on the instant the
          // world happened to boot at (docs/intercity-coaches.md §3.1). Under
          // today's spread dispatch the two are the same value, so this is a
          // no-op for the bundled bus fixture and every existing golden - see
          // tests/sim/world.test.ts's "keys a duty draw on ..." regression
          // test, which injects a dispatcher where they differ to prove it.
          serviceDate(bus.tripStartedAt, config.simTimezone),
          this.#dutyProfile,
        ),
      )
      this.#devices.set(
        bus.member.bin,
        createDeviceState(
          bus.member.bin,
          this.#lastTickAt,
          () => this.fixSnapshot(bus, 0),
          this.#deviceProfile,
        ),
      )
    }
  }

  metroArrivals(query: MetroArrivalsQuery, at: Date): MetroArrivalsResult { return this.#metro.arrivals(query, at) }

  now(): Date {
    return this.#clock.now()
  }

  /** The coach half of the world, or null when §14.1's default-off applies. */
  get coaches(): CoachSimulation | null {
    return this.#coaches
  }

  observe(bin: string, at: Date): VehicleObservation | null {
    const bus = this.#buses.get(bin)
    // A coach is not in `#buses` at all - it is rostered, not dispatched by
    // spread - so the coach simulation answers for it. A coach that is not
    // currently running any duty returns null here exactly as an unknown BIN
    // does, and the API answers SPEC 5.3 cell D from the registry row, which
    // is the honest answer for a vehicle parked in a depot until tomorrow
    // night: the plate is still a fact and the world has nothing to add.
    if (bus === undefined) return this.#coaches?.observe(bin, at) ?? null
    const dutyState = this.#duties.get(bin)
    const device = this.#devices.get(bin)
    if (dutyState === undefined || device === undefined) throw new Error(`Incomplete world state for ${bin}`)
    const duty = dutyObservation(dutyState, bus, [...this.#gtfs.routes.values()], this.#dutyProfile)
    const tracking = trackingObservation(device, at, duty.route !== null, this.#deviceProfile)
    const occupancy = projectOccupancy(
      occupancyFor(
        {
          bin,
          trackingState: tracking.state,
          routeId: bus.route.id,
          routeNumber: bus.route.number,
          directionId: bus.trip.directionId,
          // Occupancy travels with whichever fix tracking is reporting, not
          // with the live cursor: a `stale` fix must carry stale occupancy,
          // never a figure computed against where the bus has moved on to.
          // `device.lastFix` is non-null whenever `tracking.state` is `live`
          // or `stale` (only `untracked` has none), which is the only case
          // `occupancyFor` reads these fields at all - see its dark/untracked
          // short-circuit.
          distanceAlongRouteMetres: device.lastFix?.progress?.distanceAlongRouteMetres ?? 0,
          routeLengthMetres: device.lastFix?.progress?.routeLengthMetres ?? 0,
          at: device.lastFix?.observedAt ?? at,
          tripStartedAtMs: bus.tripStartedAt.getTime(),
          // A BMTC bus is never a reserved duty (docs/intercity-coaches.md
          // §1.2: reservation is a property of the service class, and a bus
          // has none). `reservation` stays `null` on every bus observation,
          // unconditionally, so this call site cannot accidentally invent
          // one - the field a coach duty will set this from does not exist
          // on `ActiveBus` at all.
          reservation: null,
        },
        this.#occupancyProfile,
      ),
    )
    return {
      bin,
      class: bus.member.class,
      duty,
      tracking,
      // `exactOptionalPropertyTypes` treats an explicit `occupancy: undefined`
      // as a type error on purpose (SPEC's honesty rule again, enforced by
      // the compiler this time): the key must be genuinely absent, not
      // present with an empty value, so it is spread in only when there is
      // something to spread.
      ...(occupancy !== undefined ? { occupancy } : {}),
      overridden: false,
    }
  }

  predictNextStops(bin: string, _at: Date, limit: number): readonly StopPrediction[] {
    const bus = this.#buses.get(bin)
    if (bus === undefined) return this.#coaches?.predictNextStops(bin, _at, limit) ?? []
    if (bus.cursor.layoverUntilMs !== null) return []
    const duty = this.#duties.get(bin)
    const device = this.#devices.get(bin)
    if (duty === undefined || device === undefined) return []
    const tracking = trackingObservation(device, _at, true, this.#deviceProfile)
    if (
      duty.status === 'unknown' ||
      duty.status === 'out_of_service' ||
      tracking.state === 'dark' ||
      tracking.state === 'untracked'
    ) {
      return []
    }
    const metresPerSecond = bus.cursor.speedKph / 3.6
    return bus.trip.stops
      .slice(bus.cursor.nextStopIndex, bus.cursor.nextStopIndex + limit)
      .map((stop, index) => ({
        stop: stopRef(stop),
        seconds: Math.max(0, Math.round((stop.stopDistanceMetres - bus.cursor.distanceMetres) / metresPerSecond)),
        // docs/intercity-coaches.md criterion 78: this was a hardcoded
        // `45 + index * 30` that did not read the configuration at all, so
        // PREDICTION_UNCERTAINTY_BASE_SECONDS and
        // PREDICTION_UNCERTAINTY_PER_STOP_SECONDS were documented knobs that
        // moved nothing. The literals happened to equal the defaults, which
        // is exactly why nobody noticed. Reading them changes no default
        // output and makes the two variables mean what .env.example says.
        uncertaintySeconds:
          config.predictionUncertaintyBaseSeconds +
          index * config.predictionUncertaintyPerStopSeconds,
      }))
  }

  /**
   * SPEC 7.3 rules 3 and 4, in one place so the feed cannot re-decide them.
   *
   * A bus beyond `PREDICTION_HORIZON_STOPS`, and every stop of a bus that is
   * `dark` or `untracked`, comes back with a null prediction, which the feed
   * publishes as `NO_DATA` with no arrival and no departure. Publishing a
   * prediction twenty stops ahead of a bus in Bengaluru traffic would be
   * fabrication with extra steps, and a dark bus is genuinely unlocatable -
   * stopped at a junction, diverted, or three kilometres on, with no bound on
   * any of it.
   */
  scheduleUpdates(bin: string, at: Date): readonly ScheduleUpdate[] {
    const bus = this.#buses.get(bin)
    if (bus === undefined) return this.#coaches?.scheduleUpdates(bin, at) ?? []
    const duty = this.#duties.get(bin)
    const device = this.#devices.get(bin)
    if (duty === undefined || device === undefined) return []
    if (duty.status === 'unknown' || duty.status === 'out_of_service') return []
    const predictions = this.predictNextStops(bin, at, config.predictionHorizonStops)
    const predicted = new Map(predictions.map((prediction) => [prediction.stop.id, prediction]))
    return bus.trip.stops.slice(bus.cursor.nextStopIndex).map((stop) => {
      const prediction = predicted.get(stop.stop.id)
      return {
        stop: stopRef(stop),
        seconds: prediction?.seconds ?? null,
        uncertaintySeconds: prediction?.uncertaintySeconds ?? null,
      }
    })
  }

  status(at: Date = this.#lastTickAt): WorldStatus {
    const coaches = this.#coaches
    return {
      geometryLoaded: true,
      routes: this.#gtfs.routes.size,
      metroLines: this.#metroLines,
      vehicles: this.#buses.size,
      lastTickAt: this.#lastTickAt.toISOString(),
      tickLagMs: this.#tickLagMs,
      seed: this.#profile.seed,
      // §10.7: the roster counts and the window travel with `corridors`, and
      // all four are omitted together when coaches are off.
      ...(coaches === null
        ? {}
        : {
            coachesRostered: coaches.rosteredCount,
            coachesActive: coaches.activeCount(at),
            rosterWindow: { from: coaches.rosterWindow.from, to: coaches.rosterWindow.to },
            rosterWindowStale: coaches.rosterWindowStale(at),
          }),
      // §14.1: omitted, not `corridors: undefined`, when the feature is off -
      // see the note on `exactOptionalPropertyTypes` at the occupancy
      // call site above for why that distinction has to be made this way.
      ...(this.#corridorCount === null ? {} : { corridors: this.#corridorCount }),
    }
  }

  readonly #metroLines: number

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
    // docs/intercity-coaches.md §3.6: advance the simulated clock by the same
    // speedup-multiplied amount the cursor just moved by, so every seeded
    // time bucket lives on it too. At `SIM_SPEEDUP=1` this equals `at` on
    // every tick (`elapsedSeconds === realElapsedSeconds`), which is why
    // nothing below changes for the bundled bus fixture.
    this.#simulatedAt = new Date(this.#simulatedAt.getTime() + elapsedSeconds * 1000)
    for (const bus of this.#buses.values()) {
      this.advanceBus(bus, this.#lastTickAt, elapsedSeconds)
      const duty = this.#duties.get(bus.member.bin)
      const device = this.#devices.get(bus.member.bin)
      if (duty === undefined || device === undefined) throw new Error(`Incomplete world state for ${bus.member.bin}`)
      maybeSwapDuty(duty, bus.member.bin, at, this.#dutyProfile, this.#simulatedAt)
      updateDevice(
        device,
        at,
        (fixSequence) => this.fixSnapshot(bus, fixSequence),
        this.#deviceProfile,
        this.#simulatedAt,
      )
    }
    // §11.3: the coach half iterates `#active` only - at about eleven running
    // coaches out of thirty-four rostered, a small fraction of the sixty-bus
    // loop above.
    this.#coaches?.tickAt(at)
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
        // §3.2: set once, here, at the instant this new leg genuinely
        // starts - not recomputed later from `tripStartedAt` on every read.
        bus.serviceDate = serviceDate(current, this.#profile.timezone)
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

  private fixSnapshot(bus: ActiveBus, fixSequence: number): FixSnapshot {
    const shape = this.#gtfs.shapes.get(bus.trip.shapeId)
    if (shape === undefined) throw new Error(`Missing active shape ${bus.trip.shapeId}`)
    const interpolated = positionAt(shape, bus.cursor.distanceMetres)
    const stopped = bus.cursor.dwellUntilMs !== null || bus.cursor.layoverUntilMs !== null
    return {
      position: addGpsNoise(
        {
          ...interpolated,
          speedKph: stopped ? 0 : bus.cursor.speedKph,
          accuracyMetres: 0,
        },
        this.#deviceProfile,
        bus.member.bin,
        fixSequence,
      ),
      progress: this.progress(bus, shape.lengthMetres),
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

/**
 * docs/intercity-coaches.md §14.1: unset by default, in which case this is
 * `null` and nothing else is read at all - no file, no validation, no field
 * on `/readyz`, no coach in the fleet and no new key on any response.
 */
export async function loadIntercity() {
  return loadIntercitySetup({
    corridors: config.intercityCorridors,
    topologyPath: config.intercityTopologyPath,
    rosterPath: config.intercityRosterPath,
    hubCodes: config.intercityHubCodes,
    serviceClassIds: config.intercityServiceClasses,
    classesPath: resolve('./data/bundle/corridor-classes.json'),
  })
}

export { coachSlotsFor }

export async function createWorld(
  fleet: readonly FleetMember[],
  preloaded?: Awaited<ReturnType<typeof loadIntercity>>,
): Promise<SimWorld> {
  const gtfs = await loadGtfs()
  const metro = await loadMetroTopology(config.metroTopologyPath, config.metroMaxStationGapMetres)
  const intercity = preloaded ?? (await loadIntercity())
  const bootAt = createClock(config.simClock).now()
  const profiles: CoachWorldProfiles = defaultCoachProfiles
  const coaches =
    intercity === null
      ? null
      : new CoachSimulation({
          topology: intercity.topology,
          serviceClasses: intercity.serviceClasses,
          roster: intercity.roster,
          fleet,
          corridorIds: config.intercityCorridors,
          profiles,
          bootAt,
        })
  // A coach is rostered by departure, never spread around a GTFS route, so
  // it must not reach `dispatchInitialFleet` at all - it has no `route_id` to
  // be spread around. The split is on carrying a **service class**, which
  // only a coach does, rather than on the class name: the same axis §7.3
  // uses for the occupancy refusal, and it keeps this file outside
  // tests/contract/sourceBoundaries.test.ts's class-comparison regex.
  const dispatchable = fleet.filter((member) => member.serviceClass == null)
  return new SimWorld(gtfs, dispatchable, {
    metroLines: metro.lines.length,
    metroTopology: metro,
    ...(intercity === null ? {} : { corridorCount: config.intercityCorridors.length }),
    ...(coaches === null ? {} : { coaches }),
  })
}

/** The `CreateWorld` shape `src/world/port.ts` names, satisfied structurally. */
export const createWorldPort: CreateWorld = (fleet) => createWorld(fleet)
