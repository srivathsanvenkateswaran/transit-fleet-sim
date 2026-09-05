import { config } from '../config.js'
import type { FleetRegistry, FleetVehicle } from '../fleet/registry.js'
import { serviceClassById } from '../fleet/serviceClass.js'
import type { OccupancyStatus, VehicleClass, WorldPort } from '../world/port.js'
import { ProtobufWriter } from './protobuf.js'

/**
 * GTFS-Realtime for a long-distance trip - docs/intercity-coaches.md §10.8.
 *
 * Both feeds carry coaches alongside buses in one `FeedMessage`, for the
 * reason SPEC 7.2 already gives: splitting them would model the simulator's
 * internals rather than the domain. `?class=coach` is supported as the same
 * convenience `?class=bus` already is, and a consumer polling at midday sees
 * a nearly empty coach section beside a full bus section, which is what a
 * state network actually looks like at midday. That is correct and is
 * deliberately not padded.
 *
 * **Scope note, stated rather than implied.** `docs/acceptance-audit.md`
 * marks SPEC criteria 30-39 `NOT MET` and records that the protobuf work was
 * ordered after metro; §18 says stage 9 "cannot start until SPEC.md's own
 * stage 7 has landed". Stage 9 has no host without those feeds, so they are
 * built here - bus entities included, because a coach-only feed would be the
 * split §10.8 rules out. What is genuinely still absent is **metro
 * entities**: `MetroSimulation` models a headway table and station arrivals,
 * not per-train vehicles, and no metro vehicle exists in the registry to
 * carry a BIN. So criterion 99's bus and coach thirds are asserted and its
 * metro third is not reachable from this build; the audit records that rather
 * than an entity being invented to satisfy a test.
 */

export type FeedKind = 'vehicle-positions' | 'trip-updates'

/** GTFS-Realtime `VehicleStopStatus`. */
const STOP_STATUS = { INCOMING_AT: 0, STOPPED_AT: 1, IN_TRANSIT_TO: 2 } as const
/** GTFS-Realtime `StopTimeUpdate.ScheduleRelationship`. */
const SCHEDULE_RELATIONSHIP = { SCHEDULED: 0, SKIPPED: 1, NO_DATA: 2, UNSCHEDULED: 3 } as const
const OCCUPANCY_STATUS: Readonly<Record<OccupancyStatus, number>> = {
  EMPTY: 0,
  MANY_SEATS_AVAILABLE: 1,
  FEW_SEATS_AVAILABLE: 2,
  STANDING_ROOM_ONLY: 3,
  CRUSHED_STANDING_ROOM_ONLY: 4,
  FULL: 5,
  NOT_ACCEPTING_PASSENGERS: 6,
  NO_DATA_AVAILABLE: 7,
}

export interface FeedTripDescriptor {
  readonly tripId: string
  readonly routeId: string | null
  readonly startTime: string
  readonly startDate: string
  readonly directionId: number | null
}

/**
 * §10.8: "`VehicleDescriptor` uses all three fields for a coach, which
 * nothing else does."
 *
 * | Field | Bus | Metro | Coach |
 * | `id` | BIN | BIN | BIN |
 * | `license_plate` | Current plate | Omitted | Current plate |
 * | `label` | Omitted | Line and destination | Class, corridor and departure |
 *
 * A bus's label would duplicate the route number painted on its destination
 * board, so it is omitted. A coach's label is not a duplicate: it is what the
 * board says and what the announcement calls out, and at a dark stand it is
 * the string a rider is scanning forty parked coaches for.
 */
export interface FeedVehicleDescriptor {
  readonly id: string
  readonly licensePlate: string | null
  readonly label: string | null
}

export interface FeedStopTimeUpdate {
  readonly stopSequence: number
  readonly stopId: string
  readonly arrivalTime: number | null
  readonly uncertaintySeconds: number | null
  readonly scheduleRelationship: 'SCHEDULED' | 'NO_DATA'
}

export interface FeedEntity {
  readonly id: string
  readonly class: VehicleClass
  readonly trip: FeedTripDescriptor
  readonly vehicle: FeedVehicleDescriptor
  readonly position: {
    readonly lat: number
    readonly lon: number
    readonly bearing: number
    readonly speedKph: number
  } | null
  readonly currentStopSequence: number | null
  readonly stopId: string | null
  readonly currentStatus: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO' | null
  /** The measurement instant, never the serve instant. Criterion 32. */
  readonly timestampSeconds: number | null
  /**
   * §10.8/§7.2: absent - not `NO_DATA_AVAILABLE` - for a reserved coach,
   * unconditionally, manifest or no manifest. `NO_DATA_AVAILABLE` would
   * assert an on-vehicle counting capability that does not exist, and a
   * manifest is a count of bookings through one sales channel, which this
   * enum has no honest slot for.
   */
  readonly occupancyStatus: OccupancyStatus | null
  readonly stopTimeUpdates: readonly FeedStopTimeUpdate[]
  readonly hasTripUpdate: boolean
  readonly hasVehiclePosition: boolean
}

