import { config } from '../config.js'
import { randInt } from '../sim/rand.js'
import { formatBin } from './bin.js'
import { DISTRICT_CODE_BY_CORPORATION, type Corporation } from './corporation.js'
import { parsePlate } from './plate.js'
import type { FleetVehicle, PlatePeriod } from './registry.js'
import type { ServiceClassId } from './serviceClass.js'

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
        corporation: 'BMTC',
        serviceClass: null,
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

const BMTC_DISTRICTS = ['01', '41', '50'] as const

function generateUniquePlate(
  seed: number,
  bin: string,
  used: Set<string>,
  districts: readonly string[] = BMTC_DISTRICTS,
): Pick<PlatePeriod, 'normalised' | 'display'> {
  const district = districts[randInt(seed, bin, 'plate_district', 0, 0, districts.length)] ?? districts[0]
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

/**
 * One roster slot: a division hub, the corporation that runs it, a service
 * class that corporation runs, and how many coaches to stand up against it.
 * `generateCoachFleet` does not know about corridors or duties - it is the
 * same job `generateFleet` does for buses, extended with the two identity
 * facts §2.2 adds, and the roster (`src/sim/roster.ts`) is what decides how
 * many coaches a corridor actually needs.
 */
export interface CoachRosterSlot {
  readonly hub: string
  readonly corporation: Corporation
  readonly serviceClassId: ServiceClassId
  readonly homeCorridorId: string
  readonly count: number
}

export interface GenerateCoachFleetOptions {
  readonly seed?: number
  readonly slots: readonly CoachRosterSlot[]
}

/**
 * Generates fabricated coaches for a set of roster slots, deterministically
 * from `seed`. Every coach's plate is drawn from its corporation's district
 * codes (`DISTRICT_CODE_BY_CORPORATION`) rather than BMTC's, and every BIN's
 * serial is unique within its hub - two corporations never share a hub in the
 * fixture set (§2.3), so a serial only has to avoid collision inside one hub,
 * not statewide.
 */
export function generateCoachFleet(options: GenerateCoachFleetOptions): readonly FleetVehicle[] {
  const seed = options.seed ?? config.simSeed
  const usedPlates = new Set<string>()
  const serialByHub = new Map<string, number>()
  const vehicles: FleetVehicle[] = []
  for (const slot of options.slots) {
    let serial = serialByHub.get(slot.hub) ?? 101
    const districts = DISTRICT_CODE_BY_CORPORATION[slot.corporation]
    for (let index = 0; index < slot.count; index += 1) {
      const bin = formatBin(slot.hub, serial)
      const plate = generateUniquePlate(seed, bin, usedPlates, districts)
      vehicles.push({
        bin,
        class: 'coach',
        corporation: slot.corporation,
        serviceClass: slot.serviceClassId,
        homeRouteNumber: slot.homeCorridorId,
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
    serialByHub.set(slot.hub, serial)
  }
  return vehicles
}
