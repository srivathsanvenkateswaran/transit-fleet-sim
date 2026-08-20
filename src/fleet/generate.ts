import { config } from '../config.js'
import { randInt } from '../sim/rand.js'
import { formatBin } from './bin.js'
import { parsePlate } from './plate.js'
import type { FleetVehicle, PlatePeriod } from './registry.js'

export interface GenerateFleetOptions {
  readonly seed?: number
  readonly routes?: readonly string[]
  readonly busesPerRoute?: number
  readonly hub?: string
}

export function generateFleet(options: GenerateFleetOptions = {}): readonly FleetVehicle[] {
  const seed = options.seed ?? config.simSeed
  const routes = options.routes ?? config.busRoutes
  const busesPerRoute = options.busesPerRoute ?? config.busesPerRoute
  const hub = options.hub ?? config.busHubCode
  const usedPlates = new Set<string>()
  const vehicles: FleetVehicle[] = []
  let serial = 412
  for (const route of routes) {
    for (let index = 0; index < busesPerRoute; index += 1) {
      const bin = formatBin(hub, serial)
      const plate = generateUniquePlate(seed, bin, usedPlates)
      vehicles.push({
        bin,
        class: 'bus',
        homeRouteNumber: route,
        plates: [
          {
            ...plate,
            since: '2026-02-14',
            until: null,
            reason: 'original_registration',
          },
        ],
      })
      serial += 1
    }
  }
  return vehicles
}

function generateUniquePlate(
  seed: number,
  bin: string,
  used: Set<string>,
): Pick<PlatePeriod, 'normalised' | 'display'> {
  const districts = ['01', '41', '50'] as const
  const district = districts[randInt(seed, bin, 'plate_district', 0, 0, districts.length)] ?? '01'
  let serial = randInt(seed, bin, 'plate_serial', 0, 1, 10_000)
  let normalised = `KA${district}ZZ${String(serial).padStart(4, '0')}`
  while (used.has(normalised)) {
    serial = (serial % 9_999) + 1
    normalised = `KA${district}ZZ${String(serial).padStart(4, '0')}`
  }
  used.add(normalised)
  const parsed = parsePlate(normalised)
  if (parsed === null) throw new Error(`Generated invalid plate ${normalised}`)
  return parsed
}