export interface FeedResult {
  readonly status: number
  readonly payload: Buffer
  readonly contentType: string
}

/**
 * The entity model, built once and shared by both feeds.
 *
 * `class` filtering happens here so the two feeds cannot disagree about which
 * vehicles exist.
 */
export function buildFeedEntities(
  world: WorldPort,
  registry: FleetRegistry,
  at: Date,
  classFilter: string | null,
): readonly FeedEntity[] {
  const entities: FeedEntity[] = []
  for (const vehicle of registry.vehicles) {
    if (classFilter !== null && vehicle.class !== classFilter) continue
    const observation = world.observe(vehicle.bin, at)
    if (observation === null) continue
    const duty = observation.duty
    const tracking = observation.tracking
    const onDuty = duty.status === 'confirmed' || duty.status === 'inferred'
    if (!onDuty || duty.trip === null) continue

    const updates = world.scheduleUpdates?.(vehicle.bin, at) ?? []
    const corridor = duty.corridor ?? null
    const plate = vehicle.plates.find((period) => period.until === null) ?? null
    const observedSeconds =
      tracking.observedAt === null ? null : Math.floor(new Date(tracking.observedAt).getTime() / 1_000)

    // SPEC 7.3 rules 3 and 4, and docs/intercity-coaches.md §10.8's one
    // narrowing of rule 4, are all decided in the world - `SimWorld` for a
    // bus, `CoachSimulation` for a coach - and arrive here already resolved:
    // a null `seconds` is a stop this service will not predict, and it
    // becomes `NO_DATA` with no `arrival` and no `departure`, exactly as the
    // specification requires. There is no second copy of the rule in this
    // file to drift from the first.
    const stopTimeUpdates: FeedStopTimeUpdate[] = updates.map((update) => ({
      stopSequence: update.stop.sequence,
      stopId: update.stop.id,
      arrivalTime:
        update.seconds === null ? null : Math.floor(at.getTime() / 1_000) + update.seconds,
      uncertaintySeconds: update.uncertaintySeconds,
      scheduleRelationship: update.seconds === null ? ('NO_DATA' as const) : ('SCHEDULED' as const),
    }))
    const anyPredicted = stopTimeUpdates.some((update) => update.scheduleRelationship === 'SCHEDULED')

    entities.push({
      id: vehicle.bin,
      class: vehicle.class,
      trip: {
        tripId: duty.trip.id,
        routeId: duty.route?.id ?? corridor?.id ?? null,
        // §10.8/§3.3: the GTFS *service* date, and a noon-relative start time
        // that may exceed 24:00:00. On the realtime side there is no
        // ambiguity at all, because `StopTimeEvent.time` is a POSIX instant,
        // so the whole difficulty lives in the static feed a consumer must
        // already hold.
        startTime: duty.trip.startTime,
        startDate: duty.trip.startDate,
        directionId: duty.directionId,
      },
      vehicle: {
        id: vehicle.bin,
        licensePlate: plate?.normalised ?? null,
        label: corridor === null ? null : coachLabel(vehicle, corridor.name, duty.trip.startTime),
      },
      position:
        tracking.position === null
          ? null
          : {
              lat: tracking.position.lat,
              lon: tracking.position.lon,
              bearing: tracking.position.bearing,
              speedKph: tracking.position.speedKph,
            },
      currentStopSequence: tracking.progress?.nextStop?.sequence ?? null,
      stopId: tracking.progress?.nextStop?.id ?? null,
      currentStatus: tracking.progress?.currentStatus ?? null,
      timestampSeconds: observedSeconds,
      occupancyStatus: observation.occupancy?.status ?? null,
      stopTimeUpdates,
      // §10.8: "`vehicle-positions` publishes nothing new at all" through a
      // dead zone - but the entity is still there, carrying the last real fix
      // at its true old timestamp. An untracked vehicle has no measurement at
      // all and appears in neither feed (criterion 71).
      hasVehiclePosition: tracking.state !== 'untracked',
      // Rule 4's `TRIP_UPDATES_OMIT_UNTRACKED`, default false: emitting the
      // trip with every stop `NO_DATA` is the better default, because it
      // tells a consumer the trip is running and the timing is unknown, which
      // is more than silence tells it.
      hasTripUpdate:
        config.publishTripUpdates &&
        stopTimeUpdates.length > 0 &&
        (anyPredicted || !config.tripUpdatesOmitUntracked),
    })
  }
  return entities
}

