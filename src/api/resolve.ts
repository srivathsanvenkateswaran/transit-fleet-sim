import { config } from '../config.js'
import { classifyCode } from '../fleet/classify.js'
import { CORPORATION_NAMES, fixtureHub } from '../fleet/corporation.js'
import type { FleetRegistry, FleetVehicle } from '../fleet/registry.js'
import { serviceClassById } from '../fleet/serviceClass.js'
import type { WorldPort } from '../world/port.js'
import { errors, type ApiErrorBody } from './errors.js'
import { currentPlate, observationFor, projectTracking } from './project.js'

/** §10.1: the full class row, including the `capacitySource` §2.2 insists on. */
function serviceClassBody(id: string | null | undefined) {
  if (id == null) return null
  const serviceClass = serviceClassById(id)
  if (serviceClass === null) return null
  return {
    id: serviceClass.id,
    name: serviceClass.name,
    reserved: serviceClass.reserved,
    ac: serviceClass.ac,
    layout: serviceClass.layout,
    berths: serviceClass.berths,
    capacity: serviceClass.capacity,
    capacitySource: serviceClass.capacitySource,
  }
}

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
  // docs/intercity-coaches.md §10.1: "Departure time is on the list and route
  // number is not, because at a stand at 22:00 the destination board and the
  // departure time are what a rider checks, and a corridor has no number to
  // check." A consuming app that renders the array verbatim - which SPEC 6.4
  // already instructs - needs no release to show this.
  const corridor = observation.duty.corridor ?? null
  if (corridor !== null && observation.duty.headsign !== null) {
    verify.push({ label: 'Destination', value: observation.duty.headsign })
    const startTime = observation.duty.trip?.startTime
    if (startTime !== undefined) {
      verify.push({ label: 'Departure', value: startTime.slice(0, 5) })
    }
  } else if (observation.duty.route !== null) {
    verify.push({ label: 'Route', value: observation.duty.route.number })
  }
  const hub = fixtureHub(vehicle.bin.slice(0, 3))
  return {
    status: 200,
    body: {
      bin: vehicle.bin,
      matchedOn,
      vehicle: {
        class: vehicle.class,
        plate,
        plateAbsentReason: null,
        hub: { code: vehicle.bin.slice(0, 3), name: hub?.division ?? config.busHubName },
        // §1.1/§2.1: the corporation is carried as provenance, disclosed
        // plainly because no existing surface does, and never presented as
        // something a rider can check with their eyes - a KKRTC coach and a
        // KSRTC coach on the shared brand look the same. `simulated: true` is
        // the framing that keeps it a fact about this simulation rather than
        // about Karnataka.
        //
        // Both keys are gated on the vehicle carrying a **service class**,
        // not on its class name: a BMTC bus is generated with
        // `corporation: 'BMTC'` because that is true, and publishing it would
        // still be a new field on an existing response (§14.1, criterion
        // 105). Only a coach carries a service class, so this is the same
        // "reservation is the correct axis, the class is not" move §7.3 makes
        // for occupancy, and it keeps this file outside
        // tests/contract/sourceBoundaries.test.ts's class-comparison regex.
        ...(vehicle.serviceClass == null || vehicle.corporation == null
          ? {}
          : {
              corporation: {
                code: vehicle.corporation,
                name: CORPORATION_NAMES[vehicle.corporation] ?? vehicle.corporation,
                simulated: true,
              },
              serviceClass: serviceClassBody(vehicle.serviceClass),
            }),
      },
      duty: observation.duty,
      tracking: projectTracking(observation.tracking, at, observation.occupancy),
      confirmation: {
        required: entry === 'manual',
        prompt:
          corridor !== null
            ? 'Check the coach in front of you.'
            : observation.duty.route === null
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
