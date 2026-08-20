import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { resolveVehicle } from '../../src/api/resolve.js'
import { formatBin } from '../../src/fleet/bin.js'
import { FleetRegistry, type FleetVehicle } from '../../src/fleet/registry.js'
import { FakeWorld, fakeObservation } from '../fakes/fakeWorld.js'

const vehicle: FleetVehicle = {
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
const registry = new FleetRegistry([vehicle])

describe('full resolve body goldens', () => {
  it.each([
    ['confirmed', 'live'],
    ['confirmed', 'stale'],
    ['confirmed', 'dark'],
    ['confirmed', 'untracked'],
    ['inferred', 'live'],
    ['inferred', 'stale'],
    ['inferred', 'dark'],
    ['inferred', 'untracked'],
    ['unknown', 'live'],
    ['unknown', 'stale'],
    ['unknown', 'dark'],
    ['unknown', 'untracked'],
    ['out_of_service', 'live'],
    ['out_of_service', 'stale'],
    ['out_of_service', 'dark'],
    ['out_of_service', 'untracked'],
  ] as const)('%s + %s matches its reviewed body', async (duty, tracking) => {
    const world = new FakeWorld({ observations: [fakeObservation(vehicle.bin, duty, tracking)] })
    const result = resolveVehicle(
      { code: vehicle.bin, entry: 'manual', at: null },
      world,
      registry,
    )
    const golden = JSON.parse(
      await readFile(new URL(`./goldens/${duty}__${tracking}.json`, import.meta.url), 'utf8'),
    ) as unknown
    expect(result.body).toEqual(golden)
  })
})