/** `KSRTC Pallakki · Bengaluru - Hosapete - Hampi · 22:59` */
function coachLabel(vehicle: FleetVehicle, corridorName: string, startTime: string): string {
  const corporation = vehicle.corporation ?? null
  const serviceClass = vehicle.serviceClass == null ? null : serviceClassById(vehicle.serviceClass)
  const parts = [
    [corporation, serviceClass?.name].filter(Boolean).join(' '),
    corridorName,
    startTime.slice(0, 5),
  ].filter((part) => part !== '')
  return parts.join(' · ')
}

/**
 * §14.1: with coaches off, a `?class=coach` request is not an error - the
 * filter simply matches nothing, exactly as `?class=metro` does today. So
 * this takes no intercity port: the feed is built from the registry and the
 * world, and a fleet with no coaches in it produces a feed with no coaches
 * in it, without a branch.
 */
export function gtfsRealtimeFeed(
  kind: FeedKind,
  world: WorldPort,
  registry: FleetRegistry,
  classFilter: string | null,
): FeedResult {
  const at = world.now()
  const entities = buildFeedEntities(world, registry, at, classFilter)
  const writer = new ProtobufWriter()
  writer.message(1, (header) => {
    header.string(1, '2.0')
    header.enumValue(2, 0)
    header.varint(3, Math.floor(at.getTime() / 1_000))
  })
  for (const entity of entities) {
    if (kind === 'vehicle-positions' && !entity.hasVehiclePosition) continue
    if (kind === 'trip-updates' && !entity.hasTripUpdate) continue
    writer.message(2, (feedEntity) => {
      feedEntity.string(1, entity.id)
      if (kind === 'trip-updates') {
        feedEntity.message(3, (tripUpdate) => {
          tripUpdate.message(1, (trip) => writeTrip(trip, entity))
          tripUpdate.message(3, (descriptor) => writeVehicle(descriptor, entity))
          for (const update of entity.stopTimeUpdates) {
            tripUpdate.message(2, (stopTimeUpdate) => {
              stopTimeUpdate.varint(1, update.stopSequence)
              stopTimeUpdate.string(4, update.stopId)
              if (update.scheduleRelationship === 'NO_DATA') {
                stopTimeUpdate.enumValue(5, SCHEDULE_RELATIONSHIP.NO_DATA)
                return
              }
              stopTimeUpdate.message(2, (arrival) => {
                if (update.arrivalTime !== null) arrival.varint(2, update.arrivalTime)
                if (update.uncertaintySeconds !== null) arrival.int32(3, update.uncertaintySeconds)
              })
            })
          }
          if (entity.timestampSeconds !== null) tripUpdate.varint(4, entity.timestampSeconds)
        })
        return
      }
      feedEntity.message(4, (position) => {
        position.message(1, (trip) => writeTrip(trip, entity))
        position.message(8, (descriptor) => writeVehicle(descriptor, entity))
        if (entity.position !== null) {
          position.message(2, (point) => {
            point.float(1, entity.position!.lat)
            point.float(2, entity.position!.lon)
            point.float(3, entity.position!.bearing)
            point.float(5, entity.position!.speedKph / 3.6)
          })
        }
        if (entity.currentStopSequence !== null) position.varint(3, entity.currentStopSequence)
        if (entity.currentStatus !== null) position.enumValue(4, STOP_STATUS[entity.currentStatus])
        // Criterion 32: the measurement instant, never backdated or
        // forward-dated to look fresher than it is. Through a dead zone this
        // is genuinely older than INTERCITY_DARK_AFTER_SECONDS and stays so.
        if (entity.timestampSeconds !== null) position.varint(5, entity.timestampSeconds)
        if (entity.stopId !== null) position.string(7, entity.stopId)
        if (entity.occupancyStatus !== null) {
          position.enumValue(9, OCCUPANCY_STATUS[entity.occupancyStatus])
        }
      })
    })
  }
  return {
    status: 200,
    payload: Buffer.from(writer.finish()),
    contentType: 'application/x-protobuf',
  }
}

function writeTrip(writer: ProtobufWriter, entity: FeedEntity): void {
  writer.string(1, entity.trip.tripId)
  writer.string(2, entity.trip.startTime)
  writer.string(3, entity.trip.startDate)
  if (entity.trip.routeId !== null) writer.string(5, entity.trip.routeId)
  if (entity.trip.directionId !== null) writer.varint(6, entity.trip.directionId)
}

function writeVehicle(writer: ProtobufWriter, entity: FeedEntity): void {
  writer.string(1, entity.vehicle.id)
  if (entity.vehicle.label !== null) writer.string(2, entity.vehicle.label)
  if (entity.vehicle.licensePlate !== null) writer.string(3, entity.vehicle.licensePlate)
}

