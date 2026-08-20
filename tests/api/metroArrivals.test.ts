import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { metroArrivals } from '../../src/api/metroArrivals.js'

describe('metro arrivals contract', () => {
  it('returns honest station-pair arrivals with an uncertainty band', () => {
    const result = metroArrivals('MTR-PPL-018', 'MTR-PPL-037', 'purple', '3', new Date('2026-08-20T09:41:26.000Z'))
    expect(result.status).toBe(200)
    const body = result.body as { arrivals: Array<{ eta: { uncertaintySeconds: number }; vehicle: { displayToRider: boolean } }> }
    expect(body.arrivals).toHaveLength(3)
    expect(body.arrivals.every((arrival) => arrival.eta.uncertaintySeconds >= config.metroPredictionUncertaintyBaseSeconds)).toBe(true)
    expect(body.arrivals.every((arrival) => arrival.vehicle.displayToRider === false)).toBe(true)
  })
})
