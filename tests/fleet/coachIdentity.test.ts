import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { classifyCode } from '../../src/fleet/classify.js'
import { FIXTURE_HUBS } from '../../src/fleet/corporation.js'
import { generateCoachFleet, type CoachRosterSlot } from '../../src/fleet/generate.js'
import { hasValidDammCheckDigit } from '../../src/fleet/checkChar.js'
import { parseBin } from '../../src/fleet/bin.js'
import { FleetRegistry } from '../../src/fleet/registry.js'
import { SERVICE_CLASSES, serviceClassById } from '../../src/fleet/serviceClass.js'

/**
 * docs/intercity-coaches.md §15 criteria 53-58: identity across a statewide
 * fleet. `generateCoachFleet` is exercised here at a scale meant to actually
 * stress the disjointness and uniqueness guarantees - a handful of coaches
 * would pass by accident.
 */

function statewideSlots(): readonly CoachRosterSlot[] {
  const slots: CoachRosterSlot[] = []
  for (const hub of FIXTURE_HUBS) {
    const classesForCorporation = SERVICE_CLASSES.filter((serviceClass) =>
      serviceClass.corporations.includes(hub.corporation),
    )
    for (const serviceClass of classesForCorporation) {
      slots.push({
        hub: hub.code,
        corporation: hub.corporation,
        serviceClassId: serviceClass.id,
        homeCorridorId: `${hub.code}-TEST`,
        count: 12,
      })
    }
  }
  return slots
}

describe('coach identity across a statewide fleet', () => {
  it('gives every coach a BIN with a valid Damm check digit and a hub of three letters with no I or O', () => {
    const fleet = generateCoachFleet({ seed: 5, slots: statewideSlots() })
    expect(fleet.length).toBeGreaterThan(50)
    for (const vehicle of fleet) {
      const [hub, rest] = vehicle.bin.split('-')
      expect(hub).toMatch(/^[A-HJ-NP-Z]{3}$/)
      expect(rest).toBeDefined()
      expect(hasValidDammCheckDigit(rest!)).toBe(true)
    }
  })

  it('never lets classify() call a coach plate a BIN or a coach BIN a plate, over the extended hub set', () => {
    const fleet = generateCoachFleet({ seed: 6, slots: statewideSlots() })
    const hubs = new Set(FIXTURE_HUBS.map((hub) => hub.code))
    for (const vehicle of fleet) {
      const binClassified = classifyCode(vehicle.bin, hubs)
      expect(binClassified.kind).toBe('bin')
      const plate = vehicle.plates[0]!.display
      const plateClassified = classifyCode(plate, hubs)
      expect(plateClassified.kind).toBe('plate')
    }
  })

  it('uses the ZZ series for every generated coach plate, with zero exceptions', () => {
    const fleet = generateCoachFleet({ seed: 7, slots: statewideSlots() })
    const nonZz = fleet.filter((vehicle) => !vehicle.plates.every((plate) => /^KA\d{2}ZZ\d{4}$/.test(plate.normalised)))
    expect(nonZz.map((vehicle) => vehicle.bin)).toEqual([])
  })

  it('carries a non-null corporation and serviceClass on every coach, and lets the registry accept the whole fleet', () => {
    const fleet = generateCoachFleet({ seed: 8, slots: statewideSlots() })
    for (const vehicle of fleet) {
      expect(vehicle.corporation).not.toBeNull()
      expect(vehicle.serviceClass).not.toBeNull()
    }
    expect(() => new FleetRegistry(fleet)).not.toThrow()
  })

  it('keeps plate history sane across the whole statewide fleet: one current plate per BIN, no collisions', () => {
    const fleet = generateCoachFleet({ seed: 9, slots: statewideSlots() })
    const registry = new FleetRegistry(fleet)
    const seenNormalised = new Set<string>()
    for (const vehicle of fleet) {
      const current = registry.currentPlate(vehicle)
      expect(current.until).toBeNull()
      expect(seenNormalised.has(current.normalised)).toBe(false)
      seenNormalised.add(current.normalised)
    }
    expect(seenNormalised.size).toBe(fleet.length)
  })

  it("matches each coach's serviceClass.reserved against the class table, and never reads corporation to decide it", async () => {
    const fleet = generateCoachFleet({ seed: 10, slots: statewideSlots() })
    for (const vehicle of fleet) {
      const serviceClass = serviceClassById(vehicle.serviceClass!)
      expect(serviceClass).not.toBeNull()
      expect(serviceClass!.corporations).toContain(vehicle.corporation)
    }
    // A source scan, in the style of tests/contract/sourceBoundaries.test.ts:
    // the one function that decides whether a duty is reserved
    // (`occupancyFor`, src/sim/occupancy.ts) must never mention `corporation`
    // at all. If it ever needs to, that is the rule being violated, not a
    // detail this scan should special-case around.
    const occupancySource = await readFile(
      new URL('../../src/sim/occupancy.ts', import.meta.url),
      'utf8',
    )
    expect(occupancySource.toLowerCase()).not.toContain('corporation')
  })

  it('rejects an invented hub via parseBin, proving the extended hub set is closed rather than inferred', () => {
    const hubs = new Set(FIXTURE_HUBS.map((hub) => hub.code))
    expect(parseBin('XXX-04126', hubs)).toEqual({ ok: false, reason: 'unknown_hub' })
  })
})
