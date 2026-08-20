import { describe, expect, it } from 'vitest'
import { formatBin } from '../../src/fleet/bin.js'
import { FleetRegistry, type FleetVehicle } from '../../src/fleet/registry.js'

const VEHICLE: FleetVehicle = {
  bin: 'BLR-04126',
  class: 'bus',
  homeRouteNumber: '500-D',
  plates: [
    {
      normalised: 'KA01ZZ9902',
      display: 'KA-01-ZZ-9902',
      since: '2023-06-01',
      until: '2026-02-14',
      reason: 'original_registration',
    },
    {
      normalised: 'KA01ZZ1234',
      display: 'KA-01-ZZ-1234',
      since: '2026-02-14',
      until: null,
      reason: 're_registration',
    },
  ],
}

describe('fleet registry', () => {
  it('resolves current and retired plates without erasing history', () => {
    const registry = new FleetRegistry([VEHICLE])
    expect(registry.findByBin('blr04126')?.bin).toBe('BLR-04126')
    expect(registry.findByPlate('KA01ZZ1234').kind).toBe('current')
    const retired = registry.findByPlate('KA01ZZ9902')
    expect(retired.kind).toBe('retired')
    if (retired.kind === 'retired') expect(retired.plate.until).toBe('2026-02-14')
  })

  it('rejects missing current periods, overlaps and duplicate current plates', () => {
    expect(
      () =>
        new FleetRegistry([
          { ...VEHICLE, plates: VEHICLE.plates.map((plate) => ({ ...plate, until: '2026-03-01' })) },
        ]),
    ).toThrow('exactly one current plate')
    expect(
      () =>
        new FleetRegistry([
          {
            ...VEHICLE,
            plates: [
              { ...VEHICLE.plates[0]!, until: '2026-03-01' },
              VEHICLE.plates[1]!,
            ],
          },
        ]),
    ).toThrow('overlapping plate periods')
    expect(
      () =>
        new FleetRegistry([
          VEHICLE,
          { ...VEHICLE, bin: formatBin('BLR', 413), homeRouteNumber: 'G-4' },
        ]),
    ).toThrow('assigned more than once')
  })
})
