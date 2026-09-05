import type { FleetRegistry, FleetVehicle } from '../fleet/registry.js'
import type {
  DutyObservation,
  OccupancyObservation,
  TrackingObservation,
  VehicleObservation,
  WorldPort,
} from '../world/port.js'

const trackingSourceByClass = {
  bus: 'simulated_gnss',
  metro: 'simulated_signalling',
  // A coach's AIS-140 device is the same kind of GNSS unit a bus carries
  // (docs/intercity-coaches.md §4.3) - this is a lookup table keyed on the
  // fact, not a `.class === 'coach'` branch, so it stays outside the
  // three-file vehicle-class boundary in tests/contract/sourceBoundaries.test.ts.
  coach: 'simulated_gnss',
} as const

export function observationFor(
  world: WorldPort,
  vehicle: FleetVehicle,
  at: Date,
): VehicleObservation {
  return world.observe(vehicle.bin, at) ?? missingWorldObservation(vehicle, at)
}

/**
 * The wire shape of `tracking`, including how full the vehicle is.
 *
 * `occupancy` sits beside `tracking` on a `VehicleObservation` rather than
 * inside it, so it has to be passed in explicitly - which is exactly how it
 * came to be simulated for every vehicle and then dropped for buses. The metro
 * arrivals endpoint shapes its own payload and carried it; this projection is
 * the only other way a vehicle reaches a consumer, and it did not.
 *
 * Undefined stays undefined. A vehicle that is dark or untracked already gets
 * `NO_DATA_AVAILABLE` with no percentage from `occupancyFor`, and that
 * distinction is load-bearing downstream: an empty bus is a fact about a bus,
 * no data is a fact about the feed, and a consumer that renders them alike is
 * inventing a measurement. Never substitute a zero here.
 */
export function projectTracking(
  tracking: TrackingObservation,
  servedAt: Date,
  occupancy?: OccupancyObservation,
) {
  return {
    ...(occupancy === undefined ? {} : { occupancy }),
    state: tracking.state,
    fixAgeSeconds:
      tracking.observedAt === null
        ? null
        : Math.max(0, Math.floor((servedAt.getTime() - new Date(tracking.observedAt).getTime()) / 1000)),
    observedAt: tracking.observedAt,
    servedAt: servedAt.toISOString(),
    position: tracking.position,
    progress: tracking.state === 'live' ? tracking.progress : null,
    source: tracking.source,
    reason: tracking.reason,
    recoveredFromDropout: tracking.recoveredFromDropout,
  }
}

export function currentPlate(registry: FleetRegistry, vehicle: FleetVehicle) {
  const plate = registry.currentPlate(vehicle)
  return { display: plate.display, normalised: plate.normalised, since: plate.since }
}

function missingWorldObservation(vehicle: FleetVehicle, at: Date): VehicleObservation {
  const duty: DutyObservation = {
    status: 'unknown',
    confidence: null,
    route: null,
    headsign: null,
    directionId: null,
    trip: null,
    since: null,
    source: 'none',
    alternatives: [],
    reason: 'off_pattern',
  }
  return {
    bin: vehicle.bin,
    class: vehicle.class,
    duty,
    tracking: {
      state: 'untracked',
      observedAt: null,
      position: null,
      progress: null,
      source: trackingSourceByClass[vehicle.class],
      reason: 'no_device_fitted',
      recoveredFromDropout: false,
    },
    overridden: false,
  }
}
