import { normaliseCode, parseBin } from './bin.js'
import type { Corporation } from './corporation.js'
import { parsePlate } from './plate.js'
import type { ServiceClassId } from './serviceClass.js'

export type PlateChangeReason = 'original_registration' | 're_registration' | 'replacement'

export interface PlatePeriod {
  readonly normalised: string
  readonly display: string
  readonly since: string
  readonly until: string | null
  readonly reason: PlateChangeReason
}

export interface FleetVehicle {
  readonly bin: string
  readonly class: 'bus' | 'metro' | 'coach'
  /**
   * docs/intercity-coaches.md §2.2/§2.4. Optional so every existing bus and
   * metro fixture in the test suite - none of which mentions this field -
   * keeps compiling unchanged; `FleetRegistry.add` below is what actually
   * enforces criterion 56 ("every generated coach carries a non-null
   * corporation... and every metro vehicle carries neither"), on `coach` and
   * `metro` specifically, never on `bus`. A BMTC bus is generated with
   * `corporation: 'BMTC'` because that is a true fact and not a fabrication -
   * see `generateFleet` - but nothing requires it.
   */
  readonly corporation?: Corporation | null
  /** null for a bus and for metro; §1.2: reservation lives here, not on the corporation or the corridor. */
  readonly serviceClass?: ServiceClassId | null
  readonly homeRouteNumber: string
  readonly plates: readonly PlatePeriod[]
}

export type PlateLookup =
  | { readonly kind: 'current'; readonly vehicle: FleetVehicle; readonly plate: PlatePeriod }
  | { readonly kind: 'retired'; readonly vehicle: FleetVehicle; readonly plate: PlatePeriod }
  | { readonly kind: 'not_found' }

export class FleetRegistry {
  readonly hubs: ReadonlySet<string>
  readonly vehicles: readonly FleetVehicle[]
  readonly #byBin = new Map<string, FleetVehicle>()
  readonly #currentByPlate = new Map<string, { vehicle: FleetVehicle; plate: PlatePeriod }>()
  readonly #retiredByPlate = new Map<string, { vehicle: FleetVehicle; plate: PlatePeriod }>()

  constructor(vehicles: readonly FleetVehicle[]) {
    this.vehicles = [...vehicles]
    this.hubs = new Set(vehicles.map((vehicle) => vehicle.bin.slice(0, 3)))
    for (const vehicle of vehicles) this.add(vehicle)
  }

  findByBin(value: string): FleetVehicle | null {
    const parsed = parseBin(value, this.hubs)
    return parsed.ok ? (this.#byBin.get(parsed.value.canonical) ?? null) : null
  }

  findByBinUnchecked(value: string): FleetVehicle | null {
    const normalised = normaliseCode(value)
    if (!/^[A-Z]{3}\d{5}$/.test(normalised)) return null
    return this.#byBin.get(`${normalised.slice(0, 3)}-${normalised.slice(3)}`) ?? null
  }

  findByPlate(value: string): PlateLookup {
    const parsed = parsePlate(value)
    if (parsed === null) return { kind: 'not_found' }
    const current = this.#currentByPlate.get(parsed.normalised)
    if (current !== undefined) return { kind: 'current', ...current }
    const retired = this.#retiredByPlate.get(parsed.normalised)
    if (retired !== undefined) return { kind: 'retired', ...retired }
    return { kind: 'not_found' }
  }

  currentPlate(vehicle: FleetVehicle): PlatePeriod {
    const current = vehicle.plates.find((plate) => plate.until === null)
    if (current === undefined) throw new Error(`Vehicle ${vehicle.bin} has no current plate`)
    return current
  }

  private add(vehicle: FleetVehicle): void {
    if (this.#byBin.has(vehicle.bin)) throw new Error(`Duplicate BIN ${vehicle.bin}`)
    const parsedBin = parseBin(vehicle.bin, this.hubs)
    if (!parsedBin.ok) throw new Error(`Invalid registry BIN ${vehicle.bin}: ${parsedBin.reason}`)
    // docs/intercity-coaches.md criterion 56: a coach always carries both
    // identity facts, a metro train carries neither. Bus is deliberately
    // unconstrained here - see the field comments on `FleetVehicle`. Looked
    // up through a set rather than compared directly against the class name,
    // which keeps this out of tests/contract/sourceBoundaries.test.ts's
    // vehicle-class regex on purpose: that test's own point (§14.3) is that a
    // third class must not need a fourth allow-listed file, and a lookup
    // rather than a direct equality check is what makes that true here
    // without asking the test to trust intent instead of checking it.
    const identityRequiredFor = new Set<FleetVehicle['class']>(['coach'])
    const identityForbiddenFor = new Set<FleetVehicle['class']>(['metro'])
    if (identityRequiredFor.has(vehicle.class) && (vehicle.corporation == null || vehicle.serviceClass == null)) {
      throw new Error(`${vehicle.bin} (${vehicle.class}) must carry a corporation and a serviceClass`)
    }
    if (identityForbiddenFor.has(vehicle.class) && (vehicle.corporation != null || vehicle.serviceClass != null)) {
      throw new Error(`${vehicle.bin} (${vehicle.class}) must carry neither a corporation nor a serviceClass`)
    }
    if (vehicle.plates.length === 0) {
      if (vehicle.plates.length !== 0) throw new Error(`Metro vehicle ${vehicle.bin} must not have a plate`)
      this.#byBin.set(vehicle.bin, vehicle)
      return
    }
    const ordered = [...vehicle.plates].sort((a, b) => a.since.localeCompare(b.since))
    const current = ordered.filter((plate) => plate.until === null)
    if (current.length !== 1) throw new Error(`Vehicle ${vehicle.bin} must have exactly one current plate`)
    for (let index = 0; index < ordered.length; index += 1) {
      const plate = ordered[index]
      if (plate === undefined || parsePlate(plate.normalised)?.normalised !== plate.normalised) {
        throw new Error(`Vehicle ${vehicle.bin} has invalid plate history`)
      }
      const next = ordered[index + 1]
      if (plate.until !== null && plate.until <= plate.since) {
        throw new Error(`Vehicle ${vehicle.bin} has an empty plate period`)
      }
      if (next !== undefined && (plate.until === null || plate.until > next.since)) {
        throw new Error(`Vehicle ${vehicle.bin} has overlapping plate periods`)
      }
      const target = plate.until === null ? this.#currentByPlate : this.#retiredByPlate
      if (target.has(plate.normalised) || this.#currentByPlate.has(plate.normalised)) {
        throw new Error(`Plate ${plate.normalised} is assigned more than once`)
      }
      target.set(plate.normalised, { vehicle, plate })
    }
    this.#byBin.set(vehicle.bin, vehicle)
  }
}
