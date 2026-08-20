import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveVehicle } from '../src/api/resolve.js'
import { formatBin } from '../src/fleet/bin.js'
import { FleetRegistry, type FleetVehicle } from '../src/fleet/registry.js'
import type { DutyStatus, TrackingState } from '../src/world/port.js'
import { FakeWorld, fakeObservation } from '../tests/fakes/fakeWorld.js'

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
const duties: DutyStatus[] = ['confirmed', 'inferred', 'unknown', 'out_of_service']
const trackingStates: TrackingState[] = ['live', 'stale', 'dark', 'untracked']
const outputDirectory = resolve('tests/api/goldens')
await mkdir(outputDirectory, { recursive: true })

for (const duty of duties) {
  for (const tracking of trackingStates) {
    const world = new FakeWorld({ observations: [fakeObservation(vehicle.bin, duty, tracking)] })
    const result = resolveVehicle(
      { code: vehicle.bin, entry: 'manual', at: null },
      world,
      registry,
    )
    if (result.status !== 200) throw new Error(`Could not generate ${duty}-${tracking}`)
    const filename = `${duty}__${tracking}.json`
    await writeFile(resolve(outputDirectory, filename), `${JSON.stringify(result.body, null, 2)}\n`, 'utf8')
  }
}
