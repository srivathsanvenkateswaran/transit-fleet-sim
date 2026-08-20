import { config } from '../config.js'
import { classifyCode } from '../fleet/classify.js'
import type { FleetRegistry, FleetVehicle } from '../fleet/registry.js'
import type { WorldPort } from '../world/port.js'
import { errors, type ApiErrorBody } from './errors.js'
import { currentPlate, observationFor, projectTracking } from './project.js'

export type ResolveResult =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 404 | 422; readonly body: ApiErrorBody }

export interface ResolveQuery {
  readonly code: string | null
  readonly entry: string | null
  readonly at: string | null
}

export function resolveVehicle(
  query: ResolveQuery,
  world: WorldPort,
  registry: FleetRegistry,
): ResolveResult {
  if (query.code === null || query.code.length < 1 || query.code.length > 32) {
    return { status: 400, body: errors.malformedCode(query.code ?? '') }
  }
  const entry = query.entry ?? 'manual'
  if (entry !== 'manual' && entry !== 'scan') {
    return { status: 400, body: errors.invalidRequest('entry must be scan or manual.') }
  }
  let at = world.now()
  if (query.at !== null) {
    if (!config.simAllowTimeTravel) return { status: 400, body: errors.timeTravelDisabled() }
    at = new Date(query.at)
    if (!Number.isFinite(at.getTime())) {
      return { status: 400, body: errors.invalidRequest('at must be an RFC 3339 instant.') }
    }
  }

  const classified = classifyCode(query.code, registry.hubs)
  if (classified.kind === 'malformed') {
    return { status: 400, body: errors.malformedCode(query.code) }
  }
  if (classified.kind === 'bad_check_character') {
    return { status: 400, body: errors.badCheckCharacter(query.code) }
  }

  let vehicle: FleetVehicle
  let matchedOn: 'bin' | 'plate'
  if (classified.kind === 'bin') {
    const found = registry.findByBin(classified.value.canonical)
    if (found === null) {
      return { status: 404, body: errors.unknownBin(classified.value.normalised) }
    }
    vehicle = found
    matchedOn = 'bin'
  } else {
    const found = registry.findByPlate(classified.value.normalised)
    if (found.kind === 'not_found') {
      return { status: 404, body: errors.unknownPlate(classified.value.normalised) }
    }
    if (found.kind === 'retired') {
      return { status: 404, body: errors.retiredPlate(found.plate.until!) }
    }
    vehicle = found.vehicle
    matchedOn = 'plate'
  }

  if (vehicle.plates.length === 0) return { status: 422, body: errors.notResolvable() }
  const observation = observationFor(world, vehicle, at)
  const plate = currentPlate(registry, vehicle)
  const verify = [{ label: 'Number plate', value: plate.display }]
  if (observation.duty.route !== null) {
    verify.push({ label: 'Route', value: observation.duty.route.number })
  }
  return {
    status: 200,
    body: {
      bin: vehicle.bin,
      matchedOn,
      vehicle: {
        class: vehicle.class,
        plate,
        plateAbsentReason: null,
        hub: { code: vehicle.bin.slice(0, 3), name: config.busHubName },
      },
      duty: observation.duty,
      tracking: projectTracking(observation.tracking, at),
      confirmation: {
        required: entry === 'manual',
        prompt:
          observation.duty.route === null
            ? 'Check the number plate. The route is not currently known.'
            : 'Check the bus in front of you.',
        verify,
      },
      meta: {
        simulated: true,
        seed: world.status(at).seed,
        generatedAt: at.toISOString(),
        overridden: observation.overridden,
      },
    },
  }
}
