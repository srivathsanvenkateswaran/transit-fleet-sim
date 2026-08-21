import { describe, expect, it } from 'vitest'
import { metroArrivals } from '../../src/api/metroArrivals.js'

describe('metro arrivals contract', () => {
  it('refuses to invent arrivals before metro trains exist', () => {
    const result = metroArrivals('MTR-PPL-018', 'MTR-PPL-037', 'purple', '3', new Date('2026-08-20T09:41:26.000Z'))
    expect(result.status).toBe(503)
    const body = result.body as { error: string; message: string; station: { id: string }; eta?: unknown; platform?: unknown }
    expect(body.error).toBe('metro_not_simulated')
    expect(body.message).toMatch(/not simulated/i)
    expect(body.station.id).toBe('MTR-PPL-018')
    expect(body.eta).toBeUndefined()
    expect(body.platform).toBeUndefined()
  })
})
