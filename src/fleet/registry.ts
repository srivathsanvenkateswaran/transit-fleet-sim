import { normaliseCode, parseBin } from './bin.js'
import { parsePlate } from './plate.js'

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
  readonly class: 'bus' | 'metro'
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
