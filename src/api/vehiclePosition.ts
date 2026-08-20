import { normaliseCode } from '../fleet/bin.js'
import type { FleetRegistry } from '../fleet/registry.js'
import type { WorldPort } from '../world/port.js'
import { errors, type ApiErrorBody } from './errors.js'
import { observationFor, projectTracking } from './project.js'

export type VehiclePositionResult =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 404; readonly body: ApiErrorBody }

export function vehiclePosition(
  requestedBin: string,
  world: WorldPort,
  registry: FleetRegistry,
  predictionHorizonStops: number,
): VehiclePositionResult {
  const at = world.now()
  const vehicle = registry.findByBinUnchecked(requestedBin)
  if (vehicle === null) {
    return { status: 404, body: errors.unknownBin(normaliseCode(requestedBin)) }
  }
  const observation = observationFor(world, vehicle, at)
  const predictions = world.predictNextStops(vehicle.bin, at, predictionHorizonStops)
  return {
    status: 200,
    body: {
      bin: vehicle.bin,
      class: vehicle.class,
      tracking: projectTracking(observation.tracking, at),
      duty: {
        status: observation.duty.status,
        route:
          observation.duty.route === null
            ? null
            : { id: observation.duty.route.id, number: observation.duty.route.number },
        trip: observation.duty.trip === null ? null : { id: observation.duty.trip.id },
      },
      nextStops: predictions.map((prediction) => ({
        ...prediction.stop,
        eta: {
          seconds: prediction.seconds,
          uncertaintySeconds: prediction.uncertaintySeconds,
        },
      })),
      meta: {
        simulated: true,
        seed: world.status(at).seed,
        generatedAt: at.toISOString(),
        overridden: observation.overridden,
      },
    },
  }
}
