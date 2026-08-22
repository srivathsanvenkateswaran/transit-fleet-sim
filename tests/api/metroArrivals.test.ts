import { describe, expect, it } from 'vitest'
import { metroArrivals } from '../../src/api/metroArrivals.js'

describe('metro arrivals contract', () => {
  it('returns station-specific arrivals', () => {
    const at = new Date('2026-08-20T09:41:26.000Z')
    const first = metroArrivals('MTR-PPL-018', null, 'purple', '3', at)
    const second = metroArrivals('MTR-PPL-037', null, 'purple', '3', at)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(JSON.stringify(first.body)).not.toBe(JSON.stringify(second.body))
  })

  it('returns a distinct closed answer outside service hours', () => {
    const result = metroArrivals('MTR-PPL-018', null, 'purple', '3', new Date('2026-08-20T18:00:00.000Z'))
    expect(result.status).toBe(200)
    expect((result.body as { error: string }).error).toBe('metro_service_closed')
  })
})
