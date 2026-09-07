import { CORPORATION_NAMES, fixtureHub, type Corporation } from '../fleet/corporation.js'
import type { ServiceClass } from '../fleet/serviceClass.js'
import { reverseCorridor, type Corridor, type CorridorTopology } from '../geometry/corridorTopology.js'
import { positionAt } from '../geometry/shape.js'
import type {
  DutyObservation,
  FleetMember,
  IntercityPort,
  IntercityResult,
  ProgressLogEntry,
  ScheduleUpdate,
  StopPrediction,
  TrackingObservation,
  VehicleObservation,
} from '../world/port.js'
import { addGpsNoise, type FixSnapshot } from './device.js'
import {
  advanceCoach,
  createCoachCursor,
  segmentKindAt,
  type CoachCursor,
  type CoachMotionProfile,
} from './coachCursor.js'
import {
  activeAt,
  assignFleet,
  buildRoster,
  rosterWindowFor,
  windowContains,
  type Assignment,
  type CoachDuty,
  type CorridorRosterFile,
  type RosterWindow,
  type ScheduleProfile,
} from './corridorRoster.js'
import {
  coverageShareFor,
  createIntercityDeviceState,
  deadZoneAt,
  intercityGpsProfile,
  intercityTrackingObservation,
  updateIntercityDevice,
  type IntercityDeviceProfile,
  type IntercityDeviceState,
  type IntercityFixContext,
} from './intercityDevice.js'
import {
  intercityUncertaintySeconds,
  predictIntercityStands,
  type IntercityPredictionProfile,
} from './intercityPrediction.js'
import {
  demoContinuityBins,
  demoContinuityDutyState,
  isDemoContinuityLeg,
  pinDemoContinuityChains,
} from './demoContinuity.js'
import { isoToCompact, localDayCompact } from './localTime.js'
import { ManifestStore, publishManifest, type ManifestProfile } from './manifest.js'
import { occupancyFor, projectOccupancy, type BusOccupancyProfile } from './occupancy.js'
import { createDutyState, type BusDutyProfile, type DutyState } from './duty.js'

/**
 * The coach half of the world - docs/intercity-coaches.md §11.3.
 *
 * `tickAt` today iterates every vehicle in one map. With a coach roster most
 * of those vehicles are not running, and advancing a cursor for a coach
 * parked in a depot until tomorrow night is pure waste. So this holds two
 * collections:
 *
 *     #roster   every duty in the window, with its assignment. Read on lookup.
 *     #active   the duties dispatched and not yet arrived. Iterated every tick.
 *
 * **A run's state is a pure function of its duty and an instant**, computed by
 * replaying the duty from its own departure on a fixed simulated-time grid.
 * That is what makes criterion 103 - "a process restarted mid-run reproduces
 * the duty's `progressLog` exactly, by replay" - true by construction rather
 * than by a persistence mechanism this service is built not to have. The
 * replay is memoised: a run advances forward from where it already is, and
 * only a request for an earlier instant (`?at=` inside the roster window)
 * rebuilds it from the departure.
 */

/**
 * The replay grid. Every seeded draw and every device fix lands on a
 * multiple of this many simulated seconds from the duty's departure, which is
 * what makes two processes that started at different wall-clock moments agree
 * to the byte. Fifteen seconds is half the moving fix interval, so no fix is
 * ever delayed by more than half its own period.
 */
const REPLAY_STEP_SECONDS = 15

/**
 * §12.5: "`INTERCITY_DUTY_SWAP_RATE_PER_DAY` is `0` and not configurable
 * upward." A coach 200 km from the nearest depot cannot be reassigned to
 * another block, so the bus model's mid-run duty swap must not run here at
 * all. It is a constant rather than an environment variable precisely so a
 * deployment cannot turn it on: what happens instead is vehicle substitution
 * before departure, which changes the BIN bound to a duty and leaves
 * `duty.status` `confirmed`.
 */
export const INTERCITY_DUTY_SWAP_RATE_PER_DAY = 0

export interface CoachWorldProfiles {
  readonly seed: number
  readonly timezone: string
  readonly motion: CoachMotionProfile
  readonly device: IntercityDeviceProfile
  readonly duty: BusDutyProfile
  readonly prediction: IntercityPredictionProfile
  readonly occupancy: BusOccupancyProfile
  readonly manifest: ManifestProfile
  readonly schedule: ScheduleProfile
  readonly rosterDays: number
  readonly assignmentHorizonHours: number
  readonly substitutionRatePerDuty: number
  readonly progressLogMaxEntries: number
}

export interface CoachWorldOptions {
  readonly topology: CorridorTopology
  readonly serviceClasses: readonly ServiceClass[]
  readonly roster: CorridorRosterFile
  readonly fleet: readonly FleetMember[]
  readonly corridorIds: readonly string[]
  readonly profiles: CoachWorldProfiles
  readonly bootAt: Date
}

interface CoachRun {
  readonly duty: CoachDuty
  readonly corridor: Corridor
  readonly bin: string
  readonly reserved: boolean
  cursor: CoachCursor
  device: IntercityDeviceState
  dutyState: DutyState
  log: ProgressLogEntry[]
  stepIndex: number
  loggedDark: boolean
}

