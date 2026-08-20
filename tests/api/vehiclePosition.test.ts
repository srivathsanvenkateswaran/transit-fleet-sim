import { describe, expect, it } from 'vitest'
import { vehiclePosition } from '../../src/api/vehiclePosition.js'
import { formatBin } from '../../src/fleet/bin.js'
import { FleetRegistry, type FleetVehicle } from '../../src/fleet/registry.js'
import { FakeWorld, fakeObservation } from '../fakes/fakeWorld.js'

const VEHICLE: FleetVehicle = {
  bin: formatBin('BLR', 412),
  class: 'bus',
  homeRouteNumber: '500-D',
  plates: [
    {
      normalised: 'KA01ZZ1234',
      display: 'KA-01-ZZ-1234',
      since: '2026-02-14',
      until: null,
      reason: 'original_registration',
    },
  ],
}

describe('single vehicle position contract', () => {
  it('uses the same tracking shape and carries bounded uncertain predictions', () => {
    const world = new FakeWorld({
      observations: [fakeObservation(VEHICLE.bin, 'confirmed', 'live')],
      predictions: {
        [VEHICLE.bin]: [
          {
            stop: { id: 'a', name: 'A', nameLocal: null, sequence: 1 },
            seconds: 96,
            uncertaintySeconds: 45,
          },
          {
            stop: { id: 'b', name: 'B', nameLocal: null, sequence: 2 },
            seconds: 341,
            uncertaintySeconds: 75,
          },
        ],
      },
    })
    const result = vehiclePosition(VEHICLE.bin, world, new FleetRegistry([VEHICLE]), 1)
    expect(result).toMatchObject({
      status: 200,
      body: {
        tracking: { state: 'live', fixAgeSeconds: 14 },
        nextStops: [{ id: 'a', eta: { seconds: 96, uncertaintySeconds: 45 } }],
      },
    })
  })

  it('does not apply rider checksum errors to the machine path', () => {
    const result = vehiclePosition('BLR-04128', new FakeWorld(), new FleetRegistry([VEHICLE]), 5)
    expect(result).toMatchObject({ status: 404, body: { error: 'unknown_bin' } })
  })
})
