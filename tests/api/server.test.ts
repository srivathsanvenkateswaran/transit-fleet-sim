import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../../src/api/server.js'
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

describe('HTTP server', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    const world = new FakeWorld({ observations: [fakeObservation(VEHICLE.bin, 'confirmed', 'live')] })
    server = createApiServer(world, new FleetRegistry([VEHICLE]))
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test server has no TCP address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    baseUrl = `http://${host}:${address.port}`
  })

  afterEach(async () => {
    server.close()
    await once(server, 'close')
  })

  it('serves resolve, position, liveness and readiness with honesty headers', async () => {
    for (const path of [
      `/fleet/resolve?code=${VEHICLE.bin}`,
      `/fleet/vehicle/${VEHICLE.bin}/position`,
      '/healthz',
      '/readyz',
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { 'x-request-id': 'contract-test' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-simulated')).toBe('true')
      expect(response.headers.get('x-request-id')).toBe('contract-test')
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    }
  })

  it('marks live JSON as no-store and computes fix age from the two timestamps', async () => {
    const response = await fetch(`${baseUrl}/fleet/resolve?code=${VEHICLE.bin}`)
    const body = (await response.json()) as {
      tracking: { fixAgeSeconds: number; observedAt: string; servedAt: string }
    }
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.tracking.fixAgeSeconds).toBe(
      (new Date(body.tracking.servedAt).getTime() - new Date(body.tracking.observedAt).getTime()) / 1000,
    )
  })

  it('returns honest headers on every error and does not expose cut routes', async () => {
    for (const path of [
      '/fleet/resolve?code=bad',
      '/fleet/metro/arrivals',
      '/fleet/routes',
      '/admin/scenario',
    ]) {
      const response = await fetch(`${baseUrl}${path}`)
      expect([400, 404]).toContain(response.status)
      expect(response.headers.get('x-simulated')).toBe('true')
      expect((await response.json()) as object).toHaveProperty('error')
    }
  })

  it('returns a client error for malformed vehicle path encoding', async () => {
    const response = await fetch(`${baseUrl}/fleet/vehicle/%E0%A4%A/position`)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'malformed_code' })
  })
})
