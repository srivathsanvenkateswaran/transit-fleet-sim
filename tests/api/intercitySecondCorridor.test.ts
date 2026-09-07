import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../../src/api/server.js'
import { FleetRegistry, type FleetVehicle } from '../../src/fleet/registry.js'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import type { CoachSimulation } from '../../src/sim/coachWorld.js'
import { coachHarness, coachWorldPort } from '../fakes/coachWorld.js'

/**
 * scripts/build-corridors.ts and scripts/build-corridor-roster.ts add seven
 * corridors beyond BNG-HSP, generated from Tatak's own corridor dataset
 * (see scripts/lib/newCorridors.ts). This proves two of them end to end
 * over real HTTP, the same way tests/api/intercityApi.test.ts proves
 * BNG-HSP: a real, non-null service number Tatak names comes back from
 * `/fleet/duty` with an assigned vehicle and live tracking.
 */

const NOW = new Date('2026-09-06T02:14:00+05:30')

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>
}

const FULL_COVERAGE = {
  ...defaultCoachProfiles.device,
  coverageShareReserved: 1,
  coverageShareOrdinary: 1,
}

describe('a second and third corridor, generated from Tatak (§7.4)', () => {
  let server: Server
  let baseUrl: string
  let simulation: CoachSimulation

  beforeEach(async () => {
    const harness = await coachHarness(NOW, { device: FULL_COVERAGE }, ['BNG-HSP', 'BNG-MNG'])
    simulation = harness.simulation
    const registry = new FleetRegistry(harness.coaches as readonly FleetVehicle[])
    server = createApiServer(coachWorldPort(simulation, NOW), registry, { intercity: simulation })
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    baseUrl = `http://${host}:${address.port}`
  })

  afterEach(async () => {
    server.close()
    await once(server, 'close')
  })

  it('BNG-MNG: the reserved Rajahamsa Executive working 2235BNGMNG is assigned a coach and tracked live', async () => {
    // Departs 22:35 on the 5th; NOW is 02:14 on the 6th, so the duty is
    // en route rather than long finished, the same way pallakkiDuty's
    // 22:59 BNG-HSP departure is checked elsewhere in this suite.
    const response = await fetch(`${baseUrl}/fleet/duty?service=2235BNGMNG&date=2026-09-05`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.duty.corridor.id).toBe('BNG-MNG')
    expect(body.duty.service.id).toBe('2235BNGMNG')
    expect(body.assignment.status).toBe('assigned')
    expect(body.vehicle.bin).toEqual(expect.any(String))
    expect(body.vehicle.serviceClass.id).toBe('rajahamsa_executive')
    expect(body.tracking).not.toBeNull()
  })

  it('BNG-HSP keeps working when rostered alongside the new corridors', async () => {
    const response = await fetch(`${baseUrl}/fleet/duty?service=2259BNGHMP&date=2026-09-05`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.duty.corridor.id).toBe('BNG-HSP')
    expect(body.assignment.status).toBe('assigned')
  })
})

describe('BNG-MYS: a short corridor, checked at a NOW inside its own short run', () => {
  // BNG-MYS's longest run is under three hours, so BNG-HSP/BNG-MNG's
  // overnight NOW above would find every BNG-MYS duty long finished. A
  // fresh, later NOW on the same service date as the departure keeps the
  // duty genuinely in progress.
  const MYS_NOW = new Date('2026-09-06T08:00:00+05:30')
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    const harness = await coachHarness(MYS_NOW, { device: FULL_COVERAGE }, ['BNG-MYS'])
    const registry = new FleetRegistry(harness.coaches as readonly FleetVehicle[])
    server = createApiServer(coachWorldPort(harness.simulation, MYS_NOW), registry, { intercity: harness.simulation })
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    baseUrl = `http://${host}:${address.port}`
  })

  afterEach(async () => {
    server.close()
    await once(server, 'close')
  })

  it('the unreserved Karnataka Sarige working 0646BNGMYS is assigned a coach and tracked live', async () => {
    const response = await fetch(`${baseUrl}/fleet/duty?service=0646BNGMYS&date=2026-09-06`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.duty.corridor.id).toBe('BNG-MYS')
    expect(body.duty.service.id).toBe('0646BNGMYS')
    expect(body.assignment.status).toBe('assigned')
    expect(body.vehicle.bin).toEqual(expect.any(String))
    expect(body.vehicle.serviceClass.id).toBe('karnataka_sarige')
    expect(body.tracking).not.toBeNull()
  })
})
