import { describe, expect, it } from 'vitest'
import { buildFeedEntities, gtfsRealtimeFeed } from '../../src/api/gtfsRealtime.js'
import { FleetRegistry } from '../../src/fleet/registry.js'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import { deadZoneAt } from '../../src/sim/intercityDevice.js'
import { binFor, coachHarness, coachWorldPort, pallakkiDuty } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §10.8: GTFS-Realtime for a long-distance trip.
 *
 * The asymmetry these tests exist to pin is the one §10.8 states and §7.3
 * already drew: **a position is a measurement and a prediction is an
 * opinion.** A measurement nobody took cannot be manufactured, so
 * `vehicle-positions` publishes the last real fix at its true unfreshened
 * age. An opinion can honestly be widened and kept, so `trip-updates` keeps
 * predicting through a dead zone with the band multiplied.
 *
 * Both halves are asserted together, in one test, precisely so the split
 * cannot slide into loosening both claims: a change that started freshening
 * the position to match the prediction fails here.
 */

const NOW = new Date('2026-09-06T02:14:00+05:30')
const FULL_COVERAGE = {
  ...defaultCoachProfiles.device,
  coverageShareReserved: 1,
  coverageShareOrdinary: 1,
}

async function harness(at: Date = NOW) {
  const { simulation, coaches } = await coachHarness(at, { device: FULL_COVERAGE })
  return { simulation, registry: new FleetRegistry(coaches), world: coachWorldPort(simulation, at) }
}