export class CoachSimulation implements IntercityPort {
  readonly #corridors: readonly Corridor[]
  readonly #serviceClasses: readonly ServiceClass[]
  readonly #profiles: CoachWorldProfiles
  readonly #duties: readonly CoachDuty[]
  readonly #assignments: ReadonlyMap<string, Assignment>
  readonly #dutyById: ReadonlyMap<string, CoachDuty>
  readonly #window: RosterWindow
  readonly #manifests: ManifestStore
  readonly #runs = new Map<string, CoachRun>()
  readonly #binToDuties = new Map<string, CoachDuty[]>()
  /**
   * The mirrored geometry for a corridor's `reverse` direction (§ "single-
   * direction roster mechanism" fix), built lazily and once per corridor
   * that actually rosters a `reverse` departure - most corridors never need
   * one. `reverseCorridor` is a pure function of the forward corridor
   * already loaded from the committed topology, so this cache never goes
   * stale within a process and never touches `data/bundle/corridor-
   * topology.json` at all.
   */
  readonly #reverseCorridors = new Map<string, Corridor>()

  constructor(options: CoachWorldOptions) {
    this.#profiles = options.profiles
    this.#serviceClasses = options.serviceClasses
    this.#corridors = options.topology.corridors.filter((corridor) =>
      options.corridorIds.includes(corridor.id),
    )
    this.#window = rosterWindowFor(options.bootAt, options.profiles.rosterDays, options.profiles.timezone)
    this.#duties = buildRoster(this.#corridors, options.roster, this.#window, options.profiles.schedule)
    this.#dutyById = new Map(this.#duties.map((duty) => [duty.id, duty]))
    // `demoContinuityBins()` is excluded from the ordinary pool before
    // `assignFleet` ever sees it - see `demoContinuity.ts`'s own comment.
    // Left in, one of these coaches could be handed a second, unrelated,
    // time-overlapping duty by the very per-corridor draw
    // `pinDemoContinuityChains` below exists to override, and a bin with two
    // simultaneous duties is not a thing `#binToDuties` can represent.
    const pinnedBins = demoContinuityBins()
    const pool = options.fleet
      .filter((member) => member.class === 'coach' && !pinnedBins.has(member.bin))
      .map((member) => ({
        bin: member.bin,
        corridorId: member.homeRouteNumber,
        serviceClassId: member.serviceClass ?? '',
        // The bin's own hub prefix, exactly as `vehicleRef` and
        // `generateCoachFleet` already read/write it (`formatBin(slot.hub,
        // serial)`) - see `AssignmentPoolMember.hub`'s own comment.
        hub: member.bin.slice(0, 3),
      }))
    this.#assignments = pinDemoContinuityChains(
      this.#duties,
      assignFleet(this.#duties, pool, options.profiles.seed, options.profiles.substitutionRatePerDuty),
    )
    for (const duty of this.#duties) {
      const assignment = this.#assignments.get(duty.id)
      if (assignment === undefined) continue
      const list = this.#binToDuties.get(assignment.bin) ?? []
      list.push(duty)
      this.#binToDuties.set(assignment.bin, list)
    }
    this.#manifests = new ManifestStore(options.profiles.manifest)
  }

  get rosterWindow(): RosterWindow {
    return this.#window
  }

  get rosteredCount(): number {
    return this.#duties.length
  }

  get corridorCount(): number {
    return this.#corridors.length
  }

  activeCount(at: Date): number {
    return activeAt(this.#duties, at).length
  }

  /** §10.7: the `503` that catches a process whose roster ran out yesterday. */
  rosterWindowStale(at: Date): boolean {
    return !windowContains(this.#window, localDayCompact(at, this.#profiles.timezone))
  }

  /**
   * §11.3: `tickAt` iterates `#active` only, plus a cheap scan of the roster
   * for departures due since the last tick and arrivals to retire. Because a
   * run's state is a replay from its own departure, this method's only job is
   * to keep the memoised runs warm and to drop the ones that are finished -
   * an observation at an instant no tick has reached is computed on demand
   * and is identical either way.
   */
  tickAt(at: Date): void {
    const active = new Set(activeAt(this.#duties, at).map((duty) => duty.id))
    for (const dutyId of [...this.#runs.keys()]) {
      if (!active.has(dutyId)) this.#runs.delete(dutyId)
    }
    for (const duty of activeAt(this.#duties, at)) this.runAt(duty, at)
  }

  observe(bin: string, at: Date): VehicleObservation | null {
    const run = this.runForBin(bin, at)
    if (run === null) return null
    const duty = this.dutyObservationFor(run, at)
    const context = this.fixContext(run)
    const tracking = intercityTrackingObservation(
      run.device,
      at,
      duty.route !== null || duty.corridor !== null,
      context,
      this.#profiles.device,
    )
    // §7.2/§7.3: the reserved branch is a branch on the duty, never on the
    // vehicle class, and the manifest never reaches `occupancyFor` at all.
    // There is nowhere on `OccupancyInput` for a seat count to arrive.
    const occupancy = projectOccupancy(
      occupancyFor(
        {
          bin,
          trackingState: tracking.state,
          routeId: run.corridor.id,
          routeNumber: run.duty.number,
          directionId: 0,
          distanceAlongRouteMetres: run.device.lastFix?.distanceMetres ?? run.cursor.distanceMetres,
          routeLengthMetres: run.corridor.lengthMetres,
          at: run.device.lastFix?.observedAt ?? at,
          tripStartedAtMs: run.duty.departureAt.getTime(),
          reservation: run.reserved ? { required: true } : null,
          longDistance: true,
        },
        this.#profiles.occupancy,
      ),
    )
    return {
      bin,
      class: 'coach',
      duty,
      tracking: this.withDwell(tracking, run),
      ...(occupancy === undefined ? {} : { occupancy }),
      overridden: false,
    }
  }

  predictNextStops(bin: string, at: Date, limit: number): readonly StopPrediction[] {
    return this.predictions(bin, at)
      .filter((prediction) => !prediction.beyondHorizon)
      .slice(0, limit)
      .map((prediction) => ({
        stop: prediction.stop,
        seconds: prediction.seconds,
        uncertaintySeconds: prediction.uncertaintySeconds,
      }))
  }

  /**
   * §5.4 and §10.8, together, in the one place both rules are decided.
   *
   * Beyond `INTERCITY_PREDICTION_HORIZON_SECONDS` a stand is `NO_DATA` with
   * no arrival and no departure - a horizon in time rather than in stops,
   * because a corridor with nine stands and a five-stop horizon refuses to
   * predict the destination, which is the one arrival the rider cares about
   * and the one this model genuinely supports.
   *
   * A stand ahead of a **dark** coach is `NO_DATA` too, unless the coach is
   * inside an authored dead zone. That is the whole asymmetry, and it is
   * narrow on purpose: a dark coach on an urban segment has lost its device
   * near a city and is a city bus's problem, with a city bus's ignorance. A
   * dark coach in a dead zone is on a divided highway it cannot leave,
   * entered at a known distance and a known speed, and blanking its
   * destination for forty minutes would discard information the service
   * genuinely has.
   */
  scheduleUpdates(bin: string, at: Date): readonly ScheduleUpdate[] {
    const run = this.runForBin(bin, at)
    if (run === null) return []
    if (run.dutyState.status === 'unknown' || run.dutyState.status === 'out_of_service') return []
    const predicted = new Map(
      this.predictNextStops(bin, at, Number.MAX_SAFE_INTEGER).map((prediction) => [
        prediction.stop.id,
        prediction,
      ]),
    )
    return run.corridor.stands.slice(run.cursor.nextStandIndex).map((stand, offset) => {
      const prediction = predicted.get(stand.id)
      return {
        stop: {
          id: stand.id,
          name: stand.name,
          nameLocal: stand.nameLocal,
          sequence: run.cursor.nextStandIndex + offset + 1,
        },
        seconds: prediction?.seconds ?? null,
        uncertaintySeconds: prediction?.uncertaintySeconds ?? null,
      }
    })
  }

  private predictions(bin: string, at: Date) {
    const run = this.runForBin(bin, at)
    if (run === null) return []
    const context = this.fixContext(run)
    const tracking = intercityTrackingObservation(run.device, at, true, context, this.#profiles.device)
    if (run.dutyState.status === 'unknown' || run.dutyState.status === 'out_of_service') return []
    if (tracking.state === 'untracked') return []
    const insideDeadZone = deadZoneAt(run.cursor.distanceMetres, run.corridor.deadZones) !== null
    if (tracking.state === 'dark' && !insideDeadZone) return []
    return predictIntercityStands(
      run.corridor,
      run.cursor,
      at,
      this.#profiles.prediction,
      insideDeadZone,
    )
  }

  /* ---------------------------------------------------------------- *
   * §10.3  GET /fleet/duty
   * ---------------------------------------------------------------- */

  dutyLookup(
    query: { readonly serviceId?: string; readonly date?: string; readonly dutyId?: string },
    at: Date,
  ): IntercityResult {
    if (query.dutyId !== undefined) {
      const duty = this.#dutyById.get(query.dutyId)
      if (duty !== undefined) return { status: 200, body: this.dutyBody(duty, at) }
      // A composite id is `<corridor>-<YYYYMMDD>-<HHMM>`. If the date part
      // parses and simply falls outside the window, the caller's id is right
      // and this process does not hold that day - which is a `400` carrying
      // the window, never a `404` telling a caller its id is wrong when it is
      // not (§10.3). Anything else genuinely is an unknown duty.
      const parsed = /^(.+)-(\d{8})-(\d{4}R?)$/.exec(query.dutyId)
      const corridorKnown =
        parsed !== null && this.#corridors.some((corridor) => corridor.id === parsed[1])
      if (corridorKnown && !windowContains(this.#window, parsed![2]!)) {
        return this.outsideWindow(query.dutyId, parsed![2]!)
      }
      return {
        status: 404,
        body: { error: 'unknown_duty', message: 'No duty exists with that id.', dutyId: query.dutyId },
      }
    }
    if (query.serviceId === undefined || query.serviceId === '') {
      return {
        status: 400,
        body: { error: 'invalid_request', message: 'service is required, with date.' },
      }
    }
    if (query.date === undefined || !/^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(query.date)) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          message: 'date must be an ISO YYYY-MM-DD travel date or a GTFS YYYYMMDD service date.',
        },
      }
    }
    const runsAtAll = this.#duties.some((duty) => duty.serviceId === query.serviceId)
    if (!runsAtAll) {
      return {
        status: 404,
        body: {
          error: 'unknown_duty',
          message: 'No corridor rosters that service.',
          serviceId: query.serviceId,
        },
      }
    }
    const compact = query.date.includes('-') ? isoToCompact(query.date) : query.date
    // §10.3: "A travel date and a service date differ for a departure after
    // midnight, and the response states both rather than silently picking
    // one." Both spellings are accepted and matched against both fields;
    // guessing which of the two a caller meant, and saying nothing, is how
    // two correct systems disagree quietly for a month.
    const matched = this.#duties.find(
      (duty) =>
        duty.serviceId === query.serviceId &&
        (duty.serviceDate === compact || isoToCompact(duty.travelDate) === compact),
    )
    if (matched !== undefined) return { status: 200, body: this.dutyBody(matched, at) }
    if (!windowContains(this.#window, compact)) return this.outsideWindow(null, compact)
    return {
      status: 404,
      body: {
        error: 'duty_not_scheduled',
        message: 'That service does not run on that date.',
        serviceId: query.serviceId,
        date: query.date,
        nearestDates: this.#duties
          .filter((duty) => duty.serviceId === query.serviceId)
          .map((duty) => ({ serviceDate: duty.serviceDate, travelDate: duty.travelDate }))
          .slice(0, 4),
      },
    }
  }

  private outsideWindow(dutyId: string | null, date?: string): IntercityResult {
    return {
      status: 400,
      body: {
        error: 'outside_roster_window',
        message: 'That date is outside the roster window this process holds.',
        ...(dutyId === null ? {} : { dutyId }),
        ...(date === undefined ? {} : { date }),
        rosterWindow: { from: this.#window.from, to: this.#window.to },
      },
    }
  }

  private dutyBody(duty: CoachDuty, at: Date): Record<string, unknown> {
    const assignment = this.#assignments.get(duty.id) ?? null
    const corridor = this.corridorOf(duty)
    const horizonMs = this.#profiles.assignmentHorizonHours * 3_600_000
    const beyondHorizon = duty.departureAt.getTime() - at.getTime() > horizonMs
    const base = {
      duty: {
        id: duty.id,
        service: { id: duty.serviceId, number: duty.number, headsign: duty.headsign },
        serviceDate: duty.serviceDate,
        travelDate: duty.travelDate,
        corridor: corridorRef(corridor),
        scheduledDeparture: duty.departureAt.toISOString(),
        scheduledArrival: duty.scheduledArrivalAt.toISOString(),
        startTime: duty.startTime,
      },
      meta: { simulated: true, seed: this.#profiles.seed, generatedAt: at.toISOString() },
    }
    if (beyondHorizon || assignment === null) {
      // §10.3: "A duty further out than `INTERCITY_ASSIGNMENT_HORIZON_HOURS`
      // has no vehicle yet, and that is a `200`." A `404` would tell a caller
      // its duty id is wrong when it is right, and naming a plate for a coach
      // three weeks out would assert an operational commitment nobody has
      // made. The assignment function is seeded and pure, so the answer is
      // computable; the horizon governs when this service is willing to state
      // it as a fact about the world, which is a different question from
      // whether it is determined.
      return {
        ...base,
        assignment: {
          status: 'not_yet_assigned',
          assignsAfter: new Date(duty.departureAt.getTime() - horizonMs).toISOString(),
          reason: 'beyond_assignment_horizon',
        },
        vehicle: null,
        tracking: null,
      }
    }
    const observation = this.observe(assignment.bin, at)
    return {
      ...base,
      assignment: {
        status: assignment.status,
        assignedAt: new Date(duty.departureAt.getTime() - horizonMs).toISOString(),
        source: 'roster',
        supersededAt: assignment.supersededAt?.toISOString() ?? null,
        previousBin: assignment.previousBin,
      },
      vehicle: this.vehicleRef(assignment.bin, duty),
      tracking: observation?.tracking ?? null,
    }
  }

  /* ---------------------------------------------------------------- *
   * §10.4  GET /fleet/corridors
   * ---------------------------------------------------------------- */

  corridors(at: Date): IntercityResult {
    const today = localDayCompact(at, this.#profiles.timezone)
    const nowMs = at.getTime()
    return {
      status: 200,
      body: {
        corridors: this.#corridors.map((corridor) => {
          // A duty's own `serviceDate` is the day it pulled out, not the day
          // it is on the road - a 22:59 departure runs most of its trip on
          // the calendar day after its serviceDate. Filtering on
          // `serviceDate === today` alone silently drops it from this list
          // the moment midnight passes, even though the coach is still
          // moving: at 01:05 the corridor would show its next scheduled
          // pull-out and nothing else, which is what actually happens to be
          // running right now going missing from the one endpoint an
          // operator would check to find it. `activeAt` (used for `running`
          // and `coverage` below already, and unaffected by this) is what
          // decides whether a duty is genuinely on the road; a duty this
          // corridor still owes an answer about - today's own list, plus
          // whatever is actually running from the day before - is what
          // belongs here too.
          const departures = this.#duties.filter(
            (duty) =>
              duty.corridorId === corridor.id &&
              (duty.serviceDate === today ||
                (duty.departureAt.getTime() <= nowMs && duty.scheduledArrivalAt.getTime() > nowMs)),
          )
          const running = activeAt(this.#duties, at).filter((duty) => duty.corridorId === corridor.id)
          const tracked = running.filter((duty) => {
            const bin = this.#assignments.get(duty.id)?.bin
            if (bin === undefined) return false
            return this.observe(bin, at)?.tracking.state !== 'untracked'
          }).length
          return {
            id: corridor.id,
            name: corridor.name,
            nameLocal: corridor.nameLocal,
            corporations: corridor.corporations,
            lengthMetres: corridor.lengthMetres,
            standCount: corridor.stands.length,
            geometry: {
              routed: corridor.segments.filter((segment) => segment.geometry === 'routed').length,
              osmRelation: corridor.segments.filter((segment) => segment.geometry === 'osm_relation').length,
              interpolated: corridor.segments.filter((segment) => segment.geometry === 'interpolated')
                .length,
            },
            segments: {
              highway: corridor.segments.filter((segment) => segment.kind === 'highway').length,
              urban: corridor.segments.filter((segment) => segment.kind === 'urban').length,
            },
            deadZones: {
              count: corridor.deadZones.length,
              totalMetres: corridor.deadZones.reduce(
                (total, zone) => total + (zone.toMetres - zone.fromMetres),
                0,
              ),
              shareOfRoute:
                corridor.lengthMetres === 0
                  ? 0
                  : Math.round(
                      (corridor.deadZones.reduce(
                        (total, zone) => total + (zone.toMetres - zone.fromMetres),
                        0,
                      ) /
                        corridor.lengthMetres) *
                        100,
                    ) / 100,
            },
            departuresToday: departures.map((duty) => {
              const assignment = this.#assignments.get(duty.id) ?? null
              const beyond =
                duty.departureAt.getTime() - at.getTime() >
                this.#profiles.assignmentHorizonHours * 3_600_000
              return {
                dutyId: duty.id,
                serviceId: duty.serviceId,
                departsAt: duty.departureAt.toISOString(),
                serviceClass: duty.serviceClassId,
                assignment: beyond || assignment === null ? 'not_yet_assigned' : assignment.status,
                vehicleBin: beyond || assignment === null ? null : assignment.bin,
              }
            }),
            coverage: {
              tracked,
              untracked: running.length - tracked,
              share: running.length === 0 ? null : Math.round((tracked / running.length) * 100) / 100,
            },
            // §13.3: "A departure time is exactly the kind of number a
            // screenshot turns into a fact." It is marked in SOURCE.md, in
            // the fidelity table, and here - on an endpoint anyone can curl.
            provenance: { stands: 'authored_secondary', departures: 'authored_secondary' },
          }
        }),
        meta: { simulated: true, seed: this.#profiles.seed, generatedAt: at.toISOString() },
      },
    }
  }

  /* ---------------------------------------------------------------- *
   * §7.4/§10.5  PUT and DELETE /fleet/manifest
   * ---------------------------------------------------------------- */

  putManifest(body: unknown, at: Date): IntercityResult {
    const outcome = this.#manifests.put(body, at)
    if (outcome.kind === 'invalid') {
      return { status: 400, body: { error: 'invalid_request', message: outcome.message } }
    }
    const held = outcome.kind === 'stored' ? outcome.manifest : outcome.held
    const duty = this.dutyForManifest(held.serviceId, held.travelDate)
    const dateNote =
      duty !== null && isoToCompact(duty.travelDate) !== duty.serviceDate
        ? { note: 'This departure belongs to the previous GTFS service date.' }
        : {}
    return {
      status: 200,
      body: {
        serviceId: held.serviceId,
        travelDate: held.travelDate,
        serviceDate: duty?.serviceDate ?? null,
        dutyId: duty?.id ?? null,
        ...dateNote,
        // §7.4: an out-of-order push is accepted with a `200`, discarded, and
        // the response names the manifest still held. A stale count
        // clobbering a fresh one would be silently wrong for an hour.
        ...(outcome.kind === 'discarded_out_of_order'
          ? { accepted: false, discarded: 'stale_as_of', rejectedAsOf: outcome.rejectedAsOf }
          : { accepted: true }),
        stored: {
          seatsBooked: held.seatsBooked,
          seatsTotal: held.seatsTotal,
          asOf: held.asOf.toISOString(),
          expiresAt: held.expiresAt.toISOString(),
        },
        meta: { simulated: true, generatedAt: at.toISOString() },
      },
    }
  }

  deleteManifest(
    query: { readonly serviceId: string | null; readonly travelDate: string | null },
    at: Date,
  ): IntercityResult {
    const cleared = this.#manifests.delete(query.serviceId, query.travelDate)
    return {
      status: 200,
      body: {
        cleared,
        serviceId: query.serviceId,
        travelDate: query.travelDate,
        meta: { simulated: true, generatedAt: at.toISOString() },
      },
    }
  }

  /* ---------------------------------------------------------------- *
   * The run: replay, memoised
   * ---------------------------------------------------------------- */

  private runForBin(bin: string, at: Date): CoachRun | null {
    const duties = this.#binToDuties.get(bin) ?? []
    const ms = at.getTime()
    const duty = duties.find(
      (candidate) =>
        candidate.departureAt.getTime() <= ms && candidate.scheduledArrivalAt.getTime() > ms,
    )
    if (duty === undefined) return null
    return this.runAt(duty, at)
  }

  private runAt(duty: CoachDuty, at: Date): CoachRun {
    const targetStep = Math.max(
      0,
      Math.floor((at.getTime() - duty.departureAt.getTime()) / (REPLAY_STEP_SECONDS * 1_000)),
    )
    let run = this.#runs.get(duty.id)
    if (run === undefined || run.stepIndex > targetStep) {
      run = this.createRun(duty)
      this.#runs.set(duty.id, run)
    }
    while (run.stepIndex < targetStep) this.step(run)
    return run
  }

  private createRun(duty: CoachDuty): CoachRun {
    const run = this.buildRun(duty)
    // A coach at its departure stand has already reported: the device took a
    // fix before it pulled out. Without this the first fifteen seconds of
    // every run would read `untracked` with `no_device_fitted`, which claims
    // a coverage gap that is not there.
    updateIntercityDevice(
      run.device,
      duty.departureAt,
      this.fixContext(run),
      (fixSequence) => this.fixSnapshot(run, fixSequence),
      this.#profiles.device,
      duty.departureAt,
    )
    return run
  }

  private buildRun(duty: CoachDuty): CoachRun {
    const corridor = this.corridorOf(duty)
    const assignment = this.#assignments.get(duty.id)
    const bin = assignment?.bin ?? ''
    const serviceClass = this.serviceClass(duty.serviceClassId)
    const reserved = serviceClass?.reserved ?? false
    return {
      duty,
      corridor,
      bin,
      reserved,
      cursor: createCoachCursor(corridor, this.#profiles.motion, bin),
      device: createIntercityDeviceState(bin, reserved, this.#profiles.device),
      // §3.1: keyed on the duty's own service date, never on the wall date.
      // The composite key is the run code and the service date together,
      // because a corridor runs the same coach on the same date once and a
      // second departure that day is a different duty.
      //
      // One of the nine pinned demo legs (`demoContinuity.ts`) skips this
      // draw entirely - see `isDemoContinuityLeg`'s own comment for why a
      // sticker vehicle cannot also be subject to the roster's ordinary
      // confidence model.
      dutyState: isDemoContinuityLeg(duty.corridorId, duty.serviceId)
        ? demoContinuityDutyState(duty.departureAt)
        : createDutyState(
            bin,
            duty.departureAt,
            `${duty.serviceId}|${duty.serviceDate}`,
            this.#profiles.duty,
          ),
      log: [
        {
          at: duty.departureAt.toISOString(),
          event: 'departed',
          stop: corridor.stands[0]?.name ?? duty.headsign,
        },
      ],
      stepIndex: 0,
      loggedDark: false,
    }
  }

  private step(run: CoachRun): void {
    const stepStart = new Date(
      run.duty.departureAt.getTime() + run.stepIndex * REPLAY_STEP_SECONDS * 1_000,
    )
    const stepEnd = new Date(stepStart.getTime() + REPLAY_STEP_SECONDS * 1_000)
    const result = advanceCoach(
      run.cursor,
      run.corridor,
      stepStart,
      REPLAY_STEP_SECONDS,
      this.#profiles.motion,
      run.bin,
    )
    // §8.2's log is a journal of what happened, not of every internal
    // transition: a two-minute city-side pickup is a `departed`, and only a
    // halt long enough for a rider to wonder about - the meal halt, a crew
    // change - is worth both a beginning and an end. The distinction is the
    // same one §4.1's dwell table draws.
    const journalled = new Set(['meal_halt', 'crew_change'])
    for (const event of result.events) {
      const at = new Date(event.atMs).toISOString()
      if (event.kind === 'arrived') {
        this.appendLog(run, { at, event: 'arrived', stop: event.standName })
      } else if (journalled.has(event.dwellKind)) {
        if (event.kind !== 'departed') {
          this.appendLog(run, { at, event: event.kind, stop: event.standName })
        }
      } else if (event.kind === 'departed') {
        this.appendLog(run, { at, event: 'departed', stop: event.standName })
      }
    }

    const wasDark = run.device.blockedSinceMs !== null
    const beforeFix = run.device.lastFix
    updateIntercityDevice(
      run.device,
      stepEnd,
      this.fixContext(run),
      (fixSequence) => this.fixSnapshot(run, fixSequence),
      this.#profiles.device,
      // §3.6: the seeded dropout bucket lives on simulated elapsed time, and
      // on this replay grid the two are the same clock by construction.
      stepEnd,
    )
    const isDark = run.device.blockedSinceMs !== null
    if (isDark && !run.loggedDark && beforeFix !== null) {
      const ageSeconds = (stepEnd.getTime() - beforeFix.observedAt.getTime()) / 1_000
      if (ageSeconds > this.#profiles.device.darkAfterSeconds) {
        run.loggedDark = true
        this.appendLog(run, {
          at: stepEnd.toISOString(),
          event: 'went_dark',
          cause: run.device.currentZone !== null ? 'dead_zone' : 'unknown',
        })
      }
    }
    if (wasDark && !isDark && run.loggedDark) {
      run.loggedDark = false
      const recovery = run.device.recovery
      this.appendLog(run, {
        at: stepEnd.toISOString(),
        event: 'recovered',
        ...(recovery === null ? {} : { gapMetres: Math.round(recovery.gapMetres) }),
      })
    }
    run.stepIndex += 1
  }

  /** §8.3: capped at `INTERCITY_PROGRESS_LOG_MAX_ENTRIES`, oldest dropped first. */
  private appendLog(run: CoachRun, entry: ProgressLogEntry): void {
    run.log.push(entry)
    while (run.log.length > this.#profiles.progressLogMaxEntries) run.log.shift()
  }

  private fixContext(run: CoachRun): IntercityFixContext {
    const zone = deadZoneAt(run.cursor.distanceMetres, run.corridor.deadZones)
    const remainingKm = zone === null ? 0 : Math.max(0, zone.toMetres - run.cursor.distanceMetres) / 1_000
    return {
      distanceMetres: run.cursor.distanceMetres,
      corridorId: run.corridor.id,
      deadZones: run.corridor.deadZones,
      segmentKind: segmentKindAt(run.corridor, run.cursor.nextStandIndex - 1),
      stationary: run.cursor.dwell !== null,
      speedKph: run.cursor.dwell !== null ? 0 : run.cursor.speedKph,
      // The exit estimate's band is §5.3's model applied to the exit point,
      // rather than a second constant invented for this one field.
      exitUncertaintySeconds: intercityUncertaintySeconds(this.#profiles.prediction, {
        remainingHighwayKm: remainingKm,
        haltsRemaining: 0,
        urbanApproach: false,
        insideDeadZone: true,
      }),
    }
  }

  private fixSnapshot(run: CoachRun, fixSequence: number): FixSnapshot {
    const interpolated = positionAt(run.corridor.track, run.cursor.distanceMetres)
    const stopped = run.cursor.dwell !== null
    return {
      position: addGpsNoise(
        {
          ...interpolated,
          speedKph: stopped ? 0 : run.cursor.speedKph,
          accuracyMetres: 0,
        },
        intercityGpsProfile(this.#profiles.device),
        run.bin,
        fixSequence,
      ),
      progress: this.progress(run),
    }
  }

  private progress(run: CoachRun) {
    const next = run.corridor.stands[run.cursor.nextStandIndex]
    return {
      nextStop:
        next === undefined
          ? null
          : {
              id: next.id,
              name: next.name,
              nameLocal: next.nameLocal,
              sequence: run.cursor.nextStandIndex + 1,
            },
      currentStatus:
        run.cursor.dwell !== null
          ? ('STOPPED_AT' as const)
          : next !== undefined && next.distanceMetres - run.cursor.distanceMetres < 200
            ? ('INCOMING_AT' as const)
            : ('IN_TRANSIT_TO' as const),
      distanceAlongRouteMetres: run.cursor.distanceMetres,
      routeLengthMetres: run.corridor.lengthMetres,
    }
  }

  /**
   * §4.2: the `dwell` object rides on `progress`, and it is present exactly
   * while the coach is stopped. It is **not** folded into `tracking.reason`:
   * a halted coach with a working device is `live` with a null reason, and a
   * halted coach whose device has gone dark carries the dwell *and* the
   * dropout - two independent facts about the same vehicle, both published,
   * in the same way `duty` and `tracking` are kept apart. Folding one into
   * the other would let a stationary coach hide a dead device for half an
   * hour.
   */
  private withDwell(tracking: TrackingObservation, run: CoachRun): TrackingObservation {
    if (tracking.progress === null) {
      // A dwell that is still happening is still true while the fix ages out,
      // but `progress` is null in `stale`, `dark` and `untracked` (§10.2), so
      // there is nowhere to hang it and nothing is invented to carry it.
      return tracking
    }
    const dwell = run.cursor.dwell
    return {
      ...tracking,
      progress: {
        ...tracking.progress,
        dwell:
          dwell === null
            ? null
            : {
                kind: dwell.kind,
                stop: { id: dwell.standId, name: dwell.standName },
                startedAt: new Date(dwell.startedAtMs).toISOString(),
                scheduledSeconds: Math.round(dwell.scheduledSeconds),
                endsAt: new Date(dwell.endsAtMs).toISOString(),
                endsAtUncertaintySeconds: dwell.uncertaintySeconds,
              },
      },
    }
  }

  private dutyObservationFor(run: CoachRun, at: Date): DutyObservation {
    const onDuty = run.dutyState.status === 'confirmed' || run.dutyState.status === 'inferred'
    const manifest = run.reserved
      ? this.#manifests.get(run.duty.serviceId, run.duty.travelDate, at)
      : null
    return {
      status: run.dutyState.status,
      confidence: run.dutyState.confidence,
      // §10.1, criterion 94: `corridor` and `route` are both present and
      // exactly one is non-null. A corridor is not a GTFS route - it has no
      // `route_short_name` a rider reads off a destination board, and
      // inventing one would put a fabricated route number on a screen.
      route: null,
      corridor: onDuty ? corridorRef(run.corridor) : null,
      headsign: onDuty ? run.duty.headsign : null,
      directionId: onDuty ? 0 : null,
      service: onDuty
        ? { id: run.duty.serviceId, number: run.duty.number, headsign: run.duty.headsign }
        : null,
      serviceDate: run.duty.serviceDate,
      reservation: run.reserved
        ? {
            required: true,
            ...(manifest === null ? {} : { manifest: publishManifest(manifest, at) }),
          }
        : null,
      trip: onDuty
        ? {
            id: run.duty.id,
            startTime: run.duty.startTime,
            startDate: run.duty.serviceDate,
            startedAt: run.duty.departureAt.toISOString(),
            scheduledEndAt: run.duty.scheduledArrivalAt.toISOString(),
          }
        : null,
      since: onDuty ? run.duty.departureAt.toISOString() : null,
      source:
        run.dutyState.status === 'confirmed'
          ? 'roster'
          : run.dutyState.status === 'inferred'
            ? 'position_match'
            : 'none',
      alternatives: [],
      reason: run.dutyState.reason,
      progressLog: [...run.log],
    }
  }

  private vehicleRef(bin: string, duty: CoachDuty): Record<string, unknown> {
    const serviceClass = this.serviceClass(duty.serviceClassId)
    const hub = fixtureHub(bin.slice(0, 3))
    const corporation = (hub?.corporation ?? duty.corporation) as Corporation
    return {
      bin,
      corporation: {
        code: corporation,
        name: CORPORATION_NAMES[corporation] ?? corporation,
        // §1.1: a fact about the simulation, never an operator disclosure.
        simulated: true,
      },
      serviceClass:
        serviceClass === null
          ? null
          : { id: serviceClass.id, name: serviceClass.name, reserved: serviceClass.reserved },
    }
  }

  private dutyForManifest(serviceId: string, travelDate: string): CoachDuty | null {
    return (
      this.#duties.find(
        (duty) => duty.serviceId === serviceId && duty.travelDate === travelDate,
      ) ?? null
    )
  }

  private corridorOf(duty: CoachDuty): Corridor {
    const corridor = this.#corridors.find((candidate) => candidate.id === duty.corridorId)
    if (corridor === undefined) throw new Error(`Duty ${duty.id} names missing corridor ${duty.corridorId}`)
    if (duty.direction !== 'reverse') return corridor
    let reversed = this.#reverseCorridors.get(corridor.id)
    if (reversed === undefined) {
      reversed = reverseCorridor(corridor)
      this.#reverseCorridors.set(corridor.id, reversed)
    }
    return reversed
  }

  serviceClass(id: string): ServiceClass | null {
    return this.#serviceClasses.find((serviceClass) => serviceClass.id === id) ?? null
  }

  /** Read-only views the feed builder and the tests need. */
  get duties(): readonly CoachDuty[] {
    return this.#duties
  }

  assignmentFor(dutyId: string): Assignment | null {
    return this.#assignments.get(dutyId) ?? null
  }

  activeDuties(at: Date): readonly CoachDuty[] {
    return activeAt(this.#duties, at)
  }

  runSnapshot(duty: CoachDuty, at: Date): {
    readonly cursor: CoachCursor
    readonly corridor: Corridor
    readonly bin: string
    readonly reserved: boolean
    readonly log: readonly ProgressLogEntry[]
    readonly insideDeadZone: boolean
  } {
    const run = this.runAt(duty, at)
    return {
      cursor: run.cursor,
      corridor: run.corridor,
      bin: run.bin,
      reserved: run.reserved,
      log: run.log,
      insideDeadZone: deadZoneAt(run.cursor.distanceMetres, run.corridor.deadZones) !== null,
    }
  }

  coverageShareForClass(id: string): number {
    return coverageShareFor(this.#profiles.device, this.serviceClass(id)?.reserved ?? false)
  }
}

export function corridorRef(corridor: Corridor) {
  return { id: corridor.id, name: corridor.name, nameLocal: corridor.nameLocal }
}

