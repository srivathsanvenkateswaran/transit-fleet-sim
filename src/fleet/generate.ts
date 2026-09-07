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
  /**
   * Per-route vehicle counts, from `computeRouteRosterSizes` - the real-schedule
   * fleet sizing that replaced one flat `BUSES_PER_ROUTE` for every route
   * (September 2026 coverage expansion). A route present in this map uses its
   * own count; a route absent from it (or the map itself being absent, which
   * is every existing caller of this function) falls back to the flat
   * `busesPerRoute`, so nothing here changes byte-for-byte fleet generation
   * for a caller that never passes it.
   */
  readonly busesPerRouteByRoute?: ReadonlyMap<string, number>
  readonly hub?: string
  /**
   * Plate numbers already spoken for, shared with whatever else is drawing
   * from the same `ZZ` series this call instant - see this option's twin on
   * `GenerateCoachFleetOptions` for why a caller building a combined fleet
   * needs to pass one `Set` to both calls. Defaults to a fresh, empty `Set`,
   * so every existing caller (every test, and any caller generating buses in
   * isolation) is unaffected: this function has never in its life produced
   * two identical plates internally, and still does not.
   */
  readonly usedPlates?: Set<string>
}

export function generateFleet(options: GenerateFleetOptions = {}): readonly FleetVehicle[] {
  const seed = options.seed ?? config.simSeed
  const routes = options.routes ?? config.busRoutes
  const busesPerRoute = options.busesPerRoute ?? config.busesPerRoute
  const hub = options.hub ?? config.busHubCode
  const usedPlates = options.usedPlates ?? new Set<string>()
  const vehicles: FleetVehicle[] = []
  let serial = 412
  for (const route of routes) {
    const count = options.busesPerRouteByRoute?.get(route) ?? busesPerRoute
    for (let index = 0; index < count; index += 1) {
      const bin = formatBin(hub, serial)
      const plate = generateUniquePlate(seed, bin, usedPlates, 'BMTC')
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

/**
 * Which serial numbers, within one district's `KA<district>ZZ####` range, a
 * given corporation is allowed to draw from.
 *
 * `DISTRICT_CODE_BY_CORPORATION` gives BMTC and KSRTC the same `01` district
 * - both corporations plausibly Bengaluru-registered, and corporation.ts's
 * own doc comment already marks the whole table an editorial choice rather
 * than a verified RTO fact - so sharing the `01` pool between them is
 * intentional. What is not acceptable is two *independent* fleet
 * generations drawing the same normalised plate from that shared pool by
 * chance: `generateFleet` (buses) and `generateCoachFleet` (coaches) each
 * kept their own `usedPlates` `Set` until this function existed, which is
 * exactly what let `KA01ZZ9776` go to both a bus and a coach the first time
 * this project's own fleet grew past a few hundred district-`01` vehicles -
 * and passing one shared `Set` between the two calls, which `src/index.ts`
 * does, only protects a caller that remembers to. `ondc-transit-bpp`'s own
 * boot harness (`tests/reserved/fleetSimBoot.mts`) calls both functions with
 * no shared `Set` at all, and is a legitimate caller to keep supporting: nothing
 * about generating a fleet requires a caller to coordinate two separate
 * function calls by hand.
 *
 * The fix is to make the two draws structurally incapable of landing on the
 * same serial, computed from the same `DISTRICT_CODE_BY_CORPORATION` table
 * every draw already reads, rather than from anything a caller has to
 * remember to pass in. Every corporation whose district list names this
 * district gets an equal, disjoint slice of `1..9999`, ordered by
 * corporation code - so the partition needs no separate table to stay in
 * sync with `DISTRICT_CODE_BY_CORPORATION`, which is where a corporation
 * gaining or losing a shared district would show up first anyway. A
 * district used by only one corporation - every BMTC district except `01`,
 * and both NWKRTC's and KKRTC's - keeps the whole range, exactly as before
 * this fix: `districtSerialRange('25', 'NWKRTC')` is `{ min: 1, max: 9999 }`
 * because NWKRTC is the only entry in `sharing`.
 */
function districtSerialRange(
  district: string,
  corporation: Corporation,
): { readonly min: number; readonly max: number } {
  const sharing = (Object.keys(DISTRICT_CODE_BY_CORPORATION) as Corporation[])
    .filter((candidate) => DISTRICT_CODE_BY_CORPORATION[candidate].includes(district))
    .sort()
  const index = Math.max(0, sharing.indexOf(corporation))
  const share = Math.floor(9_999 / sharing.length)
  const min = index * share + 1
  const max = index === sharing.length - 1 ? 9_999 : (index + 1) * share
  return { min, max }
}

function generateUniquePlate(
  seed: number,
  bin: string,
  used: Set<string>,
  corporation: Corporation,
): Pick<PlatePeriod, 'normalised' | 'display'> {
  const districts = DISTRICT_CODE_BY_CORPORATION[corporation]
  const district = districts[randInt(seed, bin, 'plate_district', 0, 0, districts.length)] ?? districts[0]!
  const { min, max } = districtSerialRange(district, corporation)
  let serial = randInt(seed, bin, 'plate_serial', 0, min, max + 1)
  let normalised = `KA${district}ZZ${String(serial).padStart(4, '0')}`
  // Bounded by the sub-range's own size, not by the full 9,999-plate
  // district: exhaustion and duplication are different failures (a
  // duplicate plate is impossible across corporations by construction now,
  // so a collision here can only be *within* one corporation's own draws,
  // which `used` already catches), and this loop must not spin forever
  // hunting a free serial that provably does not exist once every serial in
  // `[min, max]` is taken.
  for (let attempts = 0; used.has(normalised); attempts += 1) {
    if (attempts >= max - min + 1) {
      throw new Error(
        `Plate pool exhausted: ${corporation} has drawn all ${max - min + 1} plates available to it in ` +
          `district ${district} (KA${district}ZZ${String(min).padStart(4, '0')}-${String(max).padStart(4, '0')})`,
      )
    }
    serial = serial >= max ? min : serial + 1
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
  /** See `GenerateFleetOptions.usedPlates` - same option, same reason. */
  readonly usedPlates?: Set<string>
}

/**
 * Generates fabricated coaches for a set of roster slots, deterministically
 * from `seed`. Every coach's plate is drawn from its corporation's district
 * codes (`DISTRICT_CODE_BY_CORPORATION`) rather than BMTC's, and every BIN's
 * serial is unique within its hub - two corporations never share a hub in the
 * fixture set (§2.3), so a serial only has to avoid collision inside one hub,
 * not statewide.
 *
 * A plate, however, is not scoped to a hub, and `DISTRICT_CODE_BY_CORPORATION`
 * gives KSRTC the same `01` district BMTC uses - the two share a `ZZ` plate
 * pool by design (§2.4: "cannot collide with a real vehicle" is the guarantee
 * the `ZZ` series carries, not statewide uniqueness between corporations).
 * `FleetRegistry` rejects two vehicles sharing a normalised plate outright, so
 * the two corporations cannot both draw from the *same serials* of that
 * shared pool - see `districtSerialRange`, the fix for that, which needs no
 * cooperation from this function's caller. `usedPlates` (optional, see its
 * doc on `GenerateCoachFleetOptions`) is what remains to actually pass
 * between a `generateFleet` call and a `generateCoachFleet` call sharing one
 * fleet: it catches a genuine same-corporation collision, which
 * `districtSerialRange` does not attempt to and never needs to, since a
 * single corporation's own draws were always collision-checked locally.
 */
export function generateCoachFleet(options: GenerateCoachFleetOptions): readonly FleetVehicle[] {
  const seed = options.seed ?? config.simSeed
  const usedPlates = options.usedPlates ?? new Set<string>()
  const serialByHub = new Map<string, number>()
  const vehicles: FleetVehicle[] = []
  for (const slot of options.slots) {
    let serial = serialByHub.get(slot.hub) ?? 101
    for (let index = 0; index < slot.count; index += 1) {
      const bin = formatBin(slot.hub, serial)
      const plate = generateUniquePlate(seed, bin, usedPlates, slot.corporation)
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