describe('GTFS-Realtime for a coach (§10.8)', () => {
  it('criterion 99: a coach entity carries both license_plate and label; a bus carries a plate and no label', async () => {
    const { simulation, registry, world } = await harness()
    const entities = buildFeedEntities(world, registry, NOW, 'coach')
    expect(entities.length).toBeGreaterThan(0)
    for (const entity of entities) {
      expect(entity.vehicle.id).toBe(entity.id)
      expect(entity.vehicle.licensePlate).toMatch(/^KA\d{2}ZZ\d{4}$/)
      // "A bus's label would duplicate the route number painted on its
      // destination board... A coach's label is not a duplicate: it is what
      // the destination board says and what the announcement calls out, and
      // at a dark stand it is the string a rider is scanning forty parked
      // coaches for."
      expect(entity.vehicle.label).not.toBeNull()
      expect(entity.vehicle.label).toMatch(/^KSRTC .+ · Bengaluru - Hosapete - Hampi · \d{2}:\d{2}$/)
    }
    const duty = pallakkiDuty(simulation, '20260905')
    const coach = entities.find((entity) => entity.id === binFor(simulation, duty.id))!
    expect(coach.vehicle.label).toBe('KSRTC Pallakki · Bengaluru - Hosapete - Hampi · 22:59')
  })

  it('criterion 101: a trip crossing midnight carries its service date and a start time past 24:00:00 in the static join', async () => {
    const { simulation, registry, world } = await harness()
    const duty = pallakkiDuty(simulation, '20260905')
    const entity = buildFeedEntities(world, registry, NOW, 'coach').find(
      (candidate) => candidate.id === binFor(simulation, duty.id),
    )!
    // The calendar has turned over and the service date has not.
    expect(entity.trip.startDate).toBe('20260905')
    expect(entity.trip.startTime).toBe('22:59:00')
    // And the static side genuinely emits times past 24:00:00, which the
    // bundled BMTC feed never does.
    expect(duty.calls.at(-1)!.arrivalTime.startsWith('3')).toBe(true)
    // On the realtime side there is no ambiguity at all, because
    // StopTimeEvent.time is a POSIX instant: joining the two resolves the
    // right moment without a consumer implementing the GTFS time rule.
    const arrival = entity.stopTimeUpdates.find((update) => update.arrivalTime !== null)!
    expect(new Date(arrival.arrivalTime! * 1_000).getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('criterion 100 and the split: through a dead zone the position is unfreshened and the predictions widen', async () => {
    const { simulation, registry } = await harness()
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    const corridor = simulation.runSnapshot(duty, NOW).corridor

    // Find the moment this coach is dark inside an authored zone.
    let darkAt: Date | null = null
    for (let minute = 0; minute <= 600 && darkAt === null; minute += 1) {
      const at = new Date(duty.departureAt.getTime() + minute * 60_000)
      const observation = simulation.observe(bin, at)
      const snapshot = simulation.runSnapshot(duty, at)
      if (
        observation?.tracking.state === 'dark' &&
        deadZoneAt(snapshot.cursor.distanceMetres, corridor.deadZones) !== null
      ) {
        darkAt = at
      }
    }
    expect(darkAt).not.toBeNull()

    const world = coachWorldPort(simulation, darkAt!)
    const entity = buildFeedEntities(world, registry, darkAt!, 'coach').find(
      (candidate) => candidate.id === bin,
    )!

    // Half one: the measurement. The entity is present and its timestamp is
    // the fix's own, genuinely older than INTERCITY_DARK_AFTER_SECONDS. "The
    // feed must not be freshened."
    expect(entity.hasVehiclePosition).toBe(true)
    const ageSeconds = Math.floor(darkAt!.getTime() / 1_000) - entity.timestampSeconds!
    expect(ageSeconds).toBeGreaterThan(defaultCoachProfiles.device.darkAfterSeconds)

    // Half two: the opinion. Predictions keep coming, with the band widened
    // by INTERCITY_DEAD_ZONE_UNCERTAINTY_MULTIPLIER.
    expect(entity.hasTripUpdate).toBe(true)
    const predicted = entity.stopTimeUpdates.filter(
      (update) => update.scheduleRelationship === 'SCHEDULED',
    )
    expect(predicted.length).toBeGreaterThan(0)
    for (const update of predicted) {
      expect(update.uncertaintySeconds).toBeGreaterThan(0)
      expect(update.arrivalTime).not.toBeNull()
    }

    // And the widening is real rather than asserted: the same stand, from a
    // comparable position outside a zone, carries a narrower band.
    const clearAt = new Date(duty.departureAt.getTime() + 30 * 60_000)
    const clearWorld = coachWorldPort(simulation, clearAt)
    const clear = buildFeedEntities(clearWorld, registry, clearAt, 'coach').find(
      (candidate) => candidate.id === bin,
    )!
    const clearStand = clear.stopTimeUpdates.find(
      (update) => update.stopId === predicted[0]!.stopId && update.uncertaintySeconds !== null,
    )
    if (clearStand !== undefined) {
      expect(predicted[0]!.uncertaintySeconds!).toBeGreaterThan(clearStand.uncertaintySeconds!)
    }
  })

  it('criterion 102: occupancy_status is absent, not NO_DATA_AVAILABLE, on every reserved coach entity including one with a full manifest', async () => {
    const { simulation, registry, world } = await harness()
    for (const duty of simulation.duties) {
      if (!(simulation.serviceClass(duty.serviceClassId)?.reserved ?? false)) continue
      simulation.putManifest(
        {
          serviceId: duty.serviceId,
          travelDate: duty.travelDate,
          seats: { total: 30, booked: 30, held: 0, simulated: 0 },
          asOf: new Date(NOW.getTime() - 60_000).toISOString(),
          ttlSeconds: 3_600,
        },
        NOW,
      )
    }
    const entities = buildFeedEntities(world, registry, NOW, 'coach')
    expect(entities.length).toBeGreaterThan(0)
    let reserved = 0
    for (const entity of entities) {
      const duty = simulation
        .activeDuties(NOW)
        .find((candidate) => simulation.assignmentFor(candidate.id)?.bin === entity.id)
      if (duty === undefined) continue
      if (!(simulation.serviceClass(duty.serviceClassId)?.reserved ?? false)) continue
      reserved += 1
      // Not `NO_DATA_AVAILABLE`, which would assert an on-vehicle counting
      // capability that does not exist. And not set from the manifest, which
      // counts bookings through one sales channel and has no honest slot in
      // this enum. The manifest has no GTFS-Realtime representation at all.
      expect(entity.occupancyStatus).toBeNull()
    }
    expect(reserved).toBeGreaterThan(0)
    const encoded = gtfsRealtimeFeed('vehicle-positions', world, registry, 'coach')
    expect(encoded.payload.includes(Buffer.from('bookings_through_this_network_only'))).toBe(false)
  })

  it('criterion 71 in the feed: with coverage at zero no coach entity appears in vehicle-positions', async () => {
    const { simulation, coaches } = await coachHarness(NOW, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 0, coverageShareOrdinary: 0 },
    })
    const registry = new FleetRegistry(coaches)
    const world = coachWorldPort(simulation, NOW)
    const entities = buildFeedEntities(world, registry, NOW, 'coach')
    expect(entities.every((entity) => !entity.hasVehiclePosition)).toBe(true)
    const feed = decode(
      gtfsRealtimeFeed('vehicle-positions', world, registry, 'coach').payload,
    )
    expect(feed.entities.length).toBe(0)
  })

  it('the encoder produces a decodable FeedMessage with the header, entity and descriptor fields in the right places', async () => {
    const { simulation, registry, world } = await harness()
    const result = gtfsRealtimeFeed('vehicle-positions', world, registry, 'coach')
    expect(result.contentType).toBe('application/x-protobuf')
    const feed = decode(result.payload)
    expect(feed.version).toBe('2.0')
    expect(feed.timestamp).toBe(Math.floor(NOW.getTime() / 1_000))
    expect(feed.entities.length).toBeGreaterThan(0)
    const entity = feed.entities[0]!
    expect(entity.id).toMatch(/^KBS-\d{5}$/)
    expect(entity.vehicleId).toBe(entity.id)
    expect(entity.licensePlate).toMatch(/^KA\d{2}ZZ\d{4}$/)
    expect(entity.label).toContain('KSRTC')
    expect(entity.latitude).toBeGreaterThan(12)
    expect(entity.latitude).toBeLessThan(16)
    // GTFS-Realtime's `Position.speed` is metres per second, not km/h.
    expect(entity.speed).toBeLessThan(30)
    expect(entity.timestamp).toBeLessThanOrEqual(feed.timestamp)
  })

  it('a class filter narrows the feed the same way ?class=bus already does', async () => {
    const { simulation, registry, world } = await harness()
    expect(buildFeedEntities(world, registry, NOW, 'coach').length).toBeGreaterThan(0)
    expect(buildFeedEntities(world, registry, NOW, 'bus').length).toBe(0)
    expect(buildFeedEntities(world, registry, NOW, null).length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * A minimal protobuf reader, so the writer is decoded rather than trusted.
 * ------------------------------------------------------------------ */

interface DecodedEntity {
  id: string
  vehicleId: string
  licensePlate: string | null
  label: string | null
  latitude: number
  speed: number
  timestamp: number
}

function decode(buffer: Buffer): {
  version: string
  timestamp: number
  entities: DecodedEntity[]
} {
  let version = ''
  let timestamp = 0
  const entities: DecodedEntity[] = []
  for (const field of fields(buffer)) {
    if (field.number === 1) {
      for (const header of fields(field.bytes!)) {
        if (header.number === 1) version = header.bytes!.toString('utf8')
        if (header.number === 3) timestamp = Number(header.varint)
      }
    }
    if (field.number === 2) {
      const entity: DecodedEntity = {
        id: '',
        vehicleId: '',
        licensePlate: null,
        label: null,
        latitude: 0,
        speed: 0,
        timestamp: 0,
      }
      for (const part of fields(field.bytes!)) {
        if (part.number === 1) entity.id = part.bytes!.toString('utf8')
        if (part.number !== 4) continue
        for (const position of fields(part.bytes!)) {
          if (position.number === 5) entity.timestamp = Number(position.varint)
          if (position.number === 2) {
            for (const point of fields(position.bytes!)) {
              if (point.number === 1) entity.latitude = point.float!
              if (point.number === 5) entity.speed = point.float!
            }
          }
          if (position.number === 8) {
            for (const descriptor of fields(position.bytes!)) {
              if (descriptor.number === 1) entity.vehicleId = descriptor.bytes!.toString('utf8')
              if (descriptor.number === 2) entity.label = descriptor.bytes!.toString('utf8')
              if (descriptor.number === 3) entity.licensePlate = descriptor.bytes!.toString('utf8')
            }
          }
        }
      }
      entities.push(entity)
    }
  }
  return { version, timestamp, entities }
}

function* fields(
  buffer: Buffer,
): Generator<{ number: number; varint?: bigint; bytes?: Buffer; float?: number }> {
  let offset = 0
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset)
    const number = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    offset = afterTag
    if (wireType === 0) {
      const [value, next] = readVarint(buffer, offset)
      offset = next
      yield { number, varint: value }
    } else if (wireType === 2) {
      const [length, next] = readVarint(buffer, offset)
      offset = next + Number(length)
      yield { number, bytes: buffer.subarray(next, offset) }
    } else if (wireType === 5) {
      const value = buffer.readFloatLE(offset)
      offset += 4
      yield { number, float: value }
    } else if (wireType === 1) {
      const value = buffer.readDoubleLE(offset)
      offset += 8
      yield { number, float: value }
    } else {
      throw new Error(`Unsupported wire type ${wireType}`)
    }
  }
}

function readVarint(buffer: Buffer, offset: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let cursor = offset
  for (;;) {
    const byte = buffer[cursor]!
    cursor += 1
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7n
  }
  return [result, cursor]
}

/* ------------------------------------------------------------------ *
 * The bus half of the feeds. SPEC 7.2 and 7.3, which stage 9 needed to
 * exist before it could add coaches to them.
 * ------------------------------------------------------------------ */

describe('GTFS-Realtime for a bus (SPEC 7.2, 7.3)', () => {
  const START = new Date('2026-08-20T03:00:00Z')

  class FixedClock {
    constructor(private readonly value: Date) {}
    now(): Date {
      return new Date(this.value)
    }
  }

  async function busWorld(coverageShare: number) {
    const { loadGtfs } = await import('../../src/geometry/loadGtfs.js')
    const { generateFleet } = await import('../../src/fleet/generate.js')
    const { SimWorld } = await import('../../src/sim/world.js')
    const { defaultBusDeviceProfile } = await import('../../src/sim/device.js')
    const { defaultBusDutyProfile } = await import('../../src/sim/duty.js')
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 3, routes: ['G-4'], busesPerRoute: 4 })
    const world = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(START),
      deviceProfile: { ...defaultBusDeviceProfile, seed: 3, coverageShare },
      // Every bus on a known duty, so the feed has something to publish and
      // the assertions are about the feed rules rather than about the roster.
      dutyProfile: {
        ...defaultBusDutyProfile,
        confirmedShare: 1,
        inferredShare: 0,
        unknownShare: 0,
        outOfServiceShare: 0,
      },
    })
    for (const seconds of [1, 30, 90]) world.tickAt(new Date(START.getTime() + seconds * 1_000))
    return { world, registry: new FleetRegistry(fleet), at: new Date(START.getTime() + 90_000) }
  }

  it('criterion 34: a bus entity carries a plate and no label', async () => {
    const { world, registry, at } = await busWorld(1)
    const entities = buildFeedEntities(world, registry, at, 'bus')
    expect(entities.length).toBeGreaterThan(0)
    for (const entity of entities) {
      expect(entity.vehicle.licensePlate).toMatch(/^KA\d{2}ZZ\d{4}$/)
      // A bus's label would duplicate the route number painted on its
      // destination board, so SPEC omits it.
      expect(entity.vehicle.label).toBeNull()
    }
  })

  it('criteria 35 and 37: every emitted band is non-zero, and stops beyond the horizon are NO_DATA with no arrival', async () => {
    const { world, registry, at } = await busWorld(1)
    const entities = buildFeedEntities(world, registry, at, 'bus')
    let scheduled = 0
    let blanked = 0
    for (const entity of entities) {
      for (const update of entity.stopTimeUpdates) {
        if (update.scheduleRelationship === 'SCHEDULED') {
          scheduled += 1
          expect(update.uncertaintySeconds).toBeGreaterThan(0)
          expect(update.arrivalTime).not.toBeNull()
        } else {
          blanked += 1
          expect(update.arrivalTime).toBeNull()
          expect(update.uncertaintySeconds).toBeNull()
        }
      }
    }
    expect(scheduled).toBeGreaterThan(0)
    // A G-4 trip has far more than PREDICTION_HORIZON_STOPS stops, so the
    // NO_DATA arm is genuinely exercised rather than merely available.
    expect(blanked).toBeGreaterThan(0)
  })

  it('criterion 38: a dark bus emits its trip with every stop NO_DATA, and omitting it is a configured choice', async () => {
    // "A dark city bus is genuinely unlocatable: stopped at a junction,
    // diverted, or three kilometres on, with no bound on any of it." So it
    // predicts nothing at all - which is the rule docs/intercity-coaches.md
    // §10.8 narrows for a coach in an authored dead zone, and nowhere else.
    const { loadGtfs } = await import('../../src/geometry/loadGtfs.js')
    const { generateFleet } = await import('../../src/fleet/generate.js')
    const { SimWorld } = await import('../../src/sim/world.js')
    const { defaultBusDeviceProfile } = await import('../../src/sim/device.js')
    const { defaultBusDutyProfile } = await import('../../src/sim/duty.js')
    const gtfs = await loadGtfs()
    const fleet = generateFleet({ seed: 3, routes: ['G-4'], busesPerRoute: 4 })
    const world = new SimWorld(gtfs, fleet, {
      clock: new FixedClock(START),
      deviceProfile: {
        ...defaultBusDeviceProfile,
        seed: 3,
        coverageShare: 1,
        // A dropout that starts immediately and lasts past the dark
        // threshold, so every bus is dark rather than waiting for one.
        dropoutRatePerHour: 6_000,
        dropoutMinSeconds: 3_600,
        dropoutMaxSeconds: 3_600,
      },
      dutyProfile: {
        ...defaultBusDutyProfile,
        confirmedShare: 1,
        inferredShare: 0,
        unknownShare: 0,
        outOfServiceShare: 0,
      },
    })
    for (const seconds of [1, 60, 400]) world.tickAt(new Date(START.getTime() + seconds * 1_000))
    const at = new Date(START.getTime() + 400_000)
    const registry = new FleetRegistry(fleet)
    const dark = buildFeedEntities(world, registry, at, 'bus').filter(
      (entity) => entity.stopTimeUpdates.length > 0,
    )
    expect(dark.length).toBeGreaterThan(0)
    for (const entity of dark) {
      expect(
        entity.stopTimeUpdates.every((update) => update.scheduleRelationship === 'NO_DATA'),
      ).toBe(true)
      // Emitting the trip with NO_DATA is the better default, because it
      // tells a consumer the trip is running and the timing is unknown -
      // which is more than silence tells it.
      expect(entity.hasTripUpdate).toBe(true)
    }
  })

  it('criterion 31: an untracked bus is absent from vehicle-positions entirely', async () => {
    const { world, registry, at } = await busWorld(0)
    const entities = buildFeedEntities(world, registry, at, 'bus')
    expect(entities.every((entity) => !entity.hasVehiclePosition)).toBe(true)
    // "There is no GTFS-Realtime way to say 'this vehicle exists and has no
    // device', and inventing one would be worse than the truth."
    const feed = decode(
      gtfsRealtimeFeed('vehicle-positions', world, registry, 'bus').payload,
    )
    expect(feed.entities.length).toBe(0)
  })
})
