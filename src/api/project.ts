import type { FleetRegistry, FleetVehicle } from '../fleet/registry.js'
import type {
  DutyObservation,
  TrackingObservation,
  VehicleObservation,
  WorldPort,
} from '../world/port.js'

const trackingSourceByClass = {
  bus: 'simulated_gnss',
  metro: 'simulated_signalling',
} as const

export function observationFor(
  world: WorldPort,
  vehicle: FleetVehicle,
  at: Date,
): VehicleObservation {
  return world.observe(vehicle.bin, at) ?? missingWorldObservation(vehicle, at)
}

export function projectTracking(tracking: TrackingObservation, servedAt: Date) {
  return {
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
